import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { once } from 'node:events'

const mocks = vi.hoisted(() => ({
	resolvePublicHost: vi.fn(),
	upgradeWebSocket: vi.fn(),
	connections: [] as any[],
	autoOpen: true,
	initialFrames: [] as Array<[Buffer, boolean]>,
	onConstruct: undefined as (() => void) | undefined,
}))

vi.mock('../src/relay/server-status.js', () => ({ resolvePublicHost: mocks.resolvePublicHost }))
vi.mock('@neon/functions', () => ({ upgradeWebSocket: mocks.upgradeWebSocket }))
vi.mock('ws', async () => {
	const { EventEmitter } = await import('node:events')
	class MockWebSocket extends EventEmitter {
		static CONNECTING = 0
		static OPEN = 1
		static CLOSING = 2
		static CLOSED = 3
		readyState = 0
		bufferedAmount = 0
		protocol = ''
		send = vi.fn((_data, _options, callback) => callback?.())
		ping = vi.fn((_data, _mask, callback) => callback?.())
		close = vi.fn(() => {
			this.readyState = 2
		})
		terminate = vi.fn(() => {
			this.readyState = 3
		})
		constructor(
			public url: URL,
			public protocols: string[],
			public options: any,
		) {
			super()
			this.protocol = protocols[0] ?? ''
			mocks.connections.push(this)
			mocks.onConstruct?.()
			if (mocks.autoOpen)
				queueMicrotask(() => {
					this.readyState = 1
					this.emit('open')
					for (const [data, binary] of mocks.initialFrames) this.emit('message', data, binary)
				})
		}
	}
	return { default: MockWebSocket }
})

import { bridgeWebSockets, isWebSocketRoute, proxyWebSocket } from '../src/relay/websocket.js'

class Downstream extends EventTarget {
	readyState = 0
	bufferedAmount = 0
	binaryType = 'blob'
	send = vi.fn()
	close = vi.fn((_code?: number, _reason?: string) => {
		this.readyState = 3
	})
	open() {
		this.readyState = 1
		this.dispatchEvent(new Event('open'))
	}
	message(data: unknown) {
		this.dispatchEvent(new MessageEvent('message', { data }))
	}
	disconnect(code = 1000, reason = '') {
		this.readyState = 3
		const event = new Event('close')
		Object.assign(event, { code, reason })
		this.dispatchEvent(event)
	}
}

const target = {
	upstreamHost: 'api.modrinth.com',
	upstreamPrefix: '',
	category: 'modrinth-api' as const,
}
const node = {
	upstreamHost: 'ashburn1.nodes.modrinth.com',
	upstreamPrefix: '',
	category: 'hosting' as const,
}
const path = '/_internal/launcher_socket'
const request = (query = '', headers: Record<string, string> = {}, signal?: AbortSignal) =>
	new Request(`https://relay.modbridge.internal/api${path}${query}`, {
		headers: { Upgrade: 'websocket', ...headers },
		signal,
	})
let downstream: Downstream
let upgradeResponse: Response

beforeEach(() => {
	mocks.connections.length = 0
	mocks.autoOpen = true
	mocks.initialFrames = []
	mocks.onConstruct = undefined
	mocks.resolvePublicHost.mockReset().mockResolvedValue([
		{ address: '8.8.8.8', family: 4 },
		{ address: '2001:4860:4860::8888', family: 6 },
	])
	downstream = new Downstream()
	upgradeResponse = { status: 101 } as Response
	mocks.upgradeWebSocket
		.mockReset()
		.mockReturnValue({ socket: downstream, response: upgradeResponse })
	vi.stubEnv('MODBRIDGE_RELAY_SECRET', 'relay-secret')
})

afterEach(() => {
	downstream?.disconnect()
	for (const socket of mocks.connections) socket.terminate()
	vi.unstubAllEnvs()
	vi.useRealTimers()
	vi.restoreAllMocks()
})

