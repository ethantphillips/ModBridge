import {
	createConnection,
	createServer,
	type Server,
	type Socket,
	type TcpNetConnectOpts,
} from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	handleServerRequest,
	isPublicAddress,
	parseServerAddress,
	resolvePublicHost,
	serverNetwork,
} from '../src/relay/server-status.js'

const fixtures: Server[] = []
const sockets = new Set<Socket>()

function request(path: 'resolve' | 'status', body: unknown): Request {
	return new Request(`https://relay.example/server/${path}`, {
		method: 'POST',
		body: JSON.stringify(body),
	})
}

function varInt(value: number): Buffer {
	const bytes = []
	do {
		const byte = value & 0x7f
		value >>>= 7
		bytes.push(byte | (value ? 0x80 : 0))
	} while (value)
	return Buffer.from(bytes)
}

function modernPacket(json: string, packetId = 0): Buffer {
	const string = Buffer.from(json)
	const packet = Buffer.concat([Buffer.from([packetId]), varInt(string.length), string])
	return Buffer.concat([varInt(packet.length), packet])
}

function legacyPacket(text: string): Buffer {
	const header = Buffer.alloc(3)
	header[0] = 0xff
	header.writeUInt16BE(text.length, 1)
	return Buffer.concat([header, Buffer.from(text, 'utf16le').swap16()])
}

async function fixture(onRequest: (socket: Socket, request: Buffer) => void) {
	const server = createServer((socket) => {
		sockets.add(socket)
		socket.on('close', () => sockets.delete(socket))
		socket.once('data', (data) => onRequest(socket, data))
	})
	fixtures.push(server)
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()
	if (!address || typeof address === 'string') throw new Error('Fixture could not listen')
	return vi.spyOn(serverNetwork, 'connect').mockImplementation(((options: TcpNetConnectOpts) =>
		createConnection({
			host: '127.0.0.1',
			port: address.port,
			signal: options.signal,
		})) as typeof createConnection)
}

beforeEach(() => {
	vi.spyOn(serverNetwork, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
	vi.spyOn(serverNetwork, 'resolveSrv').mockRejectedValue(
		Object.assign(new Error('No SRV record'), { code: 'ENODATA' }),
	)
})

afterEach(async () => {
	for (const socket of sockets) socket.destroy()
	await Promise.all(
		fixtures
			.splice(0)
			.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
	)
	vi.restoreAllMocks()
	vi.useRealTimers()
})

describe('Public Minecraft server resolution', () => {
	it('rejects private, special, mapped, documentation, and tunnel addresses', () => {
		for (const address of [
			'0.1.2.3',
			'10.0.0.1',
			'100.64.0.1',
			'127.0.0.1',
			'169.254.169.254',
			'172.16.0.1',
			'192.0.0.9',
			'192.0.2.1',
			'192.88.99.1',
			'192.168.1.1',
			'198.18.0.1',
			'198.51.100.1',
			'203.0.113.1',
			'224.0.0.1',
			'240.0.0.1',
			'255.255.255.255',
			'::',
			'::1',
			'fc00::1',
			'fe80::1',
			'::ffff:93.184.216.34',
			'64:ff9b::5db8:d822',
			'2001::1',
			'2001:db8::1',
			'2002:5db8:d822::1',
			'3fff::1',
			'2001:4860:4860::8888%eth0',
		])
			expect(isPublicAddress(address), address).toBe(false)
		for (const address of [
			'1.1.1.1',
			'93.184.216.34',
			'223.255.255.254',
			'2001:4860:4860::8888',
			'2606:4700:4700::1111',
		]) {
			expect(isPublicAddress(address), address).toBe(true)
		}
	})

	it('validates every DNS answer before returning any public destination', async () => {
		vi.mocked(serverNetwork.lookup).mockResolvedValue([
			{ address: '93.184.216.34', family: 4 },
			{ address: '127.0.0.1', family: 4 },
		])
		await expect(resolvePublicHost('mc.example.com')).rejects.toMatchObject({
			code: 'SERVER_ADDRESS_BLOCKED',
		})
	})

	it('resolves SRV records for the default port and validates the chosen target', async () => {
		vi.mocked(serverNetwork.resolveSrv).mockResolvedValue([
			{ name: 'other.example.com', port: 25567, priority: 10, weight: 0 },
			{ name: 'srv.example.com', port: 25566, priority: 0, weight: 5 },
		])
		const response = await handleServerRequest(
			request('resolve', { host: 'mc.example.com', port: 25565 }),
		)
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			resolved_host: 'srv.example.com',
			resolved_port: 25566,
		})
		expect(serverNetwork.resolveSrv).toHaveBeenCalledWith('_minecraft._tcp.mc.example.com')
		expect(serverNetwork.lookup).toHaveBeenCalledWith('srv.example.com', {
			all: true,
			verbatim: true,
		})
	})

	it('does not apply SRV resolution to a nondefault port or literal IPv6', async () => {
		for (const address of ['mc.example.com:25566', '[2606:4700:4700::1111]:25565']) {
			const response = await handleServerRequest(request('resolve', { address }))
			expect(response.status).toBe(200)
		}
		expect(serverNetwork.resolveSrv).not.toHaveBeenCalled()
	})

	it('blocks localhost literals and SRV targets resolving to private networks without dialing', async () => {
		const connect = vi.spyOn(serverNetwork, 'connect')
		vi.mocked(serverNetwork.resolveSrv).mockResolvedValue([
			{ name: 'internal.example.com', port: 25565, priority: 0, weight: 0 },
		])
		vi.mocked(serverNetwork.lookup).mockResolvedValue([{ address: '10.0.0.10', family: 4 }])
		for (const address of ['127.0.0.1', '[::1]', '0x7f000001', 'mc.example.com']) {
			const response = await handleServerRequest(request('status', { address }))
			expect(response.status).toBe(403)
		}
		expect(connect).not.toHaveBeenCalled()
	})

	it('rejects malformed hosts, ports, request shapes, and protocol values', async () => {
		for (const address of [
			'',
			'https://mc.example.com',
			'mc.example.com:0',
			'mc.example.com:65536',
			'user@mc.example.com',
			'[::1]:x',
			'mc.example.com:+25565',
			'mc.example.com/path',
		]) {
			expect(() => parseServerAddress(address), address).toThrow()
		}
		for (const body of [
			{},
			{ host: 'mc.example.com', port: '25565' },
			{ address: 'mc.example.com', protocol: { legacy: true, version: 256 } },
		]) {
			expect((await handleServerRequest(request('status', body))).status).toBe(400)
		}
		expect(
			(await handleServerRequest(new Request('https://relay.example/server/status'))).status,
		).toBe(405)
		expect(
			(
				await handleServerRequest(
					new Request('https://relay.example/server/status', {
						method: 'POST',
						body: 'x'.repeat(4097),
					}),
				)
			).status,
		).toBe(413)
	})
})

