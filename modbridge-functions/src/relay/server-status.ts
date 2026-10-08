import { lookup, resolveSrv } from 'node:dns/promises'
import { BlockList, createConnection, isIP, type Socket } from 'node:net'
import { domainToASCII } from 'node:url'

import { createErrorResponse } from '../shared/errors.js'

const DEFAULT_PORT = 25565
const REQUEST_TIMEOUT_MS = 5_000
const MAX_STRING_BYTES = 32_767
const MAX_PACKET_BYTES = MAX_STRING_BYTES + 4

export const serverNetwork = {
	lookup: (host: string, options: { all: true; verbatim: true }) => lookup(host, options),
	resolveSrv,
	connect: createConnection,
}

export class ServerRequestError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		public readonly code: string,
	) {
		super(message)
	}
}

const privateIpv4 = new BlockList()
for (const [network, prefix] of [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.0.2.0', 24],
	['192.88.99.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['198.51.100.0', 24],
	['203.0.113.0', 24],
	['224.0.0.0', 4],
	['240.0.0.0', 4],
] as const)
	privateIpv4.addSubnet(network, prefix, 'ipv4')

const publicIpv6 = new BlockList()
publicIpv6.addSubnet('2000::', 3, 'ipv6')
const specialIpv6 = new BlockList()
for (const [network, prefix] of [
	['2001::', 23],
	['2001:db8::', 32],
	['2002::', 16],
	['3fff::', 20],
] as const)
	specialIpv6.addSubnet(network, prefix, 'ipv6')

export function isPublicAddress(address: string): boolean {
	if (address.includes('%')) return false
	const family = isIP(address)
	if (family === 4) return !privateIpv4.check(address, 'ipv4')
	return family === 6 && publicIpv6.check(address, 'ipv6') && !specialIpv6.check(address, 'ipv6')
}

function normalizeHost(host: string): string {
	if (!host || host.length > 253 || /[\s/%\\@?#\[\]]/.test(host)) {
		throw new ServerRequestError('Invalid Minecraft server hostname', 400, 'INVALID_SERVER_ADDRESS')
	}
	if (isIP(host)) return host
	const normalized = domainToASCII(host).toLowerCase().replace(/\.$/, '')
	if (
		!normalized ||
		normalized.length > 253 ||
		!normalized.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
	)
		throw new ServerRequestError('Invalid Minecraft server hostname', 400, 'INVALID_SERVER_ADDRESS')
	return normalized
}

function validatePort(port: unknown): number {
	if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new ServerRequestError(
			'Server port must be between 1 and 65535',
			400,
			'INVALID_SERVER_ADDRESS',
		)
	}
	return port
}

export function parseServerAddress(address: string): { host: string; port: number } {
	if (address.length > 300 || !address.trim()) {
		throw new ServerRequestError(
			'A Minecraft server address is required',
			400,
			'INVALID_SERVER_ADDRESS',
		)
	}
	const value = address.trim()
	let host = value
	let port = DEFAULT_PORT
	if (value.startsWith('[')) {
		const bracketed = /^\[([^\]]+)\](?::([0-9]+))?$/.exec(value)
		if (!bracketed || isIP(bracketed[1]) !== 6) {
			throw new ServerRequestError('Invalid bracketed IPv6 address', 400, 'INVALID_SERVER_ADDRESS')
		}
		host = bracketed[1]
		if (bracketed[2]) port = validatePort(Number(bracketed[2]))
	} else if (value.includes(':') && isIP(value) !== 6) {
		const parts = /^([^:]+):([0-9]+)$/.exec(value)
		if (!parts)
			throw new ServerRequestError('Invalid Minecraft server port', 400, 'INVALID_SERVER_ADDRESS')
		host = parts[1]
		port = validatePort(Number(parts[2]))
	}
	return { host: normalizeHost(host), port }
}

export async function resolvePublicHost(
	host: string,
): Promise<Array<{ address: string; family: 4 | 6 }>> {
	const normalized = normalizeHost(host)
	const literalFamily = isIP(normalized)
	const records = literalFamily
		? [{ address: normalized, family: literalFamily }]
		: await serverNetwork.lookup(normalized, { all: true, verbatim: true })
	if (!records.length || records.some((record) => !isPublicAddress(record.address))) {
		throw new ServerRequestError(
			'Minecraft servers must resolve only to public IP addresses',
			403,
			'SERVER_ADDRESS_BLOCKED',
		)
	}
	return records.map((record) => ({
		address: record.address,
		family: isIP(record.address) as 4 | 6,
	}))
}

