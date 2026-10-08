const MODRINTH_API_ROUTES: Record<string, string> = {
	'api.modrinth.com': '/api',
	'staging-api.modrinth.com': '/staging-api',
	'archon.modrinth.com': '/archon',
	'staging-archon.modrinth.com': '/staging-archon',
	'shared-instances.modrinth.com': '/shared-instances',
	'staging-shared-instances.modrinth.com': '/staging-shared-instances',
	'launcher-meta.modrinth.com': '/launcher-meta',
}

type ConfiguredApiOrigins = Partial<Record<'labrinth' | 'archon' | 'sharedinstances', string>>

function isAllowedNodeHost(hostname: string): boolean {
	const labels = hostname.split('.')
	if (
		hostname.length > 253 ||
		labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
	) {
		return false
	}
	return (
		(hostname.endsWith('.nodes.modrinth.com') && labels.length > 3) ||
		(labels.length === 3 && /^node-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.modrinth\.com$/.test(hostname))
	)
}

export function routeModrinthApiUrl(
	url: string,
	relayBaseUrl?: string,
	configuredOrigins: ConfiguredApiOrigins = {},
): string {
	if (!relayBaseUrl || !/^(?:https?|wss?):\/\//i.test(url)) return url
	if (isRelayUrl(url, relayBaseUrl)) return url

	const upstream = new URL(url)
	const isNodeHost = !upstream.port && isAllowedNodeHost(upstream.hostname)
	let route = Object.prototype.hasOwnProperty.call(MODRINTH_API_ROUTES, upstream.hostname)
		? MODRINTH_API_ROUTES[upstream.hostname]
		: isNodeHost
			? `/nodes/${upstream.hostname}`
			: undefined
	let path = upstream.pathname
	if (!route) {
		const requestOrigin = new URL(upstream)
		if (requestOrigin.protocol === 'wss:') requestOrigin.protocol = 'https:'
		if (requestOrigin.protocol === 'ws:') requestOrigin.protocol = 'http:'
		const serviceRoutes = {
			labrinth: '/api',
			archon: '/archon',
			sharedinstances: '/shared-instances',
		}
		let matchedBasePathLength = -1
		for (const [service, prefix] of Object.entries(serviceRoutes)) {
			const baseUrl = configuredOrigins[service as keyof ConfiguredApiOrigins]
			if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) continue
			const base = new URL(baseUrl)
			const basePath = base.pathname.replace(/\/+$/, '')
			if (
				requestOrigin.origin === base.origin &&
				basePath.length > matchedBasePathLength &&
				(upstream.pathname === basePath || upstream.pathname.startsWith(`${basePath}/`))
			) {
				route = prefix
				path = upstream.pathname.slice(basePath.length) || '/'
				matchedBasePathLength = basePath.length
			}
		}
	}
	if (!route) return url

	const relayBase = relayBaseUrl.trim().replace(/\/+$/, '')
	const target = new URL(`${relayBase}${route}${path}${upstream.search}${upstream.hash}`)
	if (upstream.protocol === 'ws:' || upstream.protocol === 'wss:') {
		target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
	}
	return target.toString()
}

export function isRelayUrl(url: string, relayBaseUrl?: string): boolean {
	if (!relayBaseUrl || !/^(?:https?|wss?):\/\//i.test(url)) return false

	const request = new URL(url)
	const relay = new URL(relayBaseUrl)
	if (request.protocol === 'wss:') request.protocol = 'https:'
	if (request.protocol === 'ws:') request.protocol = 'http:'
	const relayPath = relay.pathname.replace(/\/+$/, '')
	return (
		request.origin === relay.origin &&
		(request.pathname === relayPath || request.pathname.startsWith(`${relayPath}/`))
	)
}
