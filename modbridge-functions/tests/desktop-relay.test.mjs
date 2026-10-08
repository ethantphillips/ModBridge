import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	createRelayUrlResolver,
	rewriteServiceUrls,
} from '../../apps/app-frontend/src/helpers/relay.ts'
import { XHRUploadClient } from '../../packages/api-client/src/platform/xhr-upload-client.ts'
import { GenericWebSocketClient } from '../../packages/api-client/src/platform/websocket-generic.ts'
import { matchRoute } from '../src/relay/routing.ts'

const relay = 'https://relay.modbridge.internal'
const resolveUrl = createRelayUrlResolver(`${relay}/`)

class RecordingClient extends XHRUploadClient {
	requests = []

	async executeRequest(url) {
		this.requests.push(url)
		return {}
	}

	async executeStreamRequest(url) {
		this.requests.push(url)
		return new ReadableStream()
	}

	async executeXHRUpload(context) {
		this.requests.push(context.url)
		return {}
	}
}

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
	vi.resetModules()
})

describe('WebSocket reconnects and diagnostics', () => {
	function stubWebSockets() {
		const sockets = []
		class StubWebSocket {
			static CONNECTING = 0
			static OPEN = 1
			static CLOSED = 3

			constructor(url) {
				this.url = url
				this.readyState = StubWebSocket.CONNECTING
				sockets.push(this)
			}

			send = vi.fn()
			close = vi.fn(() => {
				this.readyState = StubWebSocket.CLOSED
			})
		}
		vi.stubGlobal('WebSocket', StubWebSocket)
		return sockets
	}

	const auth = {
		url: 'wss://ashburn1.nodes.modrinth.com/socket?token=node-secret',
		token: 'node-auth-secret',
	}

	it('omits credentials, query tokens, and fragments from connection error diagnostics', async () => {
		const sockets = stubWebSockets()
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
		const client = new RecordingClient({
			resolveWebSocketUrl: () =>
				'wss://user:password@relay.modbridge.internal/nodes/server/socket?relay_token=relay-secret&token=node-secret#fragment',
		})
		const websocket = new GenericWebSocketClient(client)
		const connection = websocket.connect('server', auth)
		const failure = expect(connection).rejects.toThrow('WebSocket connection failed')
		sockets[0].onerror({ type: 'error' })
		await failure
		expect(errorLog).toHaveBeenCalledWith('[WebSocket] Error for server server:', {
			url: 'wss://relay.modbridge.internal/nodes/server/socket',
			readyState: 0,
			readyStateLabel: 'CONNECTING',
			type: 'error',
		})
		expect(JSON.stringify(errorLog.mock.calls)).not.toMatch(/secret|password|fragment/)
		websocket.disconnectAll()
	})

	it('stops after ten failed reconnects even when sockets open before authentication fails', async () => {
		vi.useFakeTimers()
		vi.spyOn(Math, 'random').mockReturnValue(0)
		vi.spyOn(console, 'error').mockImplementation(() => {})
		vi.spyOn(console, 'debug').mockImplementation(() => {})
		const sockets = stubWebSockets()
		const websocket = new GenericWebSocketClient(new RecordingClient({ resolveUrl }))
		const initial = websocket.connect('server', auth).catch(() => {})

		for (let attempt = 0; attempt <= 10; attempt++) {
			const socket = sockets[attempt]
			socket.readyState = WebSocket.OPEN
			socket.onopen()
			socket.readyState = WebSocket.CLOSED
			socket.onclose({ code: 1006, reason: '', wasClean: false })
			if (attempt < 10) {
				expect(websocket.getStatus('server')?.reconnectAttempts).toBe(attempt + 1)
				await vi.advanceTimersByTimeAsync(Math.min(1000 * 2 ** (attempt + 1), 30000))
				expect(sockets).toHaveLength(attempt + 2)
			}
		}

		await initial
		expect(websocket.getStatus('server')).toBeNull()
		await vi.advanceTimersByTimeAsync(60000)
		expect(sockets).toHaveLength(11)
		expect(vi.getTimerCount()).toBe(0)
	})

	it('resets the retry budget only after a reconnect authenticates', async () => {
		vi.useFakeTimers()
		vi.spyOn(Math, 'random').mockReturnValue(0)
		vi.spyOn(console, 'debug').mockImplementation(() => {})
		const sockets = stubWebSockets()
		const websocket = new GenericWebSocketClient(new RecordingClient({ resolveUrl }))
		const initial = websocket.connect('server', auth).catch(() => {})
		sockets[0].readyState = WebSocket.CLOSED
		sockets[0].onclose({ code: 1006, reason: '', wasClean: false })
		await vi.advanceTimersByTimeAsync(2000)
		sockets[1].readyState = WebSocket.OPEN
		sockets[1].onopen()
		expect(websocket.getStatus('server')).toEqual({
			connected: false,
			reconnecting: true,
			reconnectAttempts: 1,
		})
		sockets[1].onmessage({ data: JSON.stringify({ event: 'auth-ok' }) })
		expect(websocket.getStatus('server')).toEqual({
			connected: true,
			reconnecting: false,
			reconnectAttempts: 0,
		})
		await initial
		websocket.disconnectAll()
		expect(vi.getTimerCount()).toBe(0)
	})
})

