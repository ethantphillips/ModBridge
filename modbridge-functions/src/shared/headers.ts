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
])

export function sanitizeRequestHeaders(headers: Headers, upstreamHost: string): Headers {
	const sanitized = new Headers()

	for (const [key, value] of headers.entries()) {
		const lowerKey = key.toLowerCase()
		if (HOP_BY_HOP_HEADERS.has(lowerKey)) {
			continue
		}
		sanitized.set(key, value)
	}

	sanitized.set('Host', upstreamHost)
	return sanitized
}

export function sanitizeResponseHeaders(headers: Headers, allowCors = true): Headers {
	const sanitized = new Headers()

	for (const [key, value] of headers.entries()) {
		const lowerKey = key.toLowerCase()
		if (HOP_BY_HOP_HEADERS.has(lowerKey)) {
			continue
		}
		sanitized.set(key, value)
	}

	if (allowCors) {
		sanitized.set('Access-Control-Allow-Origin', '*')
		sanitized.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS')
		sanitized.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range, If-Range, If-None-Match, If-Modified-Since')
		sanitized.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified')
	}

	return sanitized
}
