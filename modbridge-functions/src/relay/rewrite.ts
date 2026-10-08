import { isAllowedNodeHost, ROUTE_MAPPINGS } from './routing.js'

const hostRoutes = new Map<string, string>()
for (const { prefix, target } of ROUTE_MAPPINGS) {
	if (!hostRoutes.has(target.upstreamHost)) hostRoutes.set(target.upstreamHost, prefix)
}

const urlPattern = new RegExp(
	`https?:\\/\\/(${[...hostRoutes.keys()].map((host) => host.replace(/\./g, '\\.')).join('|')}|(?:[a-z0-9-]+\\.)+nodes\\.modrinth\\.com)(?=\\/|[?#]|$)`,
	'gi',
)

/** Rewrites decoded JSON strings, including escaped URLs and embedded Markdown media. */
export function rewriteJsonContent(jsonText: string, relayOrigin: string): string {
	const cleanOrigin = relayOrigin.replace(/\/$/, '')
	let changed = false
	const value: unknown = JSON.parse(jsonText, (_key, value: unknown) => {
		if (typeof value !== 'string') return value
		return value.replace(urlPattern, (_match, host: string) => {
			const normalizedHost = host.toLowerCase()
			const route =
				hostRoutes.get(normalizedHost) ??
				(isAllowedNodeHost(normalizedHost) ? `/nodes/${normalizedHost}` : undefined)
			if (!route) return _match
			changed = true
			return `${cleanOrigin}${route}`
		})
	})
	return changed ? JSON.stringify(value) : jsonText
}