describe('Bounded Minecraft status protocol', () => {
	it('uses pinned public DNS and SRV port while preserving the original modern handshake', async () => {
		vi.mocked(serverNetwork.resolveSrv).mockResolvedValue([
			{ name: 'srv.example.com', port: 25566, priority: 0, weight: 0 },
		])
		const status = {
			description: { text: 'A fixture server 😀' },
			players: { max: 20, online: 2 },
			version: { name: '1.21.1', protocol: 767 },
			favicon: 'data:image/png;base64,aGVsbG8=',
		}
		const packet = modernPacket(JSON.stringify(status))
		let handshake: Buffer | undefined
		const connect = await fixture((socket, data) => {
			handshake = data
			socket.write(packet.subarray(0, 2))
			setTimeout(() => socket.end(packet.subarray(2)), 5)
		})
		const response = await handleServerRequest(
			request('status', { address: 'mc.example.com', protocol: { version: 767, legacy: false } }),
		)
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({
			...status,
			players: { ...status.players, sample: [] },
			version: { ...status.version, legacy: false },
			enforcesSecureChat: false,
			ping: expect.any(Number),
		})
		expect(connect).toHaveBeenCalledWith(
			expect.objectContaining({ host: '93.184.216.34', family: 4, port: 25566 }),
		)
		expect(handshake?.includes(Buffer.from('mc.example.com'))).toBe(true)
		expect(handshake?.includes(Buffer.from('srv.example.com'))).toBe(false)
		expect(handshake?.subarray(-4)).toEqual(
			Buffer.from([25565 >> 8, 25565 & 255, 1, 1, 0]).subarray(1),
		)
	})

	it('supports omitted modern optional fields and strips arbitrary external favicons', async () => {
		await fixture((socket) =>
			socket.end(
				modernPacket(
					JSON.stringify({ description: 'Hello', favicon: 'https://evil.example/icon.png' }),
				),
			),
		)
		const response = await handleServerRequest(request('status', { address: 'mc.example.com' }))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			description: 'Hello',
			enforcesSecureChat: false,
			ping: expect.any(Number),
		})
	})

	it('reads extended legacy UTF16 status and sends the 1.6 PingHost request', async () => {
		let sent: Buffer | undefined
		await fixture((socket, data) => {
			sent = data
			socket.end(legacyPacket(['§1', '74', '1.6.4', '§aLegacy 😀', '2', '20'].join('\0')))
		})
		const response = await handleServerRequest(
			request('status', { address: 'mc.example.com', protocol: { version: 74, legacy: true } }),
		)
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({
			description: '§aLegacy 😀',
			players: { online: 2, max: 20, sample: [] },
			version: { name: '1.6.4', protocol: 74, legacy: true },
			enforcesSecureChat: false,
		})
		expect(sent?.subarray(0, 3)).toEqual(Buffer.from([0xfe, 1, 0xfa]))
		expect(sent?.includes(Buffer.from('MC|PingHost', 'utf16le').swap16())).toBe(true)
	})

	it('reads older legacy status without losing formatting codes in the description', async () => {
		await fixture((socket, data) => {
			expect(data).toEqual(Buffer.from([0xfe]))
			socket.end(legacyPacket('§aOld server§2§20'))
		})
		const response = await handleServerRequest(
			request('status', { address: 'mc.example.com', protocol: { version: 39, legacy: true } }),
		)
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({
			description: '§aOld server',
			players: { online: 2, max: 20, sample: [] },
			version: { name: 'Legacy', protocol: 39, legacy: true },
		})
	})

	it('sends the extended legacy probe for protocols 47 through 72', async () => {
		await fixture((socket, data) => {
			expect(data).toEqual(Buffer.from([0xfe, 1]))
			socket.end(legacyPacket(['§1', '47', '1.4.2', 'Older server', '2', '20'].join('\0')))
		})
		const response = await handleServerRequest(
			request('status', { address: 'mc.example.com', protocol: { version: 47, legacy: true } }),
		)
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({
			version: { name: '1.4.2', protocol: 47, legacy: true },
			players: { online: 2, max: 20, sample: [] },
		})
	})

	it.each([
		['oversized declared packet', varInt(32772)],
		['overlong varint', Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0])],
		['wrong packet ID', modernPacket('{}', 1)],
		['malformed JSON', modernPacket('not json')],
		['invalid UTF8', Buffer.from([4, 0, 2, 0xc0, 0xaf])],
		['truncated packet', Buffer.from([4, 0])],
	])('rejects %s', async (_name, packet) => {
		await fixture((socket) => socket.end(packet))
		expect(
			(await handleServerRequest(request('status', { address: 'mc.example.com' }))).status,
		).toBe(502)
	})

	it('rejects legacy lengths above the UTF16 limit before reading a payload', async () => {
		await fixture((socket) => socket.end(Buffer.from([0xff, 0x80, 0])))
		expect(
			(
				await handleServerRequest(
					request('status', { address: 'mc.example.com', protocol: { version: 74, legacy: true } }),
				)
			).status,
		).toBe(502)
	})

	it('accepts a modern JSON string at its exact byte limit', async () => {
		const empty = JSON.stringify({ description: '' })
		const json = JSON.stringify({ description: 'x'.repeat(32767 - Buffer.byteLength(empty)) })
		expect(Buffer.byteLength(json)).toBe(32767)
		await fixture((socket) => socket.end(modernPacket(json)))
		expect(
			(await handleServerRequest(request('status', { address: 'mc.example.com' }))).status,
		).toBe(200)
	})

	it('closes a stalled status socket at the whole request deadline', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		let received!: () => void
		const onRequest = new Promise<void>((resolve) => {
			received = resolve
		})
		const connect = await fixture(() => received())
		const pending = handleServerRequest(request('status', { address: 'mc.example.com' }))
		await onRequest
		await vi.advanceTimersByTimeAsync(5000)
		expect((await pending).status).toBe(504)
		expect(connect.mock.results[0].value.destroyed).toBe(true)
	})

	it('bounds DNS resolution as part of the whole request deadline and never dials after timeout', async () => {
		vi.useFakeTimers()
		let finishDns!: (
			records: Array<{ name: string; port: number; priority: number; weight: number }>,
		) => void
		vi.mocked(serverNetwork.resolveSrv).mockImplementation(
			() =>
				new Promise((resolve) => {
					finishDns = resolve
				}),
		)
		const connect = vi.spyOn(serverNetwork, 'connect')
		const pending = handleServerRequest(request('status', { address: 'mc.example.com' }))
		await vi.advanceTimersByTimeAsync(5000)
		expect((await pending).status).toBe(504)
		finishDns([{ name: 'srv.example.com', port: 25565, priority: 0, weight: 0 }])
		await vi.advanceTimersByTimeAsync(0)
		expect(connect).not.toHaveBeenCalled()
	})

	it('cancels a request body that never finishes at the whole request deadline', async () => {
		vi.useFakeTimers()
		const cancel = vi.fn()
		const stream = new ReadableStream<Uint8Array>({ cancel })
		const stalled = new Request('https://relay.example/server/status', {
			method: 'POST',
			body: stream,
			duplex: 'half',
		} as RequestInit)
		const pending = handleServerRequest(stalled)
		await vi.advanceTimersByTimeAsync(5000)
		expect((await pending).status).toBe(504)
		expect(cancel).toHaveBeenCalledOnce()
		expect(serverNetwork.lookup).not.toHaveBeenCalled()
	})
})
