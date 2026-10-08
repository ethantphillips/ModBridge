import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createRelayUrlResolver } from '../../apps/app-frontend/src/helpers/relay'
import { AbstractFeature } from '../../packages/api-client/src/core/abstract-feature'
import { AuthFeature } from '../../packages/api-client/src/features/auth'
import { NodeAuthFeature } from '../../packages/api-client/src/features/node-auth'
import { GenericModrinthClient } from '../../packages/api-client/src/platform/generic'
import {
	type TauriClientConfig,
	TauriModrinthClient,
} from '../../packages/api-client/src/platform/tauri'
import type { RequestContext } from '../../packages/api-client/src/types/request'
import { isRelayUrl, routeModrinthApiUrl } from '../../packages/api-client/src/utils/relay'
import { useServerWorldDownload } from '../../packages/ui/src/composables/server-download'

const { nativeFetch, injectClient, injectPageContext } = vi.hoisted(() => ({
	nativeFetch: vi.fn(),
	injectClient: vi.fn(),
	injectPageContext: vi.fn(),
}))
vi.mock('../../packages/api-client/node_modules/@tauri-apps/plugin-http/dist-js/index.js', () => ({
	fetch: nativeFetch,
}))
vi.mock('../../packages/ui/src/providers/api-client', () => ({
	injectModrinthClient: injectClient,
}))
vi.mock('../../packages/ui/src/providers/page-context', () => ({ injectPageContext }))
vi.mock('../../packages/ui/src/providers/web-notifications', () => ({
	injectNotificationManager: () => ({ addNotification: vi.fn() }),
}))
vi.mock('../../packages/ui/src/composables/i18n', () => ({
	defineMessages: (messages: unknown) => messages,
	useVIntl: () => ({ formatMessage: () => 'Download failed' }),
}))

const RELAY = 'https://relay.modbridge.internal'

function createClient(features: AbstractFeature[] = [], config: TauriClientConfig = {}) {
	return new TauriModrinthClient({
		relayBaseUrl: RELAY,
		relayAuthToken: 'relay-secret',
		features,
		...config,
	})
}