describe('desktop Relay URL policy', () => {
	it.each([
		['https://api.modrinth.com/v3/project/sodium', '/api/v3/project/sodium'],
		['https://cdn.modrinth.com/icon.png?q=small', '/cdn/icon.png?q=small'],
		['https://staging-cdn.modrinth.com/icon.png', '/staging-cdn/icon.png'],
		['http://textures.minecraft.net/texture/skin', '/minecraft/textures/texture/skin'],
		['https://launcher-files.modrinth.com/steve.png', '/launcher-files/steve.png'],
		['https://archon.modrinth.com/v1/servers', '/archon/v1/servers'],
		['https://shared-instances.modrinth.com/v1/instances', '/shared-instances/v1/instances'],
		['https://fill.papermc.io/v3/projects/paper', '/paper/v3/projects/paper'],
		['https://api.purpurmc.org/v2/purpur', '/purpur/v2/purpur'],
		['https://api.mclo.gs/1/log', '/mclogs/1/log'],
		['https://flagcdn.com/us.svg', '/flags/us.svg'],
		['https://avatars3.githubusercontent.com/u/1', '/github-avatars3/u/1'],
		[
			'https://ashburn1.nodes.modrinth.com/modrinth/v0/fs/download?token=node-secret',
			'/nodes/ashburn1.nodes.modrinth.com/modrinth/v0/fs/download?token=node-secret',
		],
	])('routes %s through Relay', (upstream, path) => {
		const routed = resolveUrl(upstream)
		expect(routed).toBe(`${relay}${path}`)
		const matched = matchRoute(new URL(routed).pathname)
		expect(matched?.target.upstreamHost).toBe(new URL(upstream).hostname)
	})

	it.each([
		`${relay}/cdn/already.png`,
		'wss://relay.modbridge.internal/socket',
		'asset://localhost/screenshot.png',
		'http://asset.localhost/screenshot.png',
		'data:image/png;base64,AA==',
		'blob:https://tauri.localhost/preview',
		'/assets/translation.json',
	])('preserves approved or local URL %s', (url) => {
		expect(resolveUrl(url)).toBe(url)
	})

	it.each([
		'https://api.modrinth.com.evil.test/v3/user',
		'https://unapproved.test/icon.png',
		'https://api.modrinth.com:8443/v3/user',
		'https://user:password@api.modrinth.com/v3/user',
		'https://constructor/image.png',
		'wss://node.modrinth.com/socket',
		'ftp://api.modrinth.com/icon.png',
	])('blocks unsupported service URL %s', (url) => {
		expect(() => resolveUrl(url)).toThrow()
	})

	it.each(['ftp://relay.test', 'https://relay.test?token=secret', 'https://user@relay.test'])(
		'rejects invalid configured Relay URL %s',
		(url) => expect(() => createRelayUrlResolver(url)).toThrow(),
	)

	it('confines URLs to the configured Relay path', () => {
		const nested = createRelayUrlResolver(`${relay}/nested/`)
		expect(nested(`${relay}/nested/cdn/icon.png`)).toBe(`${relay}/nested/cdn/icon.png`)
		expect(() => nested(`${relay}/nested-other/cdn/icon.png`)).toThrow()
	})

	it('routes friends and hosting sockets through the Relay WebSocket origin', () => {
		expect(resolveUrl('wss://api.modrinth.com/v3/events')).toBe(
			'wss://relay.modbridge.internal/api/v3/events',
		)
		expect(resolveUrl('wss://ashburn1.nodes.modrinth.com/pingtest')).toBe(
			'wss://relay.modbridge.internal/nodes/ashburn1.nodes.modrinth.com/pingtest',
		)
		expect(resolveUrl('wss://ashburn1.us.nodes.modrinth.com/pingtest')).toBe(
			'wss://relay.modbridge.internal/nodes/ashburn1.us.nodes.modrinth.com/pingtest',
		)
		expect(() => resolveUrl('wss://ashburn1.nodes.modrinth.com.evil.test/pingtest')).toThrow()
		expect(() => resolveUrl('wss://ashburn1.nodes.modrinth.com:8443/pingtest')).toThrow()
	})

	it('rewrites nested cached resources and Markdown without changing navigation links', () => {
		const input = {
			icon_url: 'https://cdn.modrinth.com/icon.png',
			body: '![Preview](http://textures.minecraft.net/texture/skin) [Source](https://github.com/a/b)',
			users: [{ avatar_url: 'https://cdn.modrinth.com/avatar.png' }],
		}
		const output = rewriteServiceUrls(input, resolveUrl)
		expect(output).toEqual({
			icon_url: `${relay}/cdn/icon.png`,
			body: `![Preview](${relay}/minecraft/textures/texture/skin) [Source](https://github.com/a/b)`,
			users: [{ avatar_url: `${relay}/cdn/avatar.png` }],
		})
		expect(input.icon_url).toBe('https://cdn.modrinth.com/icon.png')
	})

	it('uses the canonical Relay auth token for requests and browser media', async () => {
		vi.stubEnv('MODBRIDGE_RELAY_BASE_URL', relay)
		vi.stubEnv('MODBRIDGE_RELAY_AUTH_TOKEN', 'relay-secret')
		vi.stubEnv('MODBRIDGE_RELAY_TOKEN', 'legacy-secret')
		const config = await import('../../apps/app-frontend/src/config.ts')
		expect(config.relayHeaders).toEqual({ 'X-Modbridge-Token': 'relay-secret' })
		expect(config.resolveRelayUrl('https://cdn.modrinth.com/icon.png')).toBe(
			`${relay}/cdn/icon.png`,
		)
		const imageUrl = config.resolveRelayMediaUrl('https://cdn.modrinth.com/icon.png?size=128')
		expect(new URL(imageUrl).searchParams.get('relay_token')).toBe('relay-secret')
		expect(new URL(imageUrl).searchParams.get('size')).toBe('128')
		expect(config.resolveRelayMediaUrl(imageUrl)).toBe(imageUrl)
		expect(config.resolveRelayMediaUrl('blob:https://tauri.localhost/preview')).toBe(
			'blob:https://tauri.localhost/preview',
		)
		const socketUrl = config.resolveRelayWebSocketUrl(
			'wss://ashburn1.nodes.modrinth.com/modrinth/v0/ws?token=node-secret',
		)
		expect(new URL(socketUrl).origin).toBe('wss://relay.modbridge.internal')
		expect(new URL(socketUrl).pathname).toBe('/nodes/ashburn1.nodes.modrinth.com/modrinth/v0/ws')
		expect(new URL(socketUrl).searchParams.get('token')).toBe('node-secret')
		expect(new URL(socketUrl).searchParams.get('relay_token')).toBe('relay-secret')
	})
})

