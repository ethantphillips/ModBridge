import { fetchLatestRelease, fetchReleaseByTag, ALLOWED_GITHUB_DOWNLOAD_HOSTS } from './github.js'
import { buildUpdateManifest } from './manifest.js'
import { createErrorResponse } from '../shared/errors.js'
import { sanitizeRequestHeaders, sanitizeResponseHeaders } from '../shared/headers.js'
import { logProxyRequest } from '../shared/logging.js'

export default {
	async fetch(request: Request): Promise<Response> {
		const startTime = Date.now()
		const url = new URL(request.url)
		const pathname = url.pathname

		// CORS preflight
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type, Range, If-Range, If-None-Match, If-Modified-Since',
				},
			})
		}

		if (pathname === '/' || pathname === '/health') {
			return new Response(
				JSON.stringify({
					service: 'ModBridge Updates',
					status: 'ok',
					repository: 'ethantphillips/ModBridge',
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
				},
			)
		}

		const updateOrigin = `${url.protocol}//${url.host}`

		// Latest release manifest
		if (pathname === '/latest' || pathname === '/updates.json') {
			const channel = url.searchParams.get('channel') || 'stable'
			const includePrerelease = channel === 'beta' || channel === 'prerelease'

			try {
				const release = await fetchLatestRelease(includePrerelease)
				if (!release) {
					return createErrorResponse(404, 'No releases found for ModBridge', 'NO_RELEASES')
				}

				const manifest = buildUpdateManifest(release, updateOrigin)
				return new Response(JSON.stringify(manifest), {
					status: 200,
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*',
						'Cache-Control': 'public, max-age=300',
					},
				})
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err)
				return createErrorResponse(502, `Failed fetching release metadata from GitHub: ${message}`, 'GITHUB_ERROR')
			}
		}

		// Manifest for a specific version: /manifest/:version
		const manifestMatch = pathname.match(/^\/manifest\/([^/]+)$/)
		if (manifestMatch) {
			const tag = manifestMatch[1]
			try {
				const release = await fetchReleaseByTag(tag)
				if (!release) {
					return createErrorResponse(404, `Release '${tag}' not found`, 'RELEASE_NOT_FOUND')
				}

				const manifest = buildUpdateManifest(release, updateOrigin)
				return new Response(JSON.stringify(manifest), {
					status: 200,
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*',
						'Cache-Control': 'public, max-age=3600',
					},
				})
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err)
				return createErrorResponse(502, `Failed fetching release metadata: ${message}`, 'GITHUB_ERROR')
			}
		}

		// Download release asset: /download/:version/:platform/:asset
		const downloadMatch = pathname.match(/^\/download\/([^/]+)\/([^/]+)\/([^/]+)$/)
		if (downloadMatch) {
			const tag = downloadMatch[1]
			const assetName = decodeURIComponent(downloadMatch[3])

			try {
				const release = await fetchReleaseByTag(tag)
				if (!release) {
					return createErrorResponse(404, `Release '${tag}' not found`, 'RELEASE_NOT_FOUND')
				}

				const asset = release.assets.find((a) => a.name === assetName)
				if (!asset) {
					return createErrorResponse(404, `Asset '${assetName}' not found in release '${tag}'`, 'ASSET_NOT_FOUND')
				}

				const downloadUrl = new URL(asset.browser_download_url)
				if (!ALLOWED_GITHUB_DOWNLOAD_HOSTS.has(downloadUrl.hostname)) {
					return createErrorResponse(502, `Untrusted GitHub asset host '${downloadUrl.hostname}'`, 'UNTRUSTED_HOST')
				}

				const upstreamHeaders = sanitizeRequestHeaders(request.headers, downloadUrl.hostname)
				const fetchInit: RequestInit = {
					method: request.method,
					headers: upstreamHeaders,
					redirect: 'follow',
				}

				const upstreamResponse = await fetch(downloadUrl.toString(), fetchInit)

				// Check redirect target if redirected
				const finalUrl = new URL(upstreamResponse.url)
				if (!ALLOWED_GITHUB_DOWNLOAD_HOSTS.has(finalUrl.hostname)) {
					return createErrorResponse(502, `GitHub redirect to untrusted host '${finalUrl.hostname}' blocked`, 'UNTRUSTED_REDIRECT')
				}

				const responseHeaders = sanitizeResponseHeaders(upstreamResponse.headers)
				responseHeaders.set('Content-Disposition', `attachment; filename="${asset.name}"`)

				logProxyRequest({
					timestamp: new Date().toISOString(),
					functionName: 'updates',
					method: request.method,
					route: pathname,
					upstreamHost: finalUrl.hostname,
					status: upstreamResponse.status,
					durationMs: Date.now() - startTime,
				})

				if (request.method === 'HEAD') {
					return new Response(null, {
						status: upstreamResponse.status,
						headers: responseHeaders,
					})
				}

				return new Response(upstreamResponse.body, {
					status: upstreamResponse.status,
					headers: responseHeaders,
				})
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err)
				return createErrorResponse(502, `Failed streaming update asset: ${message}`, 'DOWNLOAD_ERROR')
			}
		}

		return createErrorResponse(404, `Route '${pathname}' not found on ModBridge Update Function`, 'NOT_FOUND')
	},
}
