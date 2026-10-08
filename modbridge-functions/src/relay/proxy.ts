import { sanitizeRequestHeaders, sanitizeResponseHeaders } from '../shared/headers.js'
import { createErrorResponse } from '../shared/errors.js'
import type { ProxyRequestOptions } from '../shared/types.js'
import { ALLOWED_UPSTREAM_HOSTS, isAllowedNodeHost } from './routing.js'
import { rewriteJsonContent } from './rewrite.js'
import { fetchAllowlisted, UpstreamError } from '../shared/fetch.js'
import { stripRelayQueryAuth } from './auth.js'

export async function executeProxy(options: ProxyRequestOptions): Promise<Response> {
	const { target, subpath, searchParams, method, headers, body, signal, relayOrigin } = options

	// Strip the relay auth token from query params before forwarding upstream
	const forwardedParams = stripRelayQueryAuth(searchParams)

	const queryString = forwardedParams.toString()
	const upstreamUrl = `https://${target.upstreamHost}${target.upstreamPrefix}${subpath}${queryString ? `?${queryString}` : ''}`

	const upstreamHeaders = sanitizeRequestHeaders(headers, target.upstreamHost)

	// Fetch options
	const fetchInit: RequestInit = {
		method,
		headers: upstreamHeaders,
		signal,
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
		const allowedHosts = isAllowedNodeHost(target.upstreamHost)
			? new Set([...ALLOWED_UPSTREAM_HOSTS, target.upstreamHost])
			: ALLOWED_UPSTREAM_HOSTS
		upstreamResponse = (await fetchAllowlisted(upstreamUrl, fetchInit, allowedHosts)).response
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err)
		return createErrorResponse(
			502,
			`Upstream request to ${target.upstreamHost} failed: ${message}`,
			err instanceof UpstreamError ? err.code : 'BAD_GATEWAY',
		)
	}

	const responseHeaders = sanitizeResponseHeaders(upstreamResponse.headers)
	const contentType = upstreamResponse.headers.get('content-type') || ''
	const mediaType = contentType.split(';', 1)[0].trim().toLowerCase()
	const isJson = mediaType === 'application/json' || /^application\/[\w.-]+\+json$/.test(mediaType)

	// For HEAD requests, return immediately with headers and no body
	if (method === 'HEAD' || [204, 205, 304].includes(upstreamResponse.status)) {
		return new Response(null, {
			status: upstreamResponse.status,
			statusText: upstreamResponse.statusText,
			headers: responseHeaders,
		})
	}

	// If rewriting is enabled and the response is JSON, perform safe URL rewriting
	if (
		target.enableRewrite &&
		isJson &&
		upstreamResponse.status >= 200 &&
		upstreamResponse.status < 300 &&
		upstreamResponse.status !== 206
	) {
		try {
			const jsonText = await upstreamResponse.text()
			const rewrittenJson = rewriteJsonContent(jsonText, relayOrigin)
			if (rewrittenJson !== jsonText) responseHeaders.delete('etag')

			responseHeaders.delete('content-encoding')
			responseHeaders.set(
				'content-length',
				String(new TextEncoder().encode(rewrittenJson).byteLength),
			)
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
