import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import relay from '../src/relay/index.js'
import { fetchAllowlisted } from '../src/shared/fetch.js'
import { sanitizeRequestHeaders } from '../src/shared/headers.js'
import { rewriteJsonContent } from '../src/relay/rewrite.js'
import { isAllowedNodeHost, matchRoute } from '../src/relay/routing.js'
import { serverNetwork } from '../src/relay/server-status.js'

const origin = 'https://relay.modbridge.internal'
const allowedHosts = new Set(['api.modrinth.com', 'cdn.modrinth.com'])

beforeEach(() => {
	vi.stubEnv('MODBRIDGE_RELAY_SECRET', '')
	vi.stubEnv('MODBRIDGE_RELAY_TOKEN', '')
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})

describe('Relay-only request policy', () => {
	it('authenticates server probes before any DNS lookup or TCP connection', async () => {
		vi.stubEnv('MODBRIDGE_RELAY_SECRET', 'relay-secret')
		const lookupSpy = vi
			.spyOn(serverNetwork, 'lookup')
			.mockRejectedValue(new Error('Unexpected DNS lookup'))
		const connectSpy = vi.spyOn(serverNetwork, 'connect').mockImplementation(() => {
			throw new Error('Unexpected connection')
		})
		const response = await relay.fetch(
			new Request(`${origin}/server/status`, {
				method: 'POST',
				body: JSON.stringify({ address: 'play.example.com' }),
			}),
		)
		expect(response.status).toBe(401)
		expect(lookupSpy).not.toHaveBeenCalled()
		expect(connectSpy).not.toHaveBeenCalled()
	})

	it('dispatches server endpoints on the Relay host with POST-only semantics', async () => {
		const response = await relay.fetch(new Request(`${origin}/server/resolve`))
		expect(response.status).toBe(405)
	})

	it('checks Relay authentication before an upstream WebSocket connection', async () => {
		vi.stubEnv('MODBRIDGE_RELAY_SECRET', 'relay-secret')
		const lookupSpy = vi
			.spyOn(serverNetwork, 'lookup')
			.mockRejectedValue(new Error('Unexpected DNS lookup'))
		const response = await relay.fetch(
			new Request(`${origin}/api/_internal/launcher_socket?code=account-secret`, {
				headers: { upgrade: 'websocket' },
			}),
		)
		expect(response.status).toBe(401)
		expect(lookupSpy).not.toHaveBeenCalled()
	})

	it('requires an upgrade for socket endpoints and rejects unrelated upgrade routes', async () => {
		const fetchSpy = vi.fn()
		vi.stubGlobal('fetch', fetchSpy)
		const plain = await relay.fetch(new Request(`${origin}/api/_internal/launcher_socket`))
		expect(plain.status).toBe(426)
		const unrelated = await relay.fetch(
			new Request(`${origin}/api/v3/user`, { headers: { upgrade: 'websocket' } }),
		)
		expect(unrelated.status).toBe(404)
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it('authenticates Relay requests while preserving upstream account credentials', async () => {
		vi.stubEnv('MODBRIDGE_RELAY_SECRET', 'relay-secret')
		const fetchSpy = vi
			.fn()
			.mockResolvedValue(new Response('{}', { headers: { 'content-type': 'application/json' } }))
		vi.stubGlobal('fetch', fetchSpy)
		const response = await relay.fetch(
			new Request(`${origin}/api/v3/user?token=relay-secret`, {
				headers: {
					'x-modbridge-token': 'relay-secret',
					authorization: 'Bearer account-secret',
					referer: `${origin}/?token=relay-secret`,
				},
			}),
		)
		expect(response.status).toBe(200)
		expect(fetchSpy.mock.calls[0][0]).toBe('https://api.modrinth.com/v3/user')
		const headers = fetchSpy.mock.calls[0][1].headers as Headers
		expect(headers.get('x-modbridge-token')).toBeNull()
		expect(headers.get('referer')).toBeNull()
		expect(headers.get('authorization')).toBe('Bearer account-secret')
	})

	it('removes a Relay bearer credential instead of disclosing it upstream', () => {
		vi.stubEnv('MODBRIDGE_RELAY_SECRET', 'relay-secret')
		const headers = sanitizeRequestHeaders(
			new Headers({ authorization: 'Bearer relay-secret', 'x-modbridge-token': 'relay-secret' }),
			'api.modrinth.com',
		)
		expect(headers.get('authorization')).toBeNull()
		expect(headers.get('x-modbridge-token')).toBeNull()
	})

	it('keeps upstream query authentication separate from Relay query authentication', async () => {
		vi.stubEnv('MODBRIDGE_RELAY_SECRET', 'relay-secret')
		const fetchSpy = vi.fn().mockResolvedValue(new Response('ok'))
		vi.stubGlobal('fetch', fetchSpy)
		const response = await relay.fetch(
			new Request(
				`${origin}/nodes/eu-01.nodes.modrinth.com/download?token=node-secret&relay_token=relay-secret&token=relay-secret`,
			),
		)
		expect(response.status).toBe(200)
		expect(fetchSpy.mock.calls[0][0]).toBe(
			'https://eu-01.nodes.modrinth.com/download?token=node-secret',
		)
	})

	it('routes exact hosted-node domains and rejects names outside the owned suffix', () => {
		expect(
			matchRoute('/nodes/eu-01.nodes.modrinth.com/modrinth/v0/files')?.target.upstreamHost,
		).toBe('eu-01.nodes.modrinth.com')
		for (const host of [
			'nodes.modrinth.com',
			'node.nodes.modrinth.com.attacker.invalid',
			'attacker.invalid',
			'127.0.0.1',
			'-node.nodes.modrinth.com',
			'node-.nodes.modrinth.com',
			'node.nodes.modrinth.com:443',
		]) {
			expect(isAllowedNodeHost(host)).toBe(false)
			expect(matchRoute(`/nodes/${host}/file`)).toBeNull()
		}
		expect(
			JSON.parse(
				rewriteJsonContent('{"url":"https://eu-01.nodes.modrinth.com/modrinth/v0/files"}', origin),
			).url,
		).toBe(`${origin}/nodes/eu-01.nodes.modrinth.com/modrinth/v0/files`)
	})

	it('allows browser authentication headers, panel updates and resumed event streams', async () => {
		const response = await relay.fetch(
			new Request(`${origin}/archon/v1/sync`, { method: 'OPTIONS' }),
		)
		expect(response.status).toBe(204)
		expect(response.headers.get('access-control-allow-headers')).toContain('X-Modbridge-Token')
		expect(response.headers.get('access-control-allow-headers')).toContain('X-Panel-Version')
		expect(response.headers.get('access-control-allow-headers')).toContain('Last-Event-Id')
		expect(response.headers.get('access-control-allow-methods')).toContain('PATCH')
	})

	it.each([
		['/azul-api/metadata/v1/zulu/packages', 'api.azul.com'],
		['/azul-cdn/zulu/bin/zulu.zip', 'cdn.azul.com'],
		['/archon/v1/servers', 'archon.modrinth.com'],
		['/shared-instances/v1/instances', 'shared-instances.modrinth.com'],
		['/staging-cdn/data/icon.png', 'staging-cdn.modrinth.com'],
		['/paper/v3/projects/paper', 'fill.papermc.io'],
		['/purpur/v2/purpur', 'api.purpurmc.org'],
		['/mclogs/1/log', 'api.mclo.gs'],
		['/flags/us.svg', 'flagcdn.com'],
		['/github-api/users/example', 'api.github.com'],
		['/github-avatars/u/123', 'avatars.githubusercontent.com'],
	])('supports feature route %s', (path, upstreamHost) => {
		expect(matchRoute(path)?.target.upstreamHost).toBe(upstreamHost)
	})

	it('rewrites escaped, HTTP and nested URLs with exact host boundaries', () => {
		const json =
			'{"icon":"https:\\/\\/staging-cdn.modrinth.com\\/icon.png","nested":[{"java":"https://cdn.azul.com/zulu.zip","manifest":"http://launcher-files.modrinth.com/a.json"}],"spoof":"https://cdn.modrinth.com.attacker.invalid/icon","text":"![icon](https://cdn.modrinth.com/data/icon.png)"}'
		const rewritten = JSON.parse(rewriteJsonContent(json, origin))
		expect(rewritten.icon).toBe(`${origin}/staging-cdn/icon.png`)
		expect(rewritten.nested[0].java).toBe(`${origin}/azul-cdn/zulu.zip`)
		expect(rewritten.nested[0].manifest).toBe(`${origin}/launcher-files/a.json`)
		expect(rewritten.spoof).toBe('https://cdn.modrinth.com.attacker.invalid/icon')
		expect(rewritten.text).toBe(`![icon](${origin}/cdn/data/icon.png)`)
	})

	it('rewrites metadata after upstream redirects and retains Relay response headers', async () => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: { location: 'https://cdn.modrinth.com/metadata.json' },
				}),
			)
			.mockResolvedValueOnce(
				new Response('{"url":"https://cdn.modrinth.com/file.jar"}', {
					headers: { 'content-type': 'application/json', etag: '"original"' },
				}),
			)
		vi.stubGlobal('fetch', fetchSpy)
		const response = await relay.fetch(new Request(`${origin}/meta/latest.json`))
		expect(response.headers.get('access-control-allow-origin')).toBe('*')
		expect(response.headers.get('etag')).toBeNull()
		expect(await response.json()).toEqual({ url: `${origin}/cdn/file.jar` })
		expect(fetchSpy.mock.calls.every((call) => call[1].redirect === 'manual')).toBe(true)
	})

	it('handles bodyless metadata responses and conditional download responses', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(new Response(null, { status: 304, headers: { etag: '"cached"' } })),
		)
		const response = await relay.fetch(new Request(`${origin}/meta/manifest.json`))
		expect(response.status).toBe(304)
		expect(response.body).toBeNull()
		expect(response.headers.get('etag')).toBe('"cached"')
	})

	it('preserves the bytes and validators of downloaded JSON artifacts for integrity checks', async () => {
		const content = '{\n "homepage": "https://cdn.modrinth.com/project", "value": 1\n}'
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(content, {
					headers: { 'content-type': 'application/json', etag: '"original-artifact"' },
				}),
			),
		)
		const response = await relay.fetch(new Request(`${origin}/cdn/data/resource.json`))
		expect(await response.text()).toBe(content)
		expect(response.headers.get('etag')).toBe('"original-artifact"')
	})

	it('streams JSON sequences immediately instead of buffering a hosting operation until closure', async () => {
		let controller: ReadableStreamDefaultController<Uint8Array>
		const body = new ReadableStream<Uint8Array>({
			start(value) {
				controller = value
			},
		})
		controller!.enqueue(new TextEncoder().encode('\u001e{"progress":1}\n'))
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					new Response(body, { headers: { 'content-type': 'application/json-seq' } }),
				),
		)
		const response = await relay.fetch(
			new Request(`${origin}/nodes/eu-01.nodes.modrinth.com/modrinth/v1/files`),
		)
		const reader = response.body!.getReader()
		expect(new TextDecoder().decode((await reader.read()).value)).toBe('\u001e{"progress":1}\n')
		await reader.cancel()
	})

	it('cancels an upstream transfer when the Relay request is aborted', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockImplementation(
				(_url: string, options: RequestInit) =>
					new Promise((_resolve, reject) => {
						options.signal?.addEventListener(
							'abort',
							() => reject(new Error('Transfer cancelled')),
							{ once: true },
						)
					}),
			),
		)
		const controller = new AbortController()
		const pending = relay.fetch(
			new Request(`${origin}/cdn/data/file.jar`, { signal: controller.signal }),
		)
		controller.abort()
		expect((await pending).status).toBe(502)
	})
})

