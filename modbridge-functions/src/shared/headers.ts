const HOP_BY_HOP_HEADERS = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'host',
	'content-encoding',
])

export const CORS_ALLOW_METHODS = 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS'
export const CORS_ALLOW_HEADERS =
	'Content-Type, Authorization, X-Modbridge-Token, X-Panel-Version, Last-Event-Id, Range, If-Range, If-None-Match, If-Modified-Since, Modrinth-App-Version, Modrinth-Sentry-Capture, X-Ratelimit-Key, User-Agent, Cache-Control'

export function sanitizeRequestHeaders(headers: Headers, upstreamHost: string): Headers {
	const sanitized = new Headers()
	const connectionHeaders = new Set(
		(headers.get('connection') || '')
			.toLowerCase()
			.split(',')
			.map((name) => name.trim()),
	)

	for (const [key, value] of headers.entries()) {
		const lowerKey = key.toLowerCase()
		if (
			HOP_BY_HOP_HEADERS.has(lowerKey) ||
			connectionHeaders.has(lowerKey) ||
			lowerKey === 'x-modbridge-token' ||
			lowerKey === 'referer'
		) {
			continue
		}
		const relaySecret = process.env.MODBRIDGE_RELAY_SECRET || process.env.MODBRIDGE_RELAY_TOKEN
		if (
			lowerKey === 'authorization' &&
			relaySecret &&
			value.match(/^Bearer\s+(.+)$/i)?.[1] === relaySecret
		) {
			continue
		}
		sanitized.set(key, value)
	}

	sanitized.set('Host', upstreamHost)
	return sanitized
}

export function sanitizeResponseHeaders(headers: Headers, allowCors = true): Headers {
	const sanitized = new Headers()
	const hadContentEncoding = headers.has('content-encoding')
	const connectionHeaders = new Set(
		(headers.get('connection') || '')
			.toLowerCase()
			.split(',')
			.map((name) => name.trim()),
	)

	for (const [key, value] of headers.entries()) {
		const lowerKey = key.toLowerCase()
		if (HOP_BY_HOP_HEADERS.has(lowerKey) || connectionHeaders.has(lowerKey)) {
			continue
		}
		if (hadContentEncoding && lowerKey === 'content-length') {
			continue
		}
		sanitized.set(key, value)
	}

	if (allowCors) {
		sanitized.set('Access-Control-Allow-Origin', '*')
		sanitized.set('Access-Control-Allow-Methods', CORS_ALLOW_METHODS)
		sanitized.set('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS)
		sanitized.set(
			'Access-Control-Expose-Headers',
			'Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified',
		)
	}

	return sanitized
}