describe('Relay WebSocket upgrade', () => {
	it('allows only supported friends and hosted node sockets', () => {
		expect(isWebSocketRoute(target, path)).toBe(true)
		expect(isWebSocketRoute(target, '/v3/events_internal/launcher_socket')).toBe(true)
		for (const subpath of ['/modrinth/v0/ws', '/modrinth/v1/socket', '/pingtest']) {
			expect(isWebSocketRoute(node, subpath)).toBe(true)
		}
		expect(isWebSocketRoute(target, '/v3/project/example')).toBe(false)
		expect(
			isWebSocketRoute(
				{ ...node, upstreamHost: 'ashburn1.nodes.modrinth.com.evil.test' },
				'/pingtest',
			),
		).toBe(false)
	})

	it('requires an upgrade before performing DNS or opening upstream sockets', async () => {
		const response = await proxyWebSocket(new Request('https://relay.test/api'), target, path)
		expect(response.status).toBe(426)
		expect(mocks.resolvePublicHost).not.toHaveBeenCalled()
		expect(mocks.connections).toHaveLength(0)
	})

	it.each(['chat,chat', 'invalid protocol', ',chat'])(
		'rejects invalid offered protocols %s',
		async (protocols) => {
			const response = await proxyWebSocket(
				request('', { 'Sec-WebSocket-Protocol': protocols }),
				target,
				path,
			)
			expect(response.status).toBe(400)
			expect(mocks.resolvePublicHost).not.toHaveBeenCalled()
		},
	)

	it('keeps user auth and selected subprotocol while stripping Relay credentials', async () => {
		const response = await proxyWebSocket(
			request('?code=session&token=node-secret&relay_token=relay-secret', {
				Authorization: 'Bearer user-session',
				'X-Modbridge-Token': 'relay-secret',
				'Sec-WebSocket-Protocol': 'chat.v2, chat.v1',
				'Sec-WebSocket-Key': 'client-key',
			}),
			target,
			path,
		)
		expect(response).toBe(upgradeResponse)
		const socket = mocks.connections[0]
		expect(socket.url.href).toBe(
			'wss://api.modrinth.com/_internal/launcher_socket?code=session&token=node-secret',
		)
		expect(socket.options.headers.authorization).toBe('Bearer user-session')
		expect(socket.options.headers['x-modbridge-token']).toBeUndefined()
		expect(socket.options.headers['sec-websocket-key']).toBeUndefined()
		expect(socket.protocols).toEqual(['chat.v2', 'chat.v1'])
		expect(mocks.upgradeWebSocket.mock.calls[0][1]).toEqual({ protocol: 'chat.v2' })
		expect(socket.options.followRedirects).toBe(false)
		expect(socket.options.servername).toBe('api.modrinth.com')
	})

	it('normalizes the malformed legacy friends URL and strips legacy Relay auth', async () => {
		await proxyWebSocket(
			request('?code=session&token=relay-secret', { Authorization: 'Bearer relay-secret' }),
			target,
			'/v3/events_internal/launcher_socket',
		)
		expect(mocks.connections[0].url.href).toBe(
			'wss://api.modrinth.com/_internal/launcher_socket?code=session',
		)
		expect(mocks.connections[0].options.headers.authorization).toBeUndefined()
	})

	it('preserves the opaque socket path returned for an approved hosting node', async () => {
		const socketPath = '/servers/returned-by-auth-service/console/socket'
		expect(isWebSocketRoute(node, socketPath)).toBe(true)
		expect(
			await proxyWebSocket(
				request('?token=node-session&relay_token=relay-secret'),
				node,
				socketPath,
			),
		).toBe(upgradeResponse)
		expect(mocks.connections[0].url.href).toBe(
			`wss://${node.upstreamHost}${socketPath}?token=node-session`,
		)
	})

	it('pins only prevalidated DNS addresses without a second lookup', async () => {
		await proxyWebSocket(request(), target, path)
		const lookup = mocks.connections[0].options.lookup
		const callback = vi.fn()
		lookup('api.modrinth.com', { all: true }, callback)
		expect(callback).toHaveBeenLastCalledWith(null, [
			{ address: '8.8.8.8', family: 4 },
			{ address: '2001:4860:4860::8888', family: 6 },
		])
		lookup('api.modrinth.com', { family: 6 }, callback)
		expect(callback).toHaveBeenLastCalledWith(null, '2001:4860:4860::8888', 6)
		lookup('evil.test', {}, callback)
		expect(callback.mock.lastCall?.[0]).toBeInstanceOf(Error)
		expect(mocks.resolvePublicHost).toHaveBeenCalledTimes(1)
	})

	it('rejects DNS policy failures before socket connection', async () => {
		mocks.resolvePublicHost.mockRejectedValue(new Error('Private address blocked'))
		expect((await proxyWebSocket(request(), target, path)).status).toBe(502)
		expect(mocks.connections).toHaveLength(0)
		expect(mocks.upgradeWebSocket).not.toHaveBeenCalled()
	})

	it('bounds stalled DNS resolution', async () => {
		vi.useFakeTimers()
		mocks.resolvePublicHost.mockReturnValue(new Promise(() => {}))
		const pending = proxyWebSocket(request(), target, path)
		await vi.advanceTimersByTimeAsync(10_000)
		expect((await pending).status).toBe(502)
		expect(mocks.connections).toHaveLength(0)
	})

	it('cancels stalled DNS resolution when the client disconnects', async () => {
		mocks.resolvePublicHost.mockReturnValue(new Promise(() => {}))
		const controller = new AbortController()
		const pending = proxyWebSocket(request('', {}, controller.signal), target, path)
		controller.abort()
		expect((await pending).status).toBe(502)
		expect(mocks.connections).toHaveLength(0)
	})

	it('closes the abort race before handshake listeners are registered', async () => {
		const controller = new AbortController()
		mocks.autoOpen = false
		mocks.onConstruct = () => controller.abort()
		expect((await proxyWebSocket(request('', {}, controller.signal), target, path)).status).toBe(
			502,
		)
		expect(mocks.connections[0].terminate).toHaveBeenCalled()
		expect(mocks.upgradeWebSocket).not.toHaveBeenCalled()
	})

	it('terminates upstream if the runtime cannot upgrade the downstream', async () => {
		mocks.upgradeWebSocket.mockImplementation(() => {
			throw new Error('No Neon runtime')
		})
		expect((await proxyWebSocket(request(), target, path)).status).toBe(502)
		expect(mocks.connections[0].terminate).toHaveBeenCalled()
	})

	it('buffers immediate upstream greeting frames until the downstream opens', async () => {
		mocks.initialFrames = [
			[Buffer.from('welcome'), false],
			[Buffer.from([0, 1, 255]), true],
		]
		await proxyWebSocket(request(), target, path)
		expect(downstream.send).not.toHaveBeenCalled()
		downstream.open()
		expect(downstream.send.mock.calls.map(([frame]) => frame)).toEqual([
			'welcome',
			new Uint8Array([0, 1, 255]),
		])
	})
})