describe('Upstream redirect isolation', () => {
	it('validates the second redirect before fetching an unapproved domain', async () => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: { location: 'https://cdn.modrinth.com/redirect' },
				}),
			)
			.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: { location: 'https://attacker.invalid/file.jar' },
				}),
			)
		vi.stubGlobal('fetch', fetchSpy)
		await expect(
			fetchAllowlisted('https://api.modrinth.com/file', {}, allowedHosts),
		).rejects.toMatchObject({ code: 'BLOCKED_REDIRECT' })
		expect(fetchSpy).toHaveBeenCalledTimes(2)
	})

	it.each([
		'http://cdn.modrinth.com/file',
		'https://cdn.modrinth.com:444/file',
		'https://user:password@cdn.modrinth.com/file',
	])('blocks a redirect with unsafe URL authority: %s', async (location) => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 302, headers: { location } }))
		vi.stubGlobal('fetch', fetchSpy)
		await expect(
			fetchAllowlisted('https://api.modrinth.com/file', {}, allowedHosts),
		).rejects.toMatchObject({ code: 'BLOCKED_REDIRECT' })
		expect(fetchSpy).toHaveBeenCalledTimes(1)
	})

	it('drops account credentials on cross-origin redirects', async () => {
		const sentHeaders: Headers[] = []
		vi.stubGlobal(
			'fetch',
			vi.fn().mockImplementation(async (_url, options) => {
				sentHeaders.push(new Headers(options.headers))
				return sentHeaders.length === 1
					? new Response(null, {
							status: 302,
							headers: { location: 'https://cdn.modrinth.com/file' },
						})
					: new Response('data')
			}),
		)
		await fetchAllowlisted(
			'https://api.modrinth.com/file',
			{ headers: { authorization: 'Bearer account-secret', cookie: 'account=secret' } },
			allowedHosts,
		)
		expect(sentHeaders[0].get('authorization')).toBe('Bearer account-secret')
		expect(sentHeaders[1].get('authorization')).toBeNull()
		expect(sentHeaders[1].get('cookie')).toBeNull()
	})

	it('replays streaming uploads for 307 and switches POST to GET for 303', async () => {
		const uploads: Array<{ method: string; body: string }> = []
		vi.stubGlobal(
			'fetch',
			vi.fn().mockImplementation(async (_url, options) => {
				uploads.push({
					method: options.method,
					body: options.body ? await new Response(options.body).text() : '',
				})
				if (uploads.length === 1)
					return new Response(null, { status: 307, headers: { location: '/moved' } })
				if (uploads.length === 2)
					return new Response(null, { status: 303, headers: { location: '/done' } })
				return new Response('ok')
			}),
		)
		await fetchAllowlisted(
			'https://api.modrinth.com/upload',
			{ method: 'POST', body: new Response('file-content').body },
			allowedHosts,
		)
		expect(uploads).toEqual([
			{ method: 'POST', body: 'file-content' },
			{ method: 'POST', body: 'file-content' },
			{ method: 'GET', body: '' },
		])
	})

	it('stops redirect loops', async () => {
		const fetchSpy = vi
			.fn()
			.mockImplementation(() =>
				Promise.resolve(new Response(null, { status: 302, headers: { location: '/again' } })),
			)
		vi.stubGlobal('fetch', fetchSpy)
		await expect(
			fetchAllowlisted('https://api.modrinth.com/file', {}, allowedHosts),
		).rejects.toMatchObject({ code: 'TOO_MANY_REDIRECTS' })
		expect(fetchSpy).toHaveBeenCalledTimes(11)
	})
})
