import { sanitizeRequestHeaders } from './headers.js'
import { stripRelayQueryAuth } from '../relay/auth.js'

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export class UpstreamError extends Error {
	constructor(
		message: string,
		public readonly code: string,
	) {
		super(message)
	}
}

export function validateUpstreamUrl(url: URL, allowedHosts: ReadonlySet<string>): void {
	if (
		url.protocol !== 'https:' ||
		(url.port && url.port !== '443') ||
		url.username ||
		url.password ||
		!allowedHosts.has(url.hostname)
	) {
		throw new UpstreamError(`Upstream URL '${url.origin}' is not allowed`, 'BLOCKED_REDIRECT')
	}
}

/** Fetches an approved upstream, validating every redirect before sending a request. */
export async function fetchAllowlisted(
	input: string | URL,
	init: RequestInit,
	allowedHosts: ReadonlySet<string>,
): Promise<{ response: Response; url: URL }> {
	let url = new URL(input)
	let method = init.method || 'GET'
	let headers = sanitizeRequestHeaders(new Headers(init.headers), url.hostname)
	let body = init.body

	for (let redirects = 0; redirects <= 10; redirects++) {
		validateUpstreamUrl(url, allowedHosts)
		url.search = stripRelayQueryAuth(url.searchParams).toString()
		let nextBody: BodyInit | null | undefined
		if (body instanceof ReadableStream) {
			const branches = body.tee()
			body = branches[0]
			nextBody = branches[1]
		} else {
			nextBody = body
		}

		const options: RequestInit = { ...init, method, headers, body, redirect: 'manual' }
		if (body instanceof ReadableStream) {
			// @ts-expect-error Node fetch requires duplex for streaming request bodies.
			options.duplex = 'half'
		}
		const response = await fetch(url.toString(), options)
		if (!REDIRECT_STATUSES.has(response.status)) {
			if (nextBody instanceof ReadableStream) void nextBody.cancel().catch(() => {})
			return { response, url }
		}

		const location = response.headers.get('location')
		if (!location) {
			if (nextBody instanceof ReadableStream) void nextBody.cancel().catch(() => {})
			throw new UpstreamError('Upstream redirect has no location', 'BAD_REDIRECT')
		}
		let nextUrl: URL
		try {
			nextUrl = new URL(location, url)
		} catch {
			throw new UpstreamError('Malformed upstream redirect location', 'BAD_REDIRECT')
		}
		validateUpstreamUrl(nextUrl, allowedHosts)
		if (redirects === 10) {
			throw new UpstreamError('Upstream exceeded the redirect limit', 'TOO_MANY_REDIRECTS')
		}

		if (response.body) void response.body.cancel().catch(() => {})
		if (nextUrl.origin !== url.origin) {
			headers.delete('authorization')
			headers.delete('cookie')
		}
		if (
			(response.status === 303 && method !== 'HEAD') ||
			((response.status === 301 || response.status === 302) && method === 'POST')
		) {
			method = 'GET'
			body = undefined
			headers.delete('content-type')
			headers.delete('content-length')
			if (nextBody instanceof ReadableStream) void nextBody.cancel().catch(() => {})
		} else {
			body = nextBody
		}
		headers.set('host', nextUrl.host)
		url = nextUrl
	}
	throw new UpstreamError('Upstream exceeded the redirect limit', 'TOO_MANY_REDIRECTS')
}
