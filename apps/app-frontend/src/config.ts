import { createRelayUrlResolver } from './helpers/relay'

const trimTrailingSlash = (url: string) => url.trim().replace(/\/+$/, '')

const DEFAULT_RELAY_URL =
	'https://br-divine-snow-ahjav8i1-relay.compute.c-3.us-east-1.aws.neon.tech'

const relayBaseUrl = trimTrailingSlash(
	import.meta.env.MODBRIDGE_RELAY_BASE_URL ||
		import.meta.env.VITE_MODBRIDGE_RELAY_BASE_URL ||
		DEFAULT_RELAY_URL,
)

const siteUrl = relayBaseUrl
const labrinthBaseUrl = `${relayBaseUrl}/api`
const archonBaseUrl = `${relayBaseUrl}/archon`
const sharedInstancesBaseUrl = `${relayBaseUrl}/shared-instances`
const relayToken =
	import.meta.env.MODBRIDGE_RELAY_AUTH_TOKEN ||
	import.meta.env.VITE_MODBRIDGE_RELAY_AUTH_TOKEN ||
	import.meta.env.MODBRIDGE_RELAY_TOKEN ||
	import.meta.env.VITE_MODBRIDGE_RELAY_TOKEN

export const resolveRelayUrl = createRelayUrlResolver(relayBaseUrl)

export const relayHeaders: Record<string, string> = relayToken
	? { 'X-Modbridge-Token': relayToken }
	: {}

export function resolveRelayMediaUrl(url: string): string {
	const routed = resolveRelayUrl(url)
	if (!relayToken || !routed.startsWith(`${relayBaseUrl}/`)) return routed
	const mediaUrl = new URL(routed)
	mediaUrl.searchParams.set('relay_token', relayToken)
	return mediaUrl.href
}

export function resolveRelayWebSocketUrl(url: string): string {
	const routed = resolveRelayUrl(url)
	if (!relayToken) return routed
	const socketUrl = new URL(routed)
	socketUrl.searchParams.set('relay_token', relayToken)
	return socketUrl.href
}

export const config = {
	relayBaseUrl,
	siteUrl,
	stripePublishableKey:
		import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY ||
		'pk_test_51JbFxJJygY5LJFfKV50mnXzz3YLvBVe2Gd1jn7ljWAkaBlRz3VQdxN9mXcPSrFbSqxwAb0svte9yhnsmm7qHfcWn00R611Ce7b',
	labrinthBaseUrl,
	archonBaseUrl,
	sharedInstancesBaseUrl,
}
