import { afterEach, describe, expect, it, vi } from 'vitest'
import relay from '../src/relay/index.js'
import { stripRelayQueryAuth } from '../src/relay/auth.js'

afterEach(() => {
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
})

describe('Relay and upstream query credentials', () => {
	it('authenticates a world download and sends only its one-use token upstream', async () => {
		vi.stubEnv('MODBRIDGE_RELAY_SECRET', 'relay-secret')
		const fetchSpy = vi.fn().mockResolvedValue(new Response('world-bytes'))
		vi.stubGlobal('fetch', fetchSpy)
		const response = await relay.fetch(
			new Request(
				'https://relay.test/nodes/node-test.modrinth.com/modrinth/v0/world/download?token=world-token&modbridge_token=relay-secret',
			),
		)
		expect(response.status).toBe(200)
		expect(await response.text()).toBe('world-bytes')
		expect(fetchSpy.mock.calls[0][0]).toBe(
			'https://node-test.modrinth.com/modrinth/v0/world/download?token=world-token',
		)
	})

	it('strips only matching legacy relay tokens and retains repeated upstream tokens', () => {
		vi.stubEnv('MODBRIDGE_RELAY_SECRET', 'relay-secret')
		const params = new URLSearchParams(
			'token=world-token&token=relay-secret&token=other-token&modbridge_token=relay-secret',
		)
		expect(stripRelayQueryAuth(params).toString()).toBe('token=world-token&token=other-token')
		expect(params.getAll('token')).toEqual(['world-token', 'relay-secret', 'other-token'])
	})

	it.each([undefined, '', '   '])(
		'preserves upstream tokens when relay auth is unset or empty (%s)',
		(secret) => {
			vi.stubEnv('MODBRIDGE_RELAY_SECRET', secret)
			vi.stubEnv('MODBRIDGE_RELAY_TOKEN', undefined)
			expect(
				stripRelayQueryAuth(
					new URLSearchParams('token=world-token&modbridge_token=relay-secret'),
				).toString(),
			).toBe('token=world-token')
		},
	)

	it('preserves the user Bearer token with distinct relay authentication', async () => {
		vi.stubEnv('MODBRIDGE_RELAY_SECRET', 'relay-secret')
		const fetchSpy = vi
			.fn()
			.mockResolvedValue(new Response('{}', { headers: { 'content-type': 'application/json' } }))
		vi.stubGlobal('fetch', fetchSpy)
		const response = await relay.fetch(
			new Request('https://relay.test/api/v3/user?modbridge_token=relay-secret', {
				headers: { Authorization: 'Bearer user-session' },
			}),
		)
		expect(response.status).toBe(200)
		expect(fetchSpy.mock.calls[0][1].headers.get('authorization')).toBe('Bearer user-session')
	})

	it('accepts legacy relay Bearer authentication without forwarding it upstream', async () => {
		vi.stubEnv('MODBRIDGE_RELAY_SECRET', 'relay-secret')
		const fetchSpy = vi
			.fn()
			.mockResolvedValue(new Response('{}', { headers: { 'content-type': 'application/json' } }))
		vi.stubGlobal('fetch', fetchSpy)
		const response = await relay.fetch(
			new Request('https://relay.test/api/v3/user', {
				headers: { Authorization: 'Bearer relay-secret' },
			}),
		)
		expect(response.status).toBe(200)
		expect(fetchSpy.mock.calls[0][1].headers.get('authorization')).toBeNull()
	})
})
