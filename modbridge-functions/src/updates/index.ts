import { fetchLatestRelease, fetchReleaseByTag, fetchReleaseAsset } from './github.js'
import { loadUpdateManifest } from './manifest.js'
import { createErrorResponse } from '../shared/errors.js'
import { CORS_ALLOW_HEADERS, sanitizeResponseHeaders } from '../shared/headers.js'
import { logProxyRequest } from '../shared/logging.js'
import { UpstreamError } from '../shared/fetch.js'

export async function handleUpdates(
	request: Request,
	origin?: string,
	routePath?: string,
): Promise<Response> {
	const startTime = Date.now()
	const url = new URL(request.url)
	const pathname = routePath ?? url.pathname
	const updateOrigin = origin ?? url.origin
	if (request.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: {
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
				'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
			},
		})
	}
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return createErrorResponse(
			405,
			'Updates only support GET and HEAD requests',
			'METHOD_NOT_ALLOWED',
		)
	}
	if (pathname === '/' || pathname === '/health') {
		return jsonResponse(
			{ service: 'ModBridge Updates', status: 'ok', repository: 'ethantphillips/ModBridge' },
			request.method,
		)
	}

	const manifestMatch = pathname.match(/^\/manifest\/([^/]+)$/)
	if (pathname === '/latest' || pathname === '/updates.json' || manifestMatch) {
		try {
			const channel = url.searchParams.get('channel') || 'stable'
			if (!['stable', 'beta', 'prerelease'].includes(channel)) {
				return createErrorResponse(400, `Unknown update channel '${channel}'`, 'INVALID_CHANNEL')
			}
			const release = manifestMatch
				? await fetchReleaseByTag(decodeURIComponent(manifestMatch[1]))
				: await fetchLatestRelease(channel === 'beta' || channel === 'prerelease')
			if (!release)
				return createErrorResponse(404, 'No matching ModBridge release found', 'NO_RELEASES')
			const manifest = await loadUpdateManifest(release, updateOrigin)
			return jsonResponse(manifest, request.method, manifestMatch ? 3600 : 300)
		} catch (error) {
			return createErrorResponse(
				502,
				error instanceof Error ? error.message : String(error),
				'GITHUB_ERROR',
			)
		}
	}

	const downloadMatch = pathname.match(/^\/download\/([^/]+)\/([^/]+)\/([^/]+)$/)
	if (downloadMatch) {
		try {
			const tag = decodeURIComponent(downloadMatch[1])
			const assetName = decodeURIComponent(downloadMatch[3])
			const release = await fetchReleaseByTag(tag)
			if (!release)
				return createErrorResponse(404, `Release '${tag}' not found`, 'RELEASE_NOT_FOUND')
			const asset = release.assets.find((asset) => asset.name === assetName)
			if (!asset)
				return createErrorResponse(404, `Asset '${assetName}' not found`, 'ASSET_NOT_FOUND')
			const { response, url: finalUrl } = await fetchReleaseAsset(asset, {
				method: request.method,
				headers: request.headers,
				signal: request.signal,
			})
			const headers = sanitizeResponseHeaders(response.headers)
			headers.set(
				'Content-Disposition',
				`attachment; filename="${asset.name.replace(/["\\\r\n]/g, '_')}"`,
			)
			logProxyRequest({
				timestamp: new Date().toISOString(),
				functionName: 'updates',
				method: request.method,
				route: pathname,
				upstreamHost: finalUrl.hostname,
				status: response.status,
				durationMs: Date.now() - startTime,
			})
			return new Response(
				request.method === 'HEAD' || [204, 205, 304].includes(response.status)
					? null
					: response.body,
				{
					status: response.status,
					headers,
				},
			)
		} catch (error) {
			return createErrorResponse(
				502,
				error instanceof Error ? error.message : String(error),
				error instanceof UpstreamError ? error.code : 'DOWNLOAD_ERROR',
			)
		}
	}
	return createErrorResponse(404, `Update route '${pathname}' not found`, 'NOT_FOUND')
}

function jsonResponse(value: unknown, method: string, maxAge?: number): Response {
	return new Response(method === 'HEAD' ? null : JSON.stringify(value), {
		headers: {
			'Content-Type': 'application/json',
			'Access-Control-Allow-Origin': '*',
			...(maxAge ? { 'Cache-Control': `public, max-age=${maxAge}` } : {}),
		},
	})
}

export default { fetch: (request: Request) => handleUpdates(request) }
