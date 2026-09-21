import { sanitizeRequestHeaders, sanitizeResponseHeaders } from '../shared/headers.js'
import { createErrorResponse } from '../shared/errors.js'
import type { ProxyRequestOptions } from '../shared/types.js'
import { ALLOWED_UPSTREAM_HOSTS } from './routing.js'
import { rewriteJsonContent } from './rewrite.js'

export async function executeProxy(options: ProxyRequestOptions): Promise<Response> {
	const { target, subpath, searchParams, method, headers, body, relayOrigin } = options

	// Strip the relay auth token from query params before forwarding upstream
	const forwardedParams = new URLSearchParams(searchParams)
	forwardedParams.delete('token')

	const queryString = forwardedParams.toString()
	const upstreamUrl = `https://${target.upstreamHost}${subpath}${queryString ? `?${queryString}` : ''}`

	const upstreamHeaders = sanitizeRequestHeaders(headers, target.upstreamHost)

	// Fetch options
	const fetchInit: RequestInit = {
		method,
		headers: upstreamHeaders,
		redirect: 'manual',
	}

	// Attach body for methods that support bodies
	if (method !== 'GET' && method !== 'HEAD' && body) {
		fetchInit.body = body
		// In Node.js 18+ fetch with a stream requires duplex: 'half'
		// @ts-expect-error duplex property is supported in Node.js fetch
		fetchInit.duplex = 'half'
	}

	let upstreamResponse: Response
	try {
		upstreamResponse = await fetch(upstreamUrl, fetchInit)
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err)
		return createErrorResponse(502, `Upstream request to ${target.upstreamHost} failed: ${message}`, 'BAD_GATEWAY')
	}

	// Handle upstream redirect safely
	if ([301, 302, 303, 307, 308].includes(upstreamResponse.status)) {
		const location = upstreamResponse.headers.get('location')
		if (location) {
			try {
				const redirectUrl = new URL(location, upstreamUrl)
				if (!ALLOWED_UPSTREAM_HOSTS.has(redirectUrl.hostname)) {
					return createErrorResponse(
						502,
						`Upstream redirect to untrusted host '${redirectUrl.hostname}' was blocked.`,
						'BLOCKED_REDIRECT',
					)
				}
				// Follow the redirect internally within approved hosts
				const redirectedHeaders = sanitizeRequestHeaders(headers, redirectUrl.hostname)
				return await fetch(redirectUrl.toString(), {
					method,
					headers: redirectedHeaders,
					redirect: 'follow',
				})
			} catch {
				return createErrorResponse(502, 'Malformed upstream redirect location', 'BAD_REDIRECT')
			}
		}
	}

	const responseHeaders = sanitizeResponseHeaders(upstreamResponse.headers)
	const contentType = upstreamResponse.headers.get('content-type') || ''
	const isJson = contentType.includes('application/json')

	// For HEAD requests, return immediately with headers and no body
	if (method === 'HEAD') {
		return new Response(null, {
			status: upstreamResponse.status,
			statusText: upstreamResponse.statusText,
			headers: responseHeaders,
		})
	}

	// If rewriting is enabled and the response is JSON, perform safe URL rewriting
	if (target.enableRewrite && isJson && upstreamResponse.status >= 200 && upstreamResponse.status < 300) {
		try {
			const jsonText = await upstreamResponse.text()
			const rewrittenJson = rewriteJsonContent(jsonText, relayOrigin)

			responseHeaders.set('content-length', String(new TextEncoder().encode(rewrittenJson).byteLength))
			return new Response(rewrittenJson, {
				status: upstreamResponse.status,
				statusText: upstreamResponse.statusText,
				headers: responseHeaders,
			})
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err)
			return createErrorResponse(502, `Failed rewriting upstream JSON: ${message}`, 'REWRITE_ERROR')
		}
	}

	// For all binary downloads and regular streams, stream directly without buffering
	return new Response(upstreamResponse.body, {
		status: upstreamResponse.status,
		statusText: upstreamResponse.statusText,
		headers: responseHeaders,
	})
}