describe('client transport policy', () => {
	it('routes requests, streams, and uploads after middleware changes their destination', async () => {
		const client = new RecordingClient({
			resolveUrl,
			features: [
				{
					shouldApply: () => true,
					execute: (next, context) => {
						context.url = 'https://api.mclo.gs/1/log'
						return next()
					},
				},
			],
		})
		await client.request('/log', { api: 'labrinth', version: 1 })
		await client.stream('/log', { api: 'labrinth', version: 1 })
		await client.upload('/log', { api: 'labrinth', version: 1, file: new Blob(['log']) }).promise
		expect(client.requests).toEqual(Array(3).fill(`${relay}/mclogs/1/log`))
	})

	it('rejects unsupported HTTP, upload, and socket destinations before transport starts', async () => {
		const client = new RecordingClient({ resolveUrl })
		await expect(
			client.request('/user', { api: 'https://unapproved.test', version: 1 }),
		).rejects.toThrow()
		await expect(
			client.upload('/file', {
				api: 'https://unapproved.test',
				version: 1,
				file: new Blob(['file']),
			}).promise,
		).rejects.toThrow()
		const socket = vi.fn()
		vi.stubGlobal('WebSocket', socket)
		await expect(
			new GenericWebSocketClient(client).connect('server', {
				url: 'wss://node.modrinth.com/socket',
				token: 'node-token',
			}),
		).rejects.toThrow()
		expect(client.requests).toEqual([])
		expect(socket).not.toHaveBeenCalled()
	})

	it('keeps generic website behavior and media policy separate from request URLs', () => {
		const generic = new RecordingClient({})
		expect(generic.resolveUrl('https://external.test')).toBe('https://external.test')
		expect(generic.allowExternalEmbeds).toBe(true)
		const restricted = new RecordingClient({
			resolveUrl,
			resolveMediaUrl: (url) => `${resolveUrl(url)}?token=media-secret`,
			allowExternalEmbeds: false,
		})
		expect(restricted.resolveUrl('https://cdn.modrinth.com/icon.png')).toBe(`${relay}/cdn/icon.png`)
		expect(restricted.resolveMediaUrl('https://cdn.modrinth.com/icon.png')).toBe(
			`${relay}/cdn/icon.png?token=media-secret`,
		)
		expect(restricted.allowExternalEmbeds).toBe(false)
	})
})
