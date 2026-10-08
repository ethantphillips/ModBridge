import { isAllowedNodeHost, ROUTE_MAPPINGS } from './routing.js'

const hostRoutes = new Map<string, string>()
const mediaHosts = new Set<string>()
for (const { prefix, target } of ROUTE_MAPPINGS) {
	if (!hostRoutes.has(target.upstreamHost)) hostRoutes.set(target.upstreamHost, prefix)
	if (['modrinth-cdn', 'media', 'minecraft-textures'].includes(target.category)) {
		mediaHosts.add(target.upstreamHost)
	}
}
const mediaUrlPattern = new RegExp(
	`https?:\\/\\/(${[...mediaHosts].map((host) => host.replace(/\./g, '\\.')).join('|')})(?=\\/|[?#]|$)`,
	'gi',
)

export function rewriteUpstreamUrl(value: string, relayOrigin: string): string {
	const bareNode = !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)
	if (bareNode && !isAllowedNodeHost(value.split('/')[0])) return value
	if (/\s/.test(value)) return value
	let url: URL
	try {
		url = new URL(bareNode ? `https://${value}` : value)
	} catch {
		return value
	}
	if (!['https:', 'http:', 'wss:', 'ws:'].includes(url.protocol) || url.username || url.password || url.port) return value
	if (url.hostname === 'modrinth.com' && !url.pathname.startsWith('/api/')) return value
	const route = hostRoutes.get(url.hostname) ?? (isAllowedNodeHost(url.hostname) ? `/nodes/${url.hostname}` : null)
	if (!route) return value
	const origin = relayOrigin.replace(/\/$/, '')
	const transportOrigin = ['wss:', 'ws:'].includes(url.protocol) ? origin.replace(/^http/, 'ws') : origin
	return `${transportOrigin}${route}${url.pathname}${url.search}${url.hash}`
}

/** Rewrites URL fields and embedded media while preserving other user text. */
export function rewriteJsonContent(jsonText: string, relayOrigin: string): string {
	const cleanOrigin = relayOrigin.replace(/\/$/, '')
	let changed = false
	const value: unknown = JSON.parse(jsonText, (_key, value: unknown) => {
		if (typeof value !== 'string') return value
		const rewrittenUrl = rewriteUpstreamUrl(value, cleanOrigin)
		const rewritten = rewrittenUrl !== value ? rewrittenUrl : value.replace(mediaUrlPattern, (_match, host: string) => `${cleanOrigin}${hostRoutes.get(host.toLowerCase())}`)
		changed ||= rewritten !== value
		return rewritten
	})
	return changed ? JSON.stringify(value) : jsonText
}
