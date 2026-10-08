import { matchRoute } from './routing.js'
import { validateRelayAuth } from './auth.js'
import { executeProxy } from './proxy.js'
import { createErrorResponse } from '../shared/errors.js'
import { logProxyRequest } from '../shared/logging.js'
import { CORS_ALLOW_HEADERS, CORS_ALLOW_METHODS } from '../shared/headers.js'
import { handleUpdates } from '../updates/index.js'
import { handleServerRequest } from './server-status.js'
import { isWebSocketRoute, proxyWebSocket } from './websocket.js'

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
					'Access-Control-Allow-Methods': CORS_ALLOW_METHODS,
					'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
					'Access-Control-Max-Age': '86400',
				},
			})
		}

		// Health / info check
		if (url.pathname === '/' || url.pathname === '/health') {
			return new Response(
				request.method === 'HEAD'
					? null
					: JSON.stringify({
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

		if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
			return createErrorResponse(405, 'Unsupported HTTP method', 'METHOD_NOT_ALLOWED')
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

		if (
			url.pathname === '/updates.json' ||
			url.pathname === '/updates' ||
			url.pathname.startsWith('/updates/')
		) {
			const updatePath =
				url.pathname === '/updates.json'
					? '/updates.json'
					: url.pathname.slice('/updates'.length) || '/'
			return handleUpdates(request, `${url.origin}/updates`, updatePath)
		}

		if (url.pathname === '/server/resolve' || url.pathname === '/server/status') {
			return handleServerRequest(request)
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

		if (
			request.headers.get('upgrade')?.toLowerCase() === 'websocket' ||
			(match.target.upstreamHost === 'api.modrinth.com' &&
				isWebSocketRoute(match.target, match.subpath))
		) {
			return proxyWebSocket(request, match.target, match.subpath)
		}

		const relayOrigin = `${url.protocol}//${url.host}`
		const response = await executeProxy({
			target: match.target,
			subpath: match.subpath,
			searchParams: url.searchParams,
			method: request.method,
			headers: request.headers,
			body: request.body,
			signal: request.signal,
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
