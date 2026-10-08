import { createRelayUrlResolver } from './helpers/relay'

const trimTrailingSlash = (url: string) => url.trim().replace(/\/+$/, '')

const DEFAULT_RELAY_URL =
	'https://br-divine-snow-ahjav8i1-relay.compute.c-3.us-east-1.aws.neon.tech'

const relayBaseUrl = trimTrailingSlash(
	import.meta.env.MODBRIDGE_RELAY_BASE_URL ||
		import.meta.env.VITE_MODBRIDGE_RELAY_BASE_URL ||
		DEFAULT_RELAY_URL,
)

const siteUrl = `${relayBaseUrl}/site`
const labrinthBaseUrl = `${relayBaseUrl}/api`
const archonBaseUrl = `${relayBaseUrl}/archon`
const sharedInstancesBaseUrl = `${relayBaseUrl}/shared-instances`
const relayAuthToken = (
	import.meta.env.MODBRIDGE_RELAY_AUTH_TOKEN ||
	import.meta.env.VITE_MODBRIDGE_RELAY_AUTH_TOKEN ||
	import.meta.env.MODBRIDGE_RELAY_TOKEN ||
	import.meta.env.VITE_MODBRIDGE_RELAY_TOKEN ||
	''
).trim()

export const resolveRelayUrl = createRelayUrlResolver(relayBaseUrl)

export const relayHeaders: Record<string, string> = relayAuthToken
	? { 'X-Modbridge-Token': relayAuthToken }
	: {}

export function resolveRelayMediaUrl(url: string): string {
	const routed = resolveRelayUrl(url)
	if (!relayAuthToken || !routed.startsWith(`${relayBaseUrl}/`)) return routed
	const mediaUrl = new URL(routed)
	mediaUrl.searchParams.set('modbridge_token', relayAuthToken)
	return mediaUrl.href
}

export function resolveRelayWebSocketUrl(url: string): string {
	const routed = resolveRelayUrl(url)
	if (!relayAuthToken) return routed
	const socketUrl = new URL(routed)
	socketUrl.searchParams.set('modbridge_token', relayAuthToken)
	return socketUrl.href
}

export const config = {
	relayBaseUrl,
	relayAuthToken,
	siteUrl,
	stripePublishableKey:
		import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY ||
		'pk_test_51JbFxJJygY5LJFfKV50mnXzz3YLvBVe2Gd1jn7ljWAkaBlRz3VQdxN9mXcPSrFbSqxwAb0svte9yhnsmm7qHfcWn00R611Ce7b',
	labrinthBaseUrl,
	archonBaseUrl,
	sharedInstancesBaseUrl,
}
