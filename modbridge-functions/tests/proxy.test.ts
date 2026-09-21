import { describe, it, expect, vi } from 'vitest'
import { executeProxy } from '../src/relay/proxy.js'

describe('Proxy Execution & Streaming', () => {
	it('handles HEAD request without body', async () => {
		const mockResponse = new Response(null, {
			status: 200,
			headers: {
				'Content-Type': 'application/java-archive',
				'Content-Length': '52428800',
				'Accept-Ranges': 'bytes',
			},
		})

		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(mockResponse),
		)

		const response = await executeProxy({
			target: {
				upstreamHost: 'cdn.modrinth.com',
				upstreamPrefix: '',
				category: 'modrinth-cdn',
			},
			subpath: '/data/mod.jar',
			searchParams: new URLSearchParams(),
			method: 'HEAD',
			headers: new Headers(),
			relayOrigin: 'https://relay.modbridge.internal',
		})

		expect(response.status).toBe(200)
		expect(response.body).toBeNull()
		expect(response.headers.get('content-length')).toBe('52428800')
		expect(response.headers.get('accept-ranges')).toBe('bytes')

		vi.unstubAllGlobals()
	})

	it('relays 206 Partial Content with Content-Range for Range requests', async () => {
		const mockResponse = new Response('partial-bytes', {
			status: 206,
			headers: {
				'Content-Type': 'application/octet-stream',
				'Content-Range': 'bytes 0-12/100',
				'Content-Length': '13',
				'Accept-Ranges': 'bytes',
			},
		})

		const fetchSpy = vi.fn().mockResolvedValue(mockResponse)
		vi.stubGlobal('fetch', fetchSpy)

		const reqHeaders = new Headers()
		reqHeaders.set('Range', 'bytes=0-12')

		const response = await executeProxy({
			target: {
				upstreamHost: 'piston-data.mojang.com',
				upstreamPrefix: '',
				category: 'minecraft-data',
			},
			subpath: '/v1/objects/test/client.jar',
			searchParams: new URLSearchParams(),
			method: 'GET',
			headers: reqHeaders,
			relayOrigin: 'https://relay.modbridge.internal',
		})

		expect(response.status).toBe(206)
		expect(response.headers.get('content-range')).toBe('bytes 0-12/100')
		expect(await response.text()).toBe('partial-bytes')

		// Verify Range was forwarded to upstream
		const calledHeaders = fetchSpy.mock.calls[0][1].headers as Headers
		expect(calledHeaders.get('range')).toBe('bytes=0-12')

		vi.unstubAllGlobals()
	})

	it('blocks upstream redirects to untrusted domains', async () => {
		const redirectResponse = new Response(null, {
			status: 302,
			headers: {
				Location: 'https://attacker.evil.com/malware.jar',
			},
		})

		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(redirectResponse))

		const response = await executeProxy({
			target: {
				upstreamHost: 'cdn.modrinth.com',
				upstreamPrefix: '',
				category: 'modrinth-cdn',
			},
			subpath: '/data/mod.jar',
			searchParams: new URLSearchParams(),
			method: 'GET',
			headers: new Headers(),
			relayOrigin: 'https://relay.modbridge.internal',
		})

		expect(response.status).toBe(502)
		const body = await response.json()
		expect(body.error).toBe('BLOCKED_REDIRECT')

		vi.unstubAllGlobals()
	})
})
