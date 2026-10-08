import { afterEach, describe, expect, it, vi } from 'vitest'
import relay from '../src/relay/index.js'
import { sanitizeRequestHeaders } from '../src/shared/headers.js'

afterEach(() => vi.unstubAllEnvs())

describe('Relay headers', () => {
	it('allows authenticated desktop API mutations in browser preflight', async () => {
		const response = await relay.fetch(
			new Request('https://relay.test/api/v3/user', { method: 'OPTIONS' }),
		)
		expect(response.status).toBe(204)
		expect(response.headers.get('access-control-allow-methods')).toContain('PATCH')
		for (const header of ['X-Modbridge-Token', 'X-Panel-Version', 'Modrinth-Sentry-Capture']) {
			expect(response.headers.get('access-control-allow-headers')).toContain(header)
		}
	})

	it('strips relay authentication but retains the user session and API headers', () => {
		vi.stubEnv('MODBRIDGE_RELAY_SECRET', 'relay-secret')
		const sanitized = sanitizeRequestHeaders(
			new Headers({
				'X-Modbridge-Token': 'relay-secret',
				Authorization: 'Bearer user-session',
				'X-Panel-Version': '3',
			}),
			'api.modrinth.com',
		)
		expect(sanitized.get('x-modbridge-token')).toBeNull()
		expect(sanitized.get('authorization')).toBe('Bearer user-session')
		expect(sanitized.get('x-panel-version')).toBe('3')
	})

	it('also strips a legacy relay Bearer token', () => {
		vi.stubEnv('MODBRIDGE_RELAY_SECRET', 'relay-secret')
		expect(
			sanitizeRequestHeaders(
				new Headers({ Authorization: 'Bearer relay-secret' }),
				'api.modrinth.com',
			).get('authorization'),
		).toBeNull()
	})
})
