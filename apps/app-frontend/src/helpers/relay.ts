const SERVICE_ROUTES: Record<string, string> = {
	'api.modrinth.com': '/api',
	'cdn.modrinth.com': '/cdn',
	'staging-cdn.modrinth.com': '/staging-cdn',
	'launcher-meta.modrinth.com': '/launcher-meta',
	'launcher-files.modrinth.com': '/launcher-files',
	'archon.modrinth.com': '/archon',
	'staging-archon.modrinth.com': '/staging-archon',
	'shared-instances.modrinth.com': '/shared-instances',
	'staging-shared-instances.modrinth.com': '/staging-shared-instances',
	'piston-meta.mojang.com': '/minecraft/meta',
	'piston-data.mojang.com': '/minecraft/data',
	'resources.download.minecraft.net': '/minecraft/assets',
	'libraries.minecraft.net': '/minecraft/libraries',
	'api.minecraftservices.com': '/minecraft/services',
	'sessionserver.mojang.com': '/minecraft/session',
	'textures.minecraft.net': '/minecraft/textures',
	'launchermeta.mojang.com': '/minecraft/legacy-meta',
	'launcher.mojang.com': '/minecraft/legacy-launcher',
	'fill.papermc.io': '/paper',
	'api.purpurmc.org': '/purpur',
	'api.mclo.gs': '/mclogs',
	'flagcdn.com': '/flags',
	'api.github.com': '/github-api',
	'avatars.githubusercontent.com': '/github-avatars',
	'avatars0.githubusercontent.com': '/github-avatars0',
	'avatars1.githubusercontent.com': '/github-avatars1',
	'avatars2.githubusercontent.com': '/github-avatars2',
	'avatars3.githubusercontent.com': '/github-avatars3',
	'br-divine-snow-ahjav8i1-updates.compute.c-3.us-east-1.aws.neon.tech': '/updates',
}

export function createRelayUrlResolver(baseUrl: string): (url: string) => string {
	const relay = new URL(baseUrl.trim())
	if (
		!['http:', 'https:'].includes(relay.protocol) ||
		relay.username ||
		relay.password ||
		relay.search ||
		relay.hash
	) {
		throw new Error(
			'Relay URL must be an HTTP or HTTPS URL without credentials, query, or fragment',
		)
	}
	const relayBase = relay.href.replace(/\/+$/, '')
	const relayPath = relay.pathname.replace(/\/+$/, '')

	return (value: string): string => {
		if (!value) return value
		if (/^(data:|blob:|asset:|tauri:)/i.test(value)) return value
		if (value.startsWith('/') && !value.startsWith('//')) return value
		const url = new URL(value)
		if (url.username || url.password) {
			throw new Error('Service URLs must not contain credentials')
		}
		if (
			['http:', 'https:'].includes(url.protocol) &&
			['asset.localhost', 'tauri.localhost'].includes(url.hostname)
		) {
			return value
		}
		if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
			throw new Error('Unsupported service URL protocol')
		}
		const normalizedOrigin = url.origin.replace(/^ws/, 'http')
		if (
			normalizedOrigin === relay.origin &&
			(url.pathname === relayPath || url.pathname.startsWith(`${relayPath}/`))
		) {
			return value
		}
		const prefix = Object.prototype.hasOwnProperty.call(SERVICE_ROUTES, url.hostname)
			? SERVICE_ROUTES[url.hostname]
			: undefined
		const nodePrefix =
			url.hostname.length <= 253 &&
			/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+nodes\.modrinth\.com$/.test(url.hostname)
				? `/nodes/${url.hostname}`
				: undefined
		if ((!prefix && !nodePrefix) || url.port) {
			throw new Error(`Service domain is not available through Relay: ${url.hostname}`)
		}
		const destinationBase = url.protocol.startsWith('ws')
			? relayBase.replace(/^http/, 'ws')
			: relayBase
		return `${destinationBase}${prefix ?? nodePrefix}${url.pathname}${url.search}${url.hash}`
	}
}

/** Rewrite supported resource URLs in cached JSON, preserving external navigation links. */
export function rewriteServiceUrls<T>(value: T, resolveUrl: (url: string) => string): T {
	if (typeof value === 'string') {
		return value.replace(/https?:\/\/[^\s<>"'()\[\]]+/g, (url) => {
			try {
				return resolveUrl(url)
			} catch {
				return url
			}
		}) as T
	}
	if (Array.isArray(value)) {
		return value.map((entry) => rewriteServiceUrls(entry, resolveUrl)) as T
	}
	if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, rewriteServiceUrls(entry, resolveUrl)]),
		) as T
	}
	return value
}
