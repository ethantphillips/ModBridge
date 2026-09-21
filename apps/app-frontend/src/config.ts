const trimTrailingSlash = (url: string) => url.replace(/\/$/, '')

const DEFAULT_RELAY_URL = 'https://br-mute-sun-avpguohr-relay.compute.c-11.us-east-1.aws.neon.tech'

const relayBaseUrl = trimTrailingSlash(
	import.meta.env.MODBRIDGE_RELAY_BASE_URL ||
	import.meta.env.VITE_MODBRIDGE_RELAY_BASE_URL ||
	DEFAULT_RELAY_URL,
)

const siteUrl = relayBaseUrl
const labrinthBaseUrl = `${relayBaseUrl}/api`
const archonBaseUrl = `${relayBaseUrl}/archon`
const sharedInstancesBaseUrl = `${relayBaseUrl}/shared-instances`

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
