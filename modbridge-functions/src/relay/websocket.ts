import { upgradeWebSocket } from '@neon/functions'
import type { ClientRequestArgs } from 'node:http'
import type { LookupFunction } from 'node:net'
import type { ConnectionOptions } from 'node:tls'
import WebSocketClient, { type RawData } from 'ws'

import { createErrorResponse } from '../shared/errors.js'
import { sanitizeRequestHeaders } from '../shared/headers.js'
import type { RouteTarget } from '../shared/types.js'
import { stripRelayQueryAuth } from './auth.js'
import { isAllowedNodeHost } from './routing.js'
import { resolvePublicHost } from './server-status.js'

const MAX_FRAME_BYTES = 4 * 1024 * 1024
const MAX_BUFFER_BYTES = 8 * 1024 * 1024
const MAX_PENDING_FRAMES = 128
const HANDSHAKE_TIMEOUT_MS = 10_000

type SocketFrame = string | Uint8Array<ArrayBuffer>

function resolveWebSocketHost(request: Request, hostname: string) {
	return new Promise<Awaited<ReturnType<typeof resolvePublicHost>>>((resolve, reject) => {
		const timeout = setTimeout(
			() => finish(new Error('WebSocket DNS lookup timed out')),
			HANDSHAKE_TIMEOUT_MS,
		)
		const onAbort = () => finish(new Error('WebSocket request cancelled'))
		const finish = (error?: Error, addresses?: Awaited<ReturnType<typeof resolvePublicHost>>) => {
			clearTimeout(timeout)
			request.signal.removeEventListener('abort', onAbort)
			if (error) reject(error)
			else resolve(addresses!)
		}
		request.signal.addEventListener('abort', onAbort, { once: true })
		if (request.signal.aborted) {
			onAbort()
			return
		}
		resolvePublicHost(hostname).then(
			(addresses) => finish(undefined, addresses),
			(error: Error) => finish(error),
		)
	})
}

export function isWebSocketRoute(target: RouteTarget, subpath: string): boolean {
	if (target.upstreamHost === 'api.modrinth.com') {
		return ['/_internal/launcher_socket', '/v3/events_internal/launcher_socket'].includes(subpath)
	}
	return isAllowedNodeHost(target.upstreamHost) && subpath.startsWith('/')
}

function frameBytes(frame: SocketFrame): number {
	return typeof frame === 'string' ? Buffer.byteLength(frame) : frame.byteLength
}

function upstreamFrame(data: RawData, binary: boolean): SocketFrame {
	const buffer = Buffer.isBuffer(data)
		? data
		: Array.isArray(data)
			? Buffer.concat(data)
			: Buffer.from(data)
	return binary ? Uint8Array.from(buffer) : buffer.toString('utf8')
}