describe('Relay WebSocket forwarding', () => {
	const connected = async () => {
		await proxyWebSocket(request(), target, path)
		downstream.open()
		return mocks.connections[0]
	}

	it('preserves text and binary in both directions', async () => {
		const upstream = await connected()
		downstream.message('command')
		downstream.message(new Uint8Array([0, 255]).buffer)
		expect(upstream.send.mock.calls[0].slice(0, 2)).toEqual(['command', { binary: false }])
		expect(upstream.send.mock.calls[1].slice(0, 2)).toEqual([
			new Uint8Array([0, 255]),
			{ binary: true },
		])
		upstream.emit('message', Buffer.from('console'), false)
		upstream.emit('message', Buffer.from([1, 128]), true)
		expect(downstream.send.mock.calls.map(([frame]) => frame)).toEqual([
			'console',
			new Uint8Array([1, 128]),
		])
	})

	it('keeps a successful heartbeat open and closes on heartbeat failure', async () => {
		vi.useFakeTimers()
		const upstream = await connected()
		await vi.advanceTimersByTimeAsync(30_000)
		expect(upstream.ping).toHaveBeenCalledTimes(1)
		expect(downstream.close).not.toHaveBeenCalled()
		upstream.ping.mockImplementation(
			(_data: unknown, _mask: unknown, callback: (error?: Error) => void) =>
				callback(new Error('Disconnected')),
		)
		await vi.advanceTimersByTimeAsync(30_000)
		expect(downstream.close).toHaveBeenCalledWith(1011, 'WebSocket connection failed')
	})

	it('closes both ends and clears event handlers when the client disconnects', async () => {
		const upstream = await connected()
		downstream.disconnect(1000, 'Client closed')
		expect(upstream.close).toHaveBeenCalledWith(1000, 'Client closed')
		expect(upstream.listenerCount('message')).toBe(0)
		upstream.emit('error', new Error('Late socket error'))
		upstream.emit('message', Buffer.from('late'), false)
		expect(downstream.send).not.toHaveBeenCalled()
	})

	it('normalizes reserved close codes and bounds UTF-8 close reasons', async () => {
		const upstream = await connected()
		upstream.readyState = 3
		upstream.emit('close', 1006, Buffer.from('😀'.repeat(100)))
		const [code, reason] = downstream.close.mock.lastCall!
		expect(code).toBe(1011)
		expect(Buffer.byteLength(reason!)).toBeLessThanOrEqual(123)
		expect(reason).not.toContain('\uFFFD')
	})

	it('bounds queued messages and slow receivers', async () => {
		const upstream = await connected()
		upstream.bufferedAmount = 8 * 1024 * 1024
		downstream.message('command')
		expect(downstream.close).toHaveBeenCalledWith(1009, 'Relay message limit exceeded')
		expect(upstream.send).not.toHaveBeenCalled()
	})

	it('terminates excessive upstream frames and stalled downstream handshakes', async () => {
		vi.useFakeTimers()
		await proxyWebSocket(request(), target, path)
		const upstream = mocks.connections[0]
		for (let i = 0; i <= 128; i++) upstream.emit('message', Buffer.from('pending'), false)
		expect(downstream.close).toHaveBeenCalledWith(1009, 'Relay message limit exceeded')
		await vi.advanceTimersByTimeAsync(30_000)
		expect(upstream.ping).not.toHaveBeenCalled()
	})

	it('forwards frames through a real loopback WebSocket server', async () => {
		const { default: RealSocket, WebSocketServer } =
			await vi.importActual<typeof import('ws')>('ws')
		const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
		await once(server, 'listening')
		const port = (server.address() as { port: number }).port
		server.on('connection', (socket) =>
			socket.on('message', (data, binary) => socket.send(data, { binary })),
		)
		const socket = new RealSocket(`ws://127.0.0.1:${port}`)
		await once(socket, 'open')
		downstream.open()
		const cleanup = bridgeWebSockets(downstream as unknown as WebSocket, socket)
		try {
			downstream.message('loopback command')
			downstream.message(new Uint8Array([0, 255]).buffer)
			await vi.waitFor(() =>
				expect(downstream.send.mock.calls.map(([frame]) => frame)).toEqual([
					'loopback command',
					new Uint8Array([0, 255]),
				]),
			)
		} finally {
			cleanup()
			await once(socket, 'close')
			await new Promise<void>((resolve) => server.close(() => resolve()))
		}
	})
})
