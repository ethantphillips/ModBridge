import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeProxy } from '../src/relay/proxy.js'
import type { ProxyRequestOptions } from '../src/shared/types.js'

const options: ProxyRequestOptions = {
	target: {
		upstreamHost: 'api.modrinth.com',
		upstreamPrefix: '',
		category: 'modrinth-api',
		enableRewrite: true,
	},
	subpath: '/v3/project/example',
	searchParams: new URLSearchParams('modbridge_token=relay-secret&query=value'),
	method: 'GET',
	headers: new Headers({ 'X-Modbridge-Token': 'relay-secret', Authorization: 'Bearer session' }),
	relayOrigin: 'https://relay.test',
}

afterEach(() => vi.unstubAllGlobals())

describe('Relay redirect handling', () => {
	it('rewrites and adds relay headers after following an allowlisted redirect', async () => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: {
						location: '/v3/project/resolved?token=world-token&modbridge_token=relay-secret',
					},
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ url: 'https://api.modrinth.com/v3/user' }), {
					headers: { 'content-type': 'application/json' },
				}),
			)
		vi.stubGlobal('fetch', fetchSpy)
		const response = await executeProxy(options)
		expect(response.headers.get('access-control-allow-origin')).toBe('*')
		expect(await response.json()).toEqual({ url: 'https://relay.test/api/v3/user' })
		expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
			'https://api.modrinth.com/v3/project/example?query=value',
			'https://api.modrinth.com/v3/project/resolved?token=world-token',
		])
		for (const [, init] of fetchSpy.mock.calls) {
			expect(init.redirect).toBe('manual')
			expect(init.headers.get('x-modbridge-token')).toBeNull()
			expect(init.headers.get('authorization')).toBe('Bearer session')
		}
	})

	it('checks every redirect hop instead of letting fetch leave the allowlist', async () => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: { location: 'https://cdn.modrinth.com/data/example' },
				}),
			)
			.mockResolvedValueOnce(
				new Response(null, { status: 302, headers: { location: 'https://attacker.test/file' } }),
			)
		vi.stubGlobal('fetch', fetchSpy)
		const response = await executeProxy(options)
		expect(response.status).toBe(502)
		expect(await response.json()).toMatchObject({ error: 'BLOCKED_REDIRECT' })
		expect(fetchSpy).toHaveBeenCalledTimes(2)
		expect(fetchSpy.mock.calls[1][1].headers.get('authorization')).toBeNull()
	})

	it('bounds redirect loops', async () => {
		const fetchSpy = vi
			.fn()
			.mockImplementation(
				() => new Response(null, { status: 307, headers: { location: '/v3/project/example' } }),
			)
		vi.stubGlobal('fetch', fetchSpy)
		const response = await executeProxy(options)
		expect(await response.json()).toMatchObject({ error: 'TOO_MANY_REDIRECTS' })
		expect(fetchSpy).toHaveBeenCalledTimes(11)
	})

	it.each([
		'http://api.modrinth.com/path',
		'https://api.modrinth.com:8443/path',
		'https://user:password@api.modrinth.com/path',
	])('blocks unsafe redirect %s', async (location) => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location } })),
		)
		expect((await executeProxy(options)).status).toBe(502)
	})
})
