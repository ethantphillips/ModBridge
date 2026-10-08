import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	upgradeWebSocket: vi.fn(),
	resolvePublicHost: vi.fn(),
	connections: [] as any[],
}))
vi.mock('@neon/functions', () => ({ upgradeWebSocket: mocks.upgradeWebSocket }))
vi.mock('../src/relay/server-status.js', () => ({
	resolvePublicHost: mocks.resolvePublicHost,
	handleServerRequest: vi.fn(),
}))
vi.mock('ws', async () => {
	const { EventEmitter } = await import('node:events')
	class MockUpstream extends EventEmitter {
		static CONNECTING = 0
		static OPEN = 1
		static CLOSING = 2
		static CLOSED = 3
		readyState = 0
		bufferedAmount = 0
		protocol = ''
		send = vi.fn((_frame: unknown, _options: unknown, callback?: (error?: Error) => void) =>
			callback?.(),
		)
		ping = vi.fn((_data: unknown, _mask: unknown, callback?: (error?: Error) => void) =>
			callback?.(),
		)
		close = vi.fn(() => {
			this.readyState = 3
		})
		terminate = vi.fn(() => {
			this.readyState = 3
		})
		constructor(
			public url: URL,
			public protocols: string[],
			public options: unknown,
		) {
			super()
			mocks.connections.push(this)
			queueMicrotask(() => {
				this.readyState = 1
				this.emit('open')
			})
		}
	}
	return { default: MockUpstream }
})

import relay from '../src/relay/index.js'

class Downstream extends EventTarget {
	readyState = 0
	bufferedAmount = 0
	binaryType = 'blob'
	send = vi.fn()
	close = vi.fn((code = 1000, reason = '') => {
		this.readyState = 3
		this.dispatchEvent(Object.assign(new Event('close'), { code, reason }))
	})
	open() {
		this.readyState = 1
		this.dispatchEvent(new Event('open'))
	}
	message(data: unknown) {
		this.dispatchEvent(new MessageEvent('message', { data }))
	}
	get socket() {
		return this as unknown as WebSocket
	}
}

let client: Downstream
let upgradeResponse: Response

beforeEach(() => {
	vi.stubEnv('MODBRIDGE_RELAY_SECRET', 'relay-secret')
	mocks.connections.length = 0
	mocks.resolvePublicHost.mockReset().mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
	client = new Downstream()
	upgradeResponse = { status: 101 } as Response
	mocks.upgradeWebSocket
		.mockReset()
		.mockReturnValue({ socket: client.socket, response: upgradeResponse })
})

afterEach(() => {
	client.close()
	for (const upstream of mocks.connections) upstream.terminate()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
	vi.useRealTimers()
	vi.clearAllMocks()
})

describe('WebSocket relay handler upgrades', () => {
	it('authenticates before upgrading and returns the native upgrade response unchanged', async () => {
		const request = new Request(
			'https://relay.test/api/_internal/launcher_socket?code=user-session&token=relay-secret',
			{ headers: { Upgrade: 'websocket' } },
		)
		expect(await relay.fetch(request)).toBe(upgradeResponse)
		expect(mocks.upgradeWebSocket).toHaveBeenCalledWith(request, { protocol: undefined })
		expect(mocks.connections[0].url.href).toBe(
			'wss://api.modrinth.com/_internal/launcher_socket?code=user-session',
		)
	})

	it('refuses unauthorized handshakes before DNS resolution or any upstream connection', async () => {
		const response = await relay.fetch(
			new Request('https://relay.test/api/_internal/launcher_socket?code=user-session', {
				headers: { Upgrade: 'websocket' },
			}),
		)
		expect(response.status).toBe(401)
		expect(mocks.upgradeWebSocket).not.toHaveBeenCalled()
		expect(mocks.resolvePublicHost).not.toHaveBeenCalled()
		expect(mocks.connections).toHaveLength(0)
	})

	it.each(['/api/v3/search', '/archon/ws', '/cdn/data/file'])(
		'refuses unsupported socket route %s',
		async (path) => {
			const response = await relay.fetch(
				new Request(`https://relay.test${path}?token=relay-secret`, {
					headers: { Upgrade: 'websocket' },
				}),
			)
			expect(response.status).toBe(404)
			expect(mocks.upgradeWebSocket).not.toHaveBeenCalled()
			expect(mocks.resolvePublicHost).not.toHaveBeenCalled()
			expect(mocks.connections).toHaveLength(0)
		},
	)

	it.each(['node-test.modrinth.com', 'node-test.nodes.modrinth.com'])(
		'bridges a server socket only to an approved Modrinth node %s',
		async (host) => {
			expect(
				await relay.fetch(
					new Request(`https://relay.test/nodes/${host}/ws?token=relay-secret`, {
						headers: { Upgrade: 'websocket' },
					}),
				),
			).toBe(upgradeResponse)
			expect(mocks.connections[0].url.href).toBe(`wss://${host}/ws`)
		},
	)

	it.each(['/api', '/ws'])(
		'accepts dedicated relay auth on %s while preserving upstream credentials',
		async (prefix) => {
			const request = new Request(
				`https://relay.test${prefix}/_internal/launcher_socket?code=user-session&token=upstream-token&modbridge_token=relay-secret`,
				{ headers: { Upgrade: 'websocket' } },
			)
			expect(await relay.fetch(request)).toBe(upgradeResponse)
			expect(mocks.connections[0].url.href).toBe(
				'wss://api.modrinth.com/_internal/launcher_socket?code=user-session&token=upstream-token',
			)
		},
	)

	it('requests an upgrade for the friends route instead of sending an HTTP request upstream', async () => {
		const response = await relay.fetch(
			new Request('https://relay.test/api/_internal/launcher_socket?modbridge_token=relay-secret'),
		)
		expect(response.status).toBe(426)
		expect(mocks.resolvePublicHost).not.toHaveBeenCalled()
		expect(mocks.connections).toHaveLength(0)
	})
})

