export interface RouteTarget {
	upstreamHost: string
	upstreamPrefix: string
	category: 'modrinth-api' | 'modrinth-cdn' | 'minecraft-meta' | 'minecraft-data' | 'minecraft-assets' | 'minecraft-libraries' | 'minecraft-services' | 'minecraft-session' | 'minecraft-textures'
	enableRewrite?: boolean
}

export interface ProxyRequestOptions {
	target: RouteTarget
	subpath: string
	searchParams: URLSearchParams
	method: string
	headers: Headers
	body?: ReadableStream<Uint8Array> | null
	relayOrigin: string
}
