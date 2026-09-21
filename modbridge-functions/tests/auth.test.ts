import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { validateRelayAuth } from '../src/relay/auth.js'

describe('Relay Authentication', () => {
	const originalEnv = process.env.MODBRIDGE_RELAY_SECRET

	afterEach(() => {
		process.env.MODBRIDGE_RELAY_SECRET = originalEnv
	})

	it('allows requests when no secret is configured (dev mode)', () => {
		delete process.env.MODBRIDGE_RELAY_SECRET
		delete process.env.MODBRIDGE_RELAY_TOKEN

		const req = new Request('https://relay.modbridge.internal/api/v2/search')
		const result = validateRelayAuth(req)
		expect(result.authorized).toBe(true)
	})

	it('rejects unauthorized requests when secret is configured', () => {
		process.env.MODBRIDGE_RELAY_SECRET = 'super-secret-token'

		const req = new Request('https://relay.modbridge.internal/api/v2/search')
		const result = validateRelayAuth(req)
		expect(result.authorized).toBe(false)
	})

	it('accepts valid Bearer token in Authorization header', () => {
		process.env.MODBRIDGE_RELAY_SECRET = 'super-secret-token'

		const req = new Request('https://relay.modbridge.internal/api/v2/search', {
			headers: {
				Authorization: 'Bearer super-secret-token',
			},
		})
		const result = validateRelayAuth(req)
		expect(result.authorized).toBe(true)
	})

	it('rejects invalid Bearer token', () => {
		process.env.MODBRIDGE_RELAY_SECRET = 'super-secret-token'

		const req = new Request('https://relay.modbridge.internal/api/v2/search', {
			headers: {
				Authorization: 'Bearer wrong-token',
			},
		})
		const result = validateRelayAuth(req)
		expect(result.authorized).toBe(false)
	})

	it('accepts valid query string token for downloads', () => {
		process.env.MODBRIDGE_RELAY_SECRET = 'super-secret-token'

		const req = new Request('https://relay.modbridge.internal/cdn/data/file.jar?token=super-secret-token')
		const result = validateRelayAuth(req)
		expect(result.authorized).toBe(true)
	})

	it('accepts valid x-modbridge-token header', () => {
		process.env.MODBRIDGE_RELAY_SECRET = 'super-secret-token'

		const req = new Request('https://relay.modbridge.internal/api/v2/search', {
			headers: {
				'x-modbridge-token': 'super-secret-token',
			},
		})
		const result = validateRelayAuth(req)
		expect(result.authorized).toBe(true)
	})
})
