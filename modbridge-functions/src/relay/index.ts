import { matchRoute } from './routing.js'
import { validateRelayAuth } from './auth.js'
import { executeProxy } from './proxy.js'
import { createErrorResponse } from '../shared/errors.js'
import { logProxyRequest } from '../shared/logging.js'

export default {
	async fetch(request: Request): Promise<Response> {
		const startTime = Date.now()
		const url = new URL(request.url)

		// Handle CORS preflight
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range, If-Range, If-None-Match, If-Modified-Since',
					'Access-Control-Max-Age': '86400',
				},
			})
		}

		// Health / info check
		if (url.pathname === '/' || url.pathname === '/health') {
			return new Response(
				JSON.stringify({
					service: 'ModBridge Relay',
					status: 'ok',
					version: '1.0.0',
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
				},
			)
		}

		// Validate bearer / download authentication
		const auth = validateRelayAuth(request)
		if (!auth.authorized) {
			logProxyRequest({
				timestamp: new Date().toISOString(),
				functionName: 'relay',
				method: request.method,
				route: url.pathname,
				status: 401,
				error: auth.reason,
			})
			return createErrorResponse(401, auth.reason || 'Unauthorized', 'UNAUTHORIZED')
		}

		// Match allowlisted route
		const match = matchRoute(url.pathname)
		if (!match) {
			logProxyRequest({
				timestamp: new Date().toISOString(),
				functionName: 'relay',
				method: request.method,
				route: url.pathname,
				status: 404,
				error: 'Unsupported route',
			})
			return createErrorResponse(
				404,
				`Route '${url.pathname}' is not supported by ModBridge Relay. Only allowlisted Modrinth and Minecraft endpoints are proxied.`,
				'NOT_FOUND',
			)
		}

		const relayOrigin = `${url.protocol}//${url.host}`
		const response = await executeProxy({
			target: match.target,
			subpath: match.subpath,
			searchParams: url.searchParams,
			method: request.method,
			headers: request.headers,
			body: request.body,
			relayOrigin,
		})

		logProxyRequest({
			timestamp: new Date().toISOString(),
			functionName: 'relay',
			method: request.method,
			route: url.pathname,
			upstreamHost: match.target.upstreamHost,
			status: response.status,
			durationMs: Date.now() - startTime,
		})

		return response
	},
}