async function resolveServer(host: string, port: number, signal: AbortSignal) {
	let resolvedHost = host
	let resolvedPort = port
	if (port === DEFAULT_PORT && !isIP(host)) {
		try {
			const records = await serverNetwork.resolveSrv(`_minecraft._tcp.${host}`)
			signal.throwIfAborted()
			const record = [...records].sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0]
			if (record) {
				resolvedHost = normalizeHost(record.name)
				resolvedPort = validatePort(record.port)
			}
		} catch (error) {
			if (!['ENODATA', 'ENOTFOUND'].includes((error as NodeJS.ErrnoException).code || ''))
				throw error
		}
	}
	signal.throwIfAborted()
	const addresses = await resolvePublicHost(resolvedHost)
	signal.throwIfAborted()
	return { resolvedHost, resolvedPort, addresses }
}

function encodeVarInt(value: number): Buffer {
	const bytes = []
	let remaining = value >>> 0
	do {
		let byte = remaining & 0x7f
		remaining >>>= 7
		if (remaining) byte |= 0x80
		bytes.push(byte)
	} while (remaining)
	return Buffer.from(bytes)
}

function encodeString(value: string): Buffer {
	const bytes = Buffer.from(value, 'utf8')
	return Buffer.concat([encodeVarInt(bytes.length), bytes])
}

function invalidResponse(): never {
	throw new ServerRequestError(
		'The Minecraft server returned an invalid status packet',
		502,
		'INVALID_SERVER_RESPONSE',
	)
}

class SocketReader {
	private buffer: Buffer = Buffer.alloc(0)
	private error?: Error
	private wake?: () => void

	constructor(
		private socket: Socket,
		private maximum: number,
	) {
		socket.on('data', (chunk: Buffer) => {
			if (this.buffer.length + chunk.length > maximum) {
				this.error = new ServerRequestError(
					'Minecraft status packet exceeds the size limit',
					502,
					'INVALID_SERVER_RESPONSE',
				)
				socket.destroy()
			} else this.buffer = Buffer.concat([this.buffer, chunk])
			this.wake?.()
		})
		socket.on('error', (error) => {
			this.error = error
			this.wake?.()
		})
		socket.on('close', () => {
			this.error ||= new Error('Server closed the status connection')
			this.wake?.()
		})
	}

	async read(length: number): Promise<Buffer> {
		if (length < 0 || length > this.maximum) invalidResponse()
		while (this.buffer.length < length) {
			if (this.error) throw this.error
			await new Promise<void>((resolve) => {
				this.wake = resolve
			})
		}
		const bytes = this.buffer.subarray(0, length)
		this.buffer = this.buffer.subarray(length)
		return bytes
	}

	async varInt(): Promise<number> {
		let value = 0
		for (let index = 0; index < 5; index++) {
			const byte = (await this.read(1))[0]
			if (index === 4 && byte & 0xf0) invalidResponse()
			value |= (byte & 0x7f) << (7 * index)
			if (!(byte & 0x80)) return value
		}
		return invalidResponse()
	}
}

function readBufferVarInt(bytes: Buffer, offset: number): { value: number; offset: number } {
	let value = 0
	for (let index = 0; index < 5; index++) {
		if (offset >= bytes.length) invalidResponse()
		const byte = bytes[offset++]
		if (index === 4 && byte & 0xf0) invalidResponse()
		value |= (byte & 0x7f) << (7 * index)
		if (!(byte & 0x80)) return { value, offset }
	}
	return invalidResponse()
}

function statusInteger(value: unknown): value is number {
	return (
		typeof value === 'number' &&
		Number.isInteger(value) &&
		value >= -2_147_483_648 &&
		value <= 2_147_483_647
	)
}