function closeCode(code: number): number {
	return (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
		(code >= 3000 && code <= 4999)
		? code
		: 1011
}

function closeReason(reason: string): string {
	let result = ''
	for (const point of reason) {
		if (Buffer.byteLength(result + point) > 123) break
		result += point
	}
	return result
}

export function bridgeWebSockets(
	downstream: WebSocket,
	upstream: WebSocketClient,
	initialFrames: SocketFrame[] = [],
): () => void {
	downstream.binaryType = 'arraybuffer'
	const pending = [...initialFrames]
	let pendingBytes = pending.reduce((total, frame) => total + frameBytes(frame), 0)
	let finished = false
	let openTimeout: ReturnType<typeof setTimeout> | undefined
	let heartbeat: ReturnType<typeof setInterval> | undefined

	const finish = (code: number, reason: string) => {
		if (finished) return
		finished = true
		clearTimeout(openTimeout)
		clearInterval(heartbeat)
		pending.length = 0
		pendingBytes = 0
		downstream.removeEventListener('open', onDownstreamOpen)
		downstream.removeEventListener('message', onDownstreamMessage)
		downstream.removeEventListener('close', onDownstreamClose)
		downstream.removeEventListener('error', onError)
		upstream.off('message', onUpstreamMessage)
		upstream.off('close', onUpstreamClose)
		upstream.off('error', onError)
		const safeCode = closeCode(code)
		const safeReason = closeReason(reason)
		if (downstream.readyState < WebSocketClient.CLOSING) {
			try {
				downstream.close(safeCode, safeReason)
			} catch {
				downstream.close()
			}
		}
		if (upstream.readyState === WebSocketClient.OPEN) {
			upstream.close(safeCode, safeReason)
			setTimeout(() => {
				if (upstream.readyState !== WebSocketClient.CLOSED) upstream.terminate()
			}, 1000).unref()
		} else if (upstream.readyState === WebSocketClient.CONNECTING) {
			upstream.terminate()
		}
	}

	const sendDownstream = (frame: SocketFrame) => {
		const length = frameBytes(frame)
		if (length > MAX_FRAME_BYTES || downstream.bufferedAmount + length > MAX_BUFFER_BYTES) {
			finish(1009, 'Relay message limit exceeded')
			return
		}
		try {
			downstream.send(frame)
		} catch {
			finish(1011, 'Relay forwarding failed')
		}
	}

	const onDownstreamOpen = () => {
		clearTimeout(openTimeout)
		while (pending.length && !finished) {
			const frame = pending.shift()!
			pendingBytes -= frameBytes(frame)
			sendDownstream(frame)
		}
	}
	const onUpstreamMessage = (data: RawData, binary: boolean) => {
		if (finished) return
		const frame = upstreamFrame(data, binary)
		if (downstream.readyState === WebSocketClient.OPEN) {
			sendDownstream(frame)
		} else if (downstream.readyState === WebSocketClient.CONNECTING) {
			pendingBytes += frameBytes(frame)
			if (
				frameBytes(frame) > MAX_FRAME_BYTES ||
				pendingBytes > MAX_BUFFER_BYTES ||
				pending.length >= MAX_PENDING_FRAMES
			) {
				finish(1009, 'Relay message limit exceeded')
				return
			}
			pending.push(frame)
		}
	}
	const onDownstreamMessage = (event: MessageEvent) => {
		if (finished) return
		const data: unknown = event.data
		let frame: SocketFrame
		if (typeof data === 'string') frame = data
		else if (data instanceof ArrayBuffer) frame = new Uint8Array(data)
		else if (ArrayBuffer.isView(data)) {
			frame = Uint8Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
		} else {
			finish(1003, 'Unsupported WebSocket message')
			return
		}
		const length = frameBytes(frame)
		if (length > MAX_FRAME_BYTES || upstream.bufferedAmount + length > MAX_BUFFER_BYTES) {
			finish(1009, 'Relay message limit exceeded')
			return
		}
		if (upstream.readyState !== WebSocketClient.OPEN) {
			finish(1011, 'Upstream WebSocket disconnected')
			return
		}
		try {
			upstream.send(frame, { binary: typeof frame !== 'string' }, (error) => {
				if (error) finish(1011, 'Relay forwarding failed')
			})
		} catch {
			finish(1011, 'Relay forwarding failed')
		}
	}
	const onDownstreamClose = (event: CloseEvent) => finish(event.code, event.reason)
	const onUpstreamClose = (code: number, reason: Buffer) => finish(code, reason.toString('utf8'))
	const onError = () => finish(1011, 'WebSocket connection failed')

	downstream.addEventListener('open', onDownstreamOpen)
	downstream.addEventListener('message', onDownstreamMessage)
	downstream.addEventListener('close', onDownstreamClose)
	downstream.addEventListener('error', onError)
	upstream.on('message', onUpstreamMessage)
	upstream.on('close', onUpstreamClose)
	upstream.on('error', onError)
	upstream.on('error', () => {})
	if (downstream.readyState === WebSocketClient.OPEN) onDownstreamOpen()
	else {
		openTimeout = setTimeout(() => finish(1011, 'Relay handshake timed out'), HANDSHAKE_TIMEOUT_MS)
		openTimeout.unref()
	}
	if (!finished) {
		heartbeat = setInterval(() => {
			if (upstream.readyState === WebSocketClient.OPEN) {
				upstream.ping(undefined, undefined, (error) => {
					if (error) onError()
				})
			}
		}, 30_000)
		heartbeat.unref()
	}
	return () => finish(1000, 'Relay disconnected')
}

export async function proxyWebSocket(
	request: Request,
	target: RouteTarget,
	subpath: string,
): Promise<Response> {
	if (!isWebSocketRoute(target, subpath)) {
		return createErrorResponse(404, 'Unsupported WebSocket route', 'NOT_FOUND')
	}
	if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
		return createErrorResponse(426, 'A WebSocket upgrade is required', 'UPGRADE_REQUIRED')
	}
	const offered = request.headers.get('sec-websocket-protocol') || ''
	const protocols = offered ? offered.split(',').map((value) => value.trim()) : []
	if (
		offered.length > 2048 ||
		protocols.length > 32 ||
		protocols.some((value) => !/^[!#$%&'*+\-.^_`|~0-9a-zA-Z]+$/.test(value)) ||
		new Set(protocols).size !== protocols.length
	) {
		return createErrorResponse(400, 'Invalid WebSocket subprotocols', 'INVALID_PROTOCOL')
	}

	let upstream: WebSocketClient | undefined
	try {
		const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS
		const addresses = await resolveWebSocketHost(request, target.upstreamHost)
		if (request.signal.aborted) {
			return createErrorResponse(400, 'WebSocket request cancelled', 'REQUEST_CANCELLED')
		}
		const lookup: LookupFunction = (hostname, options, callback) => {
			if (hostname !== target.upstreamHost) {
				callback(new Error('Unexpected WebSocket hostname'), '')
				return
			}
			const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family
			const selected = addresses.filter((address) => !family || address.family === family)
			if (!selected.length) callback(new Error('No approved WebSocket address'), '')
			else if (options.all) callback(null, selected)
			else callback(null, selected[0].address, selected[0].family)
		}
		const upstreamPath =
			subpath === '/v3/events_internal/launcher_socket' ? '/_internal/launcher_socket' : subpath
		const url = new URL(`wss://${target.upstreamHost}${target.upstreamPrefix}${upstreamPath}`)
		if (url.hostname !== target.upstreamHost || url.port || url.username || url.password) {
			throw new Error('Unsupported WebSocket destination')
		}
		url.search = stripRelayQueryAuth(new URL(request.url).searchParams).toString()
		const headers = sanitizeRequestHeaders(request.headers, target.upstreamHost)
		for (const name of [...headers.keys()]) {
			if (name.toLowerCase().startsWith('sec-websocket-')) headers.delete(name)
		}
		const options: WebSocketClient.ClientOptions & ClientRequestArgs & ConnectionOptions = {
			headers: Object.fromEntries(headers.entries()),
			lookup,
			servername: target.upstreamHost,
			followRedirects: false,
			handshakeTimeout: Math.max(1, deadline - Date.now()),
			maxPayload: MAX_FRAME_BYTES,
			perMessageDeflate: false,
		}
		upstream = new WebSocketClient(url, protocols, options)
		upstream.on('error', () => {})
		const initialFrames: SocketFrame[] = []
		let initialBytes = 0
		const capture = (data: RawData, binary: boolean) => {
			const frame = upstreamFrame(data, binary)
			initialBytes += frameBytes(frame)
			if (initialBytes > MAX_BUFFER_BYTES || initialFrames.length >= MAX_PENDING_FRAMES) {
				upstream?.terminate()
			} else initialFrames.push(frame)
		}
		upstream.on('message', capture)
		await new Promise<void>((resolve, reject) => {
			const socket = upstream!
			const cleanup = () => {
				socket.off('open', onOpen)
				socket.off('error', onFailure)
				socket.off('close', onFailure)
				socket.off('unexpected-response', onFailure)
				request.signal.removeEventListener('abort', onAbort)
			}
			const onOpen = () => {
				cleanup()
				resolve()
			}
			const onFailure = () => {
				cleanup()
				reject(new Error('Upstream WebSocket handshake failed'))
			}
			const onAbort = () => {
				socket.terminate()
				onFailure()
			}
			socket.once('open', onOpen)
			socket.once('error', onFailure)
			socket.once('close', onFailure)
			socket.once('unexpected-response', onFailure)
			request.signal.addEventListener('abort', onAbort, { once: true })
			if (request.signal.aborted) onAbort()
		})
		if (upstream.readyState !== WebSocketClient.OPEN) {
			throw new Error('Upstream WebSocket disconnected during handshake')
		}
		const { socket, response } = upgradeWebSocket(request, {
			protocol: upstream.protocol || undefined,
		})
		upstream.off('message', capture)
		bridgeWebSockets(socket, upstream, initialFrames)
		return response
	} catch {
		upstream?.terminate()
		return createErrorResponse(502, 'WebSocket upstream connection failed', 'WEBSOCKET_ERROR')
	}
}