describe('WebSocket forwarding and lifecycle', () => {
	const connected = async () => {
		await relay.fetch(
			new Request('https://relay.test/api/_internal/launcher_socket?modbridge_token=relay-secret', {
				headers: { Upgrade: 'websocket' },
			}),
		)
		return mocks.connections[0]
	}

	it('buffers upstream greetings until the client opens and forwards text and binary in both directions', async () => {
		const upstream = await connected()
		upstream.emit('message', Buffer.from('notification'), false)
		expect(client.send).not.toHaveBeenCalled()
		client.open()
		expect(client.send).toHaveBeenCalledWith('notification')
		client.message('session-auth')
		expect(upstream.send.mock.calls[0].slice(0, 2)).toEqual(['session-auth', { binary: false }])
		client.message(new Uint8Array([1, 2, 3]).buffer)
		expect(upstream.send.mock.calls[1].slice(0, 2)).toEqual([
			new Uint8Array([1, 2, 3]),
			{ binary: true },
		])
		upstream.emit('message', Buffer.from([4, 5, 255]), true)
		expect(client.send).toHaveBeenCalledWith(new Uint8Array([4, 5, 255]))
		client.close(4001, 'logout')
		expect(upstream.close).toHaveBeenCalledWith(4001, 'logout')
	})

	it('closes both connections on upstream error', async () => {
		const upstream = await connected()
		upstream.emit('error', new Error('connection lost'))
		expect(client.close).toHaveBeenCalledWith(1011, 'WebSocket connection failed')
		expect(upstream.close).toHaveBeenCalledWith(1011, 'WebSocket connection failed')
	})

	it('bounds individual messages instead of accumulating oversized frames', async () => {
		const upstream = await connected()
		client.open()
		client.message(new Uint8Array(4 * 1024 * 1024 + 1).buffer)
		expect(client.close).toHaveBeenCalledWith(1009, 'Relay message limit exceeded')
		expect(upstream.close).toHaveBeenCalledWith(1009, 'Relay message limit exceeded')
		expect(upstream.send).not.toHaveBeenCalled()
	})

	it('terminates stalled downstream handshakes and clears the bridge heartbeat', async () => {
		vi.useFakeTimers()
		const upstream = await connected()
		await vi.advanceTimersByTimeAsync(10_000)
		expect(client.close).toHaveBeenCalledWith(1011, 'Relay handshake timed out')
		expect(upstream.close).toHaveBeenCalledWith(1011, 'Relay handshake timed out')
		await vi.advanceTimersByTimeAsync(1_000)
		expect(vi.getTimerCount()).toBe(0)
	})

	it('bounds queued empty frames as well as bytes', async () => {
		const upstream = await connected()
		for (let i = 0; i <= 128; i++) upstream.emit('message', Buffer.alloc(0), false)
		expect(client.close).toHaveBeenCalledWith(1009, 'Relay message limit exceeded')
	})

	it('rejects messages from a disconnected upstream without keeping a queue', async () => {
		const upstream = await connected()
		client.open()
		upstream.readyState = 0
		client.message('session-auth')
		expect(client.close).toHaveBeenCalledWith(1011, 'Upstream WebSocket disconnected')
		expect(upstream.terminate).toHaveBeenCalled()
		expect(upstream.send).not.toHaveBeenCalled()
	})
})