function normalizeModernStatus(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) invalidResponse()
	const input = value as Record<string, unknown>
	const status: Record<string, unknown> = { enforcesSecureChat: input.enforcesSecureChat === true }
	if (input.description !== undefined) status.description = input.description
	if (input.players !== undefined && input.players !== null) {
		const players = input.players as Record<string, unknown>
		if (!statusInteger(players.max) || !statusInteger(players.online)) invalidResponse()
		const sample = players.sample ?? []
		if (
			!Array.isArray(sample) ||
			sample.some(
				(player) => !player || typeof player.id !== 'string' || typeof player.name !== 'string',
			)
		)
			invalidResponse()
		status.players = { max: players.max, online: players.online, sample }
	}
	if (input.version !== undefined && input.version !== null) {
		const version = input.version as Record<string, unknown>
		if (typeof version.name !== 'string' || !statusInteger(version.protocol)) invalidResponse()
		status.version = { name: version.name, protocol: version.protocol, legacy: false }
	}
	if (
		typeof input.favicon === 'string' &&
		/^data:image\/png;base64,[a-z0-9+/=]+$/i.test(input.favicon)
	)
		status.favicon = input.favicon
	return status
}

async function modernStatus(
	reader: SocketReader,
	socket: Socket,
	host: string,
	port: number,
	version: number,
) {
	const portBytes = Buffer.alloc(2)
	portBytes.writeUInt16BE(port)
	const handshake = Buffer.concat([
		Buffer.from([0]),
		encodeVarInt(version),
		encodeString(host),
		portBytes,
		Buffer.from([1]),
	])
	socket.write(Buffer.concat([encodeVarInt(handshake.length), handshake, Buffer.from([1, 0])]))
	const length = await reader.varInt()
	if (length < 3 || length > MAX_PACKET_BYTES) invalidResponse()
	const packet = await reader.read(length)
	const packetId = readBufferVarInt(packet, 0)
	if (packetId.value !== 0) invalidResponse()
	const stringLength = readBufferVarInt(packet, packetId.offset)
	if (
		stringLength.value < 0 ||
		stringLength.value > MAX_STRING_BYTES ||
		stringLength.offset + stringLength.value !== packet.length
	)
		invalidResponse()
	let json: unknown
	try {
		json = JSON.parse(
			new TextDecoder('utf-8', { fatal: true }).decode(packet.subarray(stringLength.offset)),
		)
	} catch {
		return invalidResponse()
	}
	return normalizeModernStatus(json)
}

function utf16String(value: string): Buffer {
	const size = Buffer.alloc(2)
	size.writeUInt16BE(value.length)
	return Buffer.concat([size, Buffer.from(value, 'utf16le').swap16()])
}

async function legacyStatus(
	reader: SocketReader,
	socket: Socket,
	host: string,
	port: number,
	version: number,
) {
	if (version >= 73) {
		const portBytes = Buffer.alloc(4)
		portBytes.writeUInt32BE(port)
		const payload = Buffer.concat([Buffer.from([version]), utf16String(host), portBytes])
		const size = Buffer.alloc(2)
		size.writeUInt16BE(payload.length)
		socket.write(
			Buffer.concat([Buffer.from([0xfe, 1, 0xfa]), utf16String('MC|PingHost'), size, payload]),
		)
	} else socket.write(Buffer.from(version >= 47 ? [0xfe, 1] : [0xfe]))
	const header = await reader.read(3)
	if (header[0] !== 0xff) invalidResponse()
	const length = header.readUInt16BE(1)
	if (length > MAX_STRING_BYTES) invalidResponse()
	let text: string
	try {
		text = new TextDecoder('utf-16be', { fatal: true }).decode(await reader.read(length * 2))
	} catch {
		return invalidResponse()
	}
	const fields = text.split('\0')
	let description: string
	let name: string
	let protocol: number
	let online: number
	let max: number
	if (fields[0] === '§1' && fields.length === 6) {
		protocol = Number(fields[1])
		name = fields[2]
		description = fields[3]
		online = Number(fields[4])
		max = Number(fields[5])
	} else {
		const oldFields = text.split('§')
		if (oldFields.length < 3) invalidResponse()
		max = Number(oldFields.pop())
		online = Number(oldFields.pop())
		description = oldFields.join('§')
		name = 'Legacy'
		protocol = version
	}
	if (!statusInteger(protocol) || !statusInteger(online) || !statusInteger(max)) invalidResponse()
	return {
		description,
		version: { name, protocol, legacy: true },
		players: { online, max, sample: [] },
		enforcesSecureChat: false,
	}
}