beforeEach(() => {
	nativeFetch.mockReset().mockImplementation(async () => Response.json({ id: 'sodium' }))
	injectPageContext.mockReset().mockReturnValue(null)
})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('Desktop API relay routing', () => {
	it.each([
		['https://api.modrinth.com/v2/search?query=sodium', '/api/v2/search?query=sodium'],
		['https://staging-api.modrinth.com/v3/user', '/staging-api/v3/user'],
		['https://archon.modrinth.com/modrinth/v0/servers', '/archon/modrinth/v0/servers'],
		[
			'https://staging-archon.modrinth.com/modrinth/v0/servers',
			'/staging-archon/modrinth/v0/servers',
		],
		['https://shared-instances.modrinth.com/v1/instances', '/shared-instances/v1/instances'],
		[
			'https://staging-shared-instances.modrinth.com/v1/instances',
			'/staging-shared-instances/v1/instances',
		],
		[
			'https://launcher-meta.modrinth.com/fabric/v0/manifest.json',
			'/launcher-meta/fabric/v0/manifest.json',
		],
		[
			'https://eu1.nodes.modrinth.com/modrinth/v0/fs/list',
			'/nodes/eu1.nodes.modrinth.com/modrinth/v0/fs/list',
		],
		[
			'https://node-xyz.modrinth.com/modrinth/v0/fs/list',
			'/nodes/node-xyz.modrinth.com/modrinth/v0/fs/list',
		],
	])('routes %s through the matching relay endpoint', (upstream, expected) => {
		expect(routeModrinthApiUrl(upstream, `${RELAY}/`)).toBe(`${RELAY}${expected}`)
	})

	it.each([
		'https://api.modrinth.com.evil.example/v2/user',
		'https://eu1.nodes.modrinth.com.evil.example/modrinth/v0/fs/list',
		'https://nodes.modrinth.com/modrinth/v0/fs/list',
		'https://node-xyz.modrinth.com:8443/modrinth/v0/fs/list',
		'https://node-.modrinth.com/modrinth/v0/fs/list',
		'https://node-xyz-.modrinth.com/modrinth/v0/fs/list',
		`https://${'a'.repeat(64)}.nodes.modrinth.com/modrinth/v0/fs/list`,
		'https://github.com/issues',
		'/modrinth/v0/fs/list',
	])('leaves unrelated or unapproved URLs unchanged: %s', (url) => {
		expect(routeModrinthApiUrl(url, RELAY)).toBe(url)
		expect(isRelayUrl(url, RELAY)).toBe(false)
	})

	it('uses the relay for configured modules and preserves upstream authentication', async () => {
		await createClient([new AuthFeature({ token: 'upstream-session' })]).labrinth.projects_v2.get(
			'sodium',
		)
		expect(nativeFetch).toHaveBeenCalledWith(
			`${RELAY}/api/v2/project/sodium`,
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: 'Bearer upstream-session',
					'X-Modbridge-Token': 'relay-secret',
				}),
				redirect: 'error',
			}),
		)
	})

	it('routes the hardcoded geoip URL used during startup', async () => {
		nativeFetch.mockResolvedValue(
			new Response('fl=example\nloc=US\n', {
				headers: { 'content-type': 'text/plain' },
			}),
		)
		expect(await createClient().labrinth.geoip.getCountry()).toBe('US')
		expect(nativeFetch.mock.calls[0][0]).toBe(`${RELAY}/api/cdn-cgi/trace`)
	})

	it('keeps an already routed URL stable', async () => {
		await createClient([], { labrinthBaseUrl: `${RELAY}/api` }).request('/user', {
			api: 'labrinth',
			version: 2,
		})
		expect(nativeFetch.mock.calls[0][0]).toBe(`${RELAY}/api/v2/user`)
	})

	it.each([
		['labrinth', 'labrinthBaseUrl', '/api'],
		['archon', 'archonBaseUrl', '/archon'],
		['sharedinstances', 'sharedInstancesBaseUrl', '/shared-instances'],
	])(
		'routes configured %s service origins with base paths through the relay',
		async (api, configKey, prefix) => {
			const client = createClient([], { [configKey]: 'http://127.0.0.1:8000/custom-api' })
			await client.request('/user', { api, version: 2 })
			expect(nativeFetch.mock.calls[0][0]).toBe(`${RELAY}${prefix}/v2/user`)
			expect(nativeFetch.mock.calls[0][1].headers).toHaveProperty(
				'X-Modbridge-Token',
				'relay-secret',
			)
		},
	)

	it('matches configured callback origins for hardcoded module URLs', async () => {
		await createClient([], { labrinthBaseUrl: () => 'http://127.0.0.1:8000/custom-api' }).request(
			'/user',
			{
				api: 'http://127.0.0.1:8000/custom-api',
				version: 2,
			},
		)
		expect(nativeFetch.mock.calls[0][0]).toBe(`${RELAY}/api/v2/user`)
	})

	it('matches the most specific configured service base path', async () => {
		await createClient([], {
			labrinthBaseUrl: 'http://127.0.0.1:8000',
			archonBaseUrl: 'http://127.0.0.1:8000/hosting',
		}).request('/servers', { api: 'archon', version: 1 })
		expect(nativeFetch.mock.calls[0][0]).toBe(`${RELAY}/archon/v1/servers`)
	})

	it('normalizes configured service origins before applying the app transport policy', async () => {
		await createClient([], {
			labrinthBaseUrl: 'http://127.0.0.1:8000/custom-api',
			resolveUrl: createRelayUrlResolver(RELAY),
		}).labrinth.projects_v2.get('sodium')
		expect(nativeFetch.mock.calls[0][0]).toBe(`${RELAY}/api/v2/project/sodium`)
	})

	it('preserves staging namespace priority over configured service origins', async () => {
		await createClient([], {
			labrinthBaseUrl: 'https://staging-api.modrinth.com',
		}).labrinth.projects_v2.get('sodium')
		expect(nativeFetch.mock.calls[0][0]).toBe(`${RELAY}/staging-api/v2/project/sodium`)
	})

	it.each([
		'http://127.0.0.1:8000/unrelated-api',
		'http://127.0.0.1:8000/custom-api-lookalike',
		'http://127.0.0.1:8001/custom-api',
	])('preserves unrelated custom module URLs: %s', async (api) => {
		await createClient([], { labrinthBaseUrl: 'http://127.0.0.1:8000/custom-api' }).request(
			'/status',
			{
				api,
				version: 1,
			},
		)
		expect(nativeFetch.mock.calls[0][0]).toBe(`${api}/v1/status`)
		expect(nativeFetch.mock.calls[0][1].headers).not.toHaveProperty('X-Modbridge-Token')
	})

	it('routes absolute request URLs while retaining query parameters', async () => {
		await createClient().request('https://api.modrinth.com/v2/search?query=sodium', {
			api: 'labrinth',
			version: 2,
			params: { limit: 1 },
		})
		expect(nativeFetch.mock.calls[0][0]).toBe(`${RELAY}/api/v2/search?query=sodium&limit=1`)
	})

	it('routes URLs supplied by a feature immediately before transport', async () => {
		class CustomUrlFeature extends AbstractFeature {
			async execute<T>(next: () => Promise<T>, context: RequestContext): Promise<T> {
				context.url = 'https://api.modrinth.com/v3/user'
				return next()
			}
		}
		await createClient([new CustomUrlFeature()]).request('/user', { api: RELAY, version: 3 })
		expect(nativeFetch.mock.calls[0][0]).toBe(`${RELAY}/api/v3/user`)
	})

	it('routes authenticated node requests after the auth feature builds their URL', async () => {
		const nodeAuth = new NodeAuthFeature({
			getAuth: () => ({ url: 'eu1.nodes.modrinth.com/modrinth/v0/fs', token: 'node-jwt' }),
			refreshAuth: async () => {},
		})
		await createClient([nodeAuth]).kyros.files_v0.listDirectory('/')
		expect(nativeFetch.mock.calls[0][0]).toBe(
			`${RELAY}/nodes/eu1.nodes.modrinth.com/modrinth/v0/fs/list?path=%2F&page=1&page_size=100`,
		)
		expect(nativeFetch.mock.calls[0][1].headers).toMatchObject({
			Authorization: 'Bearer node-jwt',
			'X-Modbridge-Token': 'relay-secret',
		})
	})

	it('routes stream requests through the relay with separate authentication', async () => {
		nativeFetch.mockResolvedValue(
			new Response('event: update\ndata: {}\n\n', {
				headers: { 'content-type': 'text/event-stream' },
			}),
		)
		const stream = await createClient().stream('/sync', {
			api: 'https://api.modrinth.com',
			version: 3,
			headers: { Authorization: 'Bearer upstream-session' },
		})
		expect(await new Response(stream).text()).toContain('event: update')
		expect(nativeFetch).toHaveBeenCalledWith(
			`${RELAY}/api/v3/sync`,
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: 'Bearer upstream-session',
					'X-Modbridge-Token': 'relay-secret',
				}),
				redirect: 'error',
			}),
		)
	})

	it('routes configured service streams through the relay', async () => {
		nativeFetch.mockResolvedValue(new Response('event: update\ndata: {}\n\n'))
		const client = createClient([], { archonBaseUrl: 'http://127.0.0.1:8000/hosting' })
		await client.stream('/sync', { api: 'archon', version: 1 })
		expect(nativeFetch.mock.calls[0][0]).toBe(`${RELAY}/archon/v1/sync`)
		expect(nativeFetch.mock.calls[0][1].headers).toHaveProperty('X-Modbridge-Token', 'relay-secret')
	})

	it.each(['https://api.modrinth.com', 'http://127.0.0.1:8000/custom-api'])(
		'routes uploads from %s and keeps the file and upstream auth intact',
		async (api) => {
			const uploads: Array<{ url: string; headers: Record<string, string>; body?: unknown }> = []
			class MockXHR {
				status = 200
				response = '{"uploaded":true}'
				upload = { addEventListener: vi.fn() }
				private listeners: Record<string, () => void> = {}
				private request = {
					url: '',
					headers: {} as Record<string, string>,
					body: undefined as unknown,
				}
				addEventListener(event: string, callback: () => void) {
					this.listeners[event] = callback
				}
				open(_method: string, url: string) {
					this.request.url = url
				}
				setRequestHeader(name: string, value: string) {
					this.request.headers[name] = value
				}
				send(body: unknown) {
					this.request.body = body
					uploads.push(this.request)
					queueMicrotask(() => this.listeners.load())
				}
				abort() {}
			}
			vi.stubGlobal('XMLHttpRequest', MockXHR)
			const file = new Blob(['version-content'])
			await createClient([], { labrinthBaseUrl: api }).upload('/version', {
				api,
				version: 3,
				file,
				headers: { Authorization: 'Bearer upstream-session' },
			}).promise
			expect(uploads).toEqual([
				{
					url: `${RELAY}/api/v3/version`,
					headers: {
						'Content-Type': 'application/octet-stream',
						Authorization: 'Bearer upstream-session',
						'X-Modbridge-Token': 'relay-secret',
					},
					body: file,
				},
			])
		},
	)

	it('never attaches the relay token to a host that resembles the relay', async () => {
		await createClient().request('/user', {
			api: 'https://relay.modbridge.internal.evil.example/api',
			version: 2,
		})
		expect(nativeFetch.mock.calls[0][1].headers).not.toHaveProperty('X-Modbridge-Token')
	})

	it('routes and authenticates native WebSocket URLs separately from the node JWT', () => {
		const url = createClient().resolveWebSocketUrl(
			'wss://eu1.nodes.modrinth.com/modrinth/v0/ws?foo=bar',
		)
		expect(url).toBe(
			'wss://relay.modbridge.internal/nodes/eu1.nodes.modrinth.com/modrinth/v0/ws?foo=bar&modbridge_token=relay-secret',
		)
	})

	it('routes hosting socket connections through the platform hook', async () => {
		const sockets: Array<{ url: string; send: ReturnType<typeof vi.fn> }> = []
		class MockWebSocket {
			static OPEN = 1
			static CONNECTING = 0
			readyState = 1
			send = vi.fn()
			onopen?: () => void
			onmessage?: (event: { data: string }) => void
			constructor(public url: string) {
				sockets.push(this)
				queueMicrotask(() => {
					this.onopen?.()
					this.onmessage?.({ data: '{"event":"auth-ok"}' })
				})
			}
			close() {
				this.readyState = 3
			}
		}
		vi.stubGlobal('WebSocket', MockWebSocket)
		const client = createClient()
		await client.archon.sockets.connect('server-id', {
			url: 'eu1.nodes.modrinth.com/modrinth/v0/ws',
			token: 'node-jwt',
		})
		expect(sockets[0].url).toBe(
			'wss://relay.modbridge.internal/nodes/eu1.nodes.modrinth.com/modrinth/v0/ws?modbridge_token=relay-secret',
		)
		expect(sockets[0].send).toHaveBeenCalledWith('{"event":"auth","jwt":"node-jwt"}')
		client.archon.sockets.disconnectAll()
	})

	it('preserves the relay node prefix in a world download URL', () => {
		const url = createClient().kyros.files_v1.getFullWorldDownloadUrl(
			`${RELAY}/nodes/eu1.nodes.modrinth.com`,
			'world-id',
			'world-token',
		)
		expect(url).toBe(
			`${RELAY}/nodes/eu1.nodes.modrinth.com/v1/worlds/world-id/files/download-full-zip?token=world-token`,
		)
	})

	it.each(['eu1.nodes.modrinth.com', `${RELAY}/nodes/eu1.nodes.modrinth.com`])(
		'downloads worlds through the relay with separate credentials from %s',
		async (nodeUrlHost) => {
			const assign = vi.fn()
			vi.stubGlobal('window', { location: { assign } })
			injectClient.mockReturnValue(createClient([new AuthFeature({ token: 'upstream-session' })]))
			nativeFetch.mockResolvedValue(Response.json({ token: 'world-token' }))
			await useServerWorldDownload().downloadWorldFiles(nodeUrlHost, 'world-id')
			expect(nativeFetch).toHaveBeenCalledWith(
				`${RELAY}/nodes/eu1.nodes.modrinth.com/v1/worlds/world-id/files/download-full-zip/authorize`,
				expect.objectContaining({
					headers: expect.objectContaining({
						Authorization: 'Bearer upstream-session',
						'X-Modbridge-Token': 'relay-secret',
					}),
				}),
			)
			expect(assign).toHaveBeenCalledWith(
				`${RELAY}/nodes/eu1.nodes.modrinth.com/v1/worlds/world-id/files/download-full-zip?token=world-token&modbridge_token=relay-secret`,
			)
		},
	)

	it('keeps the existing upstream token in relayed WebSocket links', () => {
		const url = createClient().resolveWebSocketUrl(
			'wss://eu1.nodes.modrinth.com/ws?token=node-token',
		)
		expect(url).toBe(
			'wss://relay.modbridge.internal/nodes/eu1.nodes.modrinth.com/ws?token=node-token&modbridge_token=relay-secret',
		)
	})

	it('saves desktop world downloads through the native file helper', async () => {
		const downloadFile = vi.fn().mockResolvedValue(true)
		injectPageContext.mockReturnValue({ downloadFile })
		injectClient.mockReturnValue(createClient())
		nativeFetch.mockResolvedValue(Response.json({ token: 'world-token' }))
		await useServerWorldDownload().downloadWorldFiles('eu1.nodes.modrinth.com', 'world-id')
		expect(downloadFile).toHaveBeenCalledWith(
			`${RELAY}/nodes/eu1.nodes.modrinth.com/v1/worlds/world-id/files/download-full-zip?token=world-token&modbridge_token=relay-secret`,
			'world-world-id.zip',
		)
	})

	it('preserves browser world-download URLs without adding relay credentials', () => {
		const client = new GenericModrinthClient({})
		const url = client.kyros.files_v1.getFullWorldDownloadUrl(
			'eu1.nodes.modrinth.com',
			'world-id',
			'world-token',
		)
		expect(client.resolveMediaUrl(url)).toBe(
			'https://eu1.nodes.modrinth.com/v1/worlds/world-id/files/download-full-zip?token=world-token',
		)
	})

	it('preserves default Tauri and generic browser behavior when relay routing is not enabled', async () => {
		await new TauriModrinthClient({}).labrinth.projects_v2.get('sodium')
		expect(nativeFetch.mock.calls[0][0]).toBe('https://api.modrinth.com/v2/project/sodium')
		expect(nativeFetch.mock.calls[0][1].headers).not.toHaveProperty('X-Modbridge-Token')
		const socket = 'wss://eu1.nodes.modrinth.com/modrinth/v0/ws'
		expect(new GenericModrinthClient({}).resolveWebSocketUrl(socket)).toBe(socket)
	})
})