async function readRequestBody(
	request: Request,
	signal: AbortSignal,
): Promise<Record<string, unknown>> {
	if (!request.body)
		throw new ServerRequestError('A JSON request body is required', 400, 'INVALID_REQUEST')
	const reader = request.body.getReader()
	const cancel = () => {
		void reader.cancel().catch(() => {})
	}
	signal.addEventListener('abort', cancel, { once: true })
	const chunks: Uint8Array[] = []
	let length = 0
	try {
		for (;;) {
			signal.throwIfAborted()
			const chunk = await reader.read()
			if (chunk.done) break
			length += chunk.value.byteLength
			if (length > 4096) {
				cancel()
				throw new ServerRequestError('Server request body is too large', 413, 'INVALID_REQUEST')
			}
			chunks.push(chunk.value)
		}
	} finally {
		signal.removeEventListener('abort', cancel)
		reader.releaseLock()
	}
	try {
		const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
		if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
		return body as Record<string, unknown>
	} catch {
		throw new ServerRequestError('Invalid JSON server request', 400, 'INVALID_REQUEST')
	}
}

/** Resolve or retrieve status; ping measures connection and status-response latency from Relay. */
export async function handleServerRequest(request: Request): Promise<Response> {
	if (request.method !== 'POST')
		return createErrorResponse(405, 'Server requests require POST', 'METHOD_NOT_ALLOWED')
	const pathname = new URL(request.url).pathname
	if (!['/server/status', '/server/resolve'].includes(pathname))
		return createErrorResponse(404, 'Unknown server endpoint', 'NOT_FOUND')
	const controller = new AbortController()
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort()
			reject(new ServerRequestError('Minecraft server request timed out', 504, 'SERVER_TIMEOUT'))
		}, REQUEST_TIMEOUT_MS)
	})
	const operation = async () => {
		const body = await readRequestBody(request, controller.signal)
		controller.signal.throwIfAborted()
		const parsed =
			typeof body.address === 'string'
				? parseServerAddress(body.address)
				: {
						host: normalizeHost(typeof body.host === 'string' ? body.host : ''),
						port: validatePort(body.port),
					}
		const protocol = body.protocol as { legacy?: unknown; version?: unknown } | null | undefined
		if (
			protocol !== undefined &&
			protocol !== null &&
			(typeof protocol !== 'object' ||
				typeof protocol.legacy !== 'boolean' ||
				!statusInteger(protocol.version) ||
				(protocol.legacy &&
					((protocol.version as number) < 0 || (protocol.version as number) > 255)))
		)
			throw new ServerRequestError('Invalid Minecraft protocol version', 400, 'INVALID_REQUEST')
		const resolved = await resolveServer(parsed.host, parsed.port, controller.signal)
		if (pathname === '/server/resolve')
			return { resolved_host: resolved.resolvedHost, resolved_port: resolved.resolvedPort }
		const address = resolved.addresses[0]
		const started = Date.now()
		const socket = serverNetwork.connect({
			host: address.address,
			family: address.family,
			port: resolved.resolvedPort,
			signal: controller.signal,
		})
		const legacy = protocol?.legacy === true
		const reader = new SocketReader(
			socket,
			legacy ? MAX_STRING_BYTES * 2 + 3 : MAX_PACKET_BYTES + 5,
		)
		try {
			await new Promise<void>((resolve, reject) => {
				socket.once('connect', resolve)
				socket.once('error', reject)
			})
			const status = legacy
				? await legacyStatus(reader, socket, parsed.host, parsed.port, protocol!.version as number)
				: await modernStatus(
						reader,
						socket,
						parsed.host,
						parsed.port,
						(protocol?.version as number | undefined) ?? -1,
					)
			return { ...status, ping: Date.now() - started }
		} finally {
			socket.destroy()
		}
	}
	try {
		const status = await Promise.race([operation(), timeout])
		return new Response(JSON.stringify(status), {
			headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
		})
	} catch (error) {
		if (controller.signal.aborted)
			return createErrorResponse(504, 'Minecraft server request timed out', 'SERVER_TIMEOUT')
		if (error instanceof ServerRequestError)
			return createErrorResponse(error.status, error.message, error.code)
		return createErrorResponse(
			502,
			'Could not retrieve the Minecraft server status',
			'SERVER_UNAVAILABLE',
		)
	} finally {
		clearTimeout(timer)
	}
}
