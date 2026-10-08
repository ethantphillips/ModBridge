import type { ModrinthApiError } from '../core/errors'
import type { ClientConfig } from '../types/client'
import type { RequestContext, RequestOptions } from '../types/request'
import type { UploadProgress } from '../types/upload'
import { appendRequestParams, parseResponseErrorData, toFetchBody } from '../utils/fetch'
import { isRelayUrl, routeModrinthApiUrl } from '../utils/relay'
import { GenericSyncClient } from './sync-generic'
import { GenericWebSocketClient } from './websocket-generic'
import { XHRUploadClient } from './xhr-upload-client'

/**
 * Tauri-specific configuration
 */
export interface TauriClientConfig extends ClientConfig {
	/** Route Modrinth API URLs through this relay, including custom module URLs. */
	relayBaseUrl?: string
	/** Relay credential, sent separately from the upstream Authorization header. */
	relayAuthToken?: string
}

/**
 * Extended error type with HTTP response metadata
 */
interface HttpError extends Error {
	statusCode?: number
	responseData?: unknown
}

/**
 * Tauri platform client using Tauri v2 HTTP plugin
 *
 * Extends XHRUploadClient to provide upload with progress tracking.
 *
 * @example
 * ```typescript
 * import { getVersion } from '@tauri-apps/api/app'
 *
 * const client = new TauriModrinthClient({
 *   userAgent: async () => `modrinth/theseus/${await getVersion()} (support@modrinth.com)`,
 *   features: [
 *     new AuthFeature({ token: async () => getOAuthToken() })
 *   ]
 * })
 *
 * const project = await client.request('/project/sodium', { api: 'labrinth', version: 2 })
 * ```
 */
export class TauriModrinthClient extends XHRUploadClient {
	declare protected config: TauriClientConfig

	constructor(config: TauriClientConfig) {
		super(config)

		Object.defineProperty(this.archon, 'sockets', {
			value: new GenericWebSocketClient(this),
			writable: false,
			enumerable: true,
			configurable: false,
		})
		Object.defineProperty(this.archon, 'sync', {
			value: new GenericSyncClient(this),
			writable: false,
			enumerable: true,
			configurable: false,
		})
	}

	protected buildUrl(path: string, baseUrl: string, version: number | 'internal' | string): string {
		const url = /^https?:\/\//i.test(path) ? path : super.buildUrl(path, baseUrl, version)
		return this.resolveUrl(url)
	}

	public resolveUrl(url: string): string {
		return super.resolveUrl(this.routeUrlThroughRelay(url))
	}

	public resolveMediaUrl(url: string): string {
		return this.attachRelayQueryToken(super.resolveMediaUrl(this.routeUrlThroughRelay(url)))
	}

	public resolveWebSocketUrl(url: string): string {
		return this.attachRelayQueryToken(super.resolveWebSocketUrl(this.routeUrlThroughRelay(url)))
	}

	private attachRelayQueryToken(routed: string): string {
		if (this.config.relayAuthToken && isRelayUrl(routed, this.config.relayBaseUrl)) {
			const targetUrl = new URL(routed)
			targetUrl.searchParams.set('modbridge_token', this.config.relayAuthToken)
			return targetUrl.toString()
		}
		return routed
	}

	private routeUrlThroughRelay(url: string): string {
		return routeModrinthApiUrl(url, this.config.relayBaseUrl, {
			labrinth: this.resolveBaseUrl(this.config.labrinthBaseUrl!),
			archon: this.resolveBaseUrl(this.config.archonBaseUrl!),
			sharedinstances: this.resolveBaseUrl(this.config.sharedInstancesBaseUrl!),
		})
	}

	private prepareRelayRequest(url: string, options: RequestOptions) {
		const relayUrl = this.resolveUrl(url)
		const headers = { ...options.headers }
		if (this.config.relayAuthToken && isRelayUrl(relayUrl, this.config.relayBaseUrl)) {
			headers['X-Modbridge-Token'] = this.config.relayAuthToken
		}
		return { url: relayUrl, options: { ...options, headers } }
	}

	protected executeXHRUpload<T>(
		context: RequestContext,
		progressCallbacks: Array<(p: UploadProgress) => void>,
		abortController: AbortController,
	): Promise<T> {
		const request = this.prepareRelayRequest(context.url, context.options)
		return super.executeXHRUpload<T>({ ...context, ...request }, progressCallbacks, abortController)
	}

	protected async executeRequest<T>(url: string, options: RequestOptions): Promise<T> {
		try {
			// Dynamically import Tauri HTTP plugin
			// This allows the package to be used in non-Tauri environments
			const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')

			const request = this.prepareRelayRequest(url, options)
			const body = toFetchBody(request.options.body)
			const fullUrl = appendRequestParams(request.url, request.options.params)

			const response = await tauriFetch(fullUrl, {
				method: request.options.method ?? 'GET',
				headers: request.options.headers,
				body,
				signal: request.options.signal,
				redirect: isRelayUrl(fullUrl, this.config.relayBaseUrl) ? 'error' : undefined,
			})

			if (!response.ok) {
				let responseData: unknown
				try {
					responseData = await response.json()
				} catch {
					responseData = undefined
				}

				const error = new Error(`HTTP ${response.status}: ${response.statusText}`) as HttpError

				error.statusCode = response.status
				error.responseData = responseData

				throw error
			}

			// Handle binary downloads (e.g. kyros fs files) before JSON parsing.
			const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
			if (fullUrl.includes('/fs/download')) {
				return (await response.blob()) as T
			}
			if (
				contentType.startsWith('image/') ||
				contentType.startsWith('audio/') ||
				contentType.startsWith('video/') ||
				contentType.includes('application/octet-stream')
			) {
				return (await response.blob()) as T
			}

			if (response.status === 204 || response.status === 205) {
				return undefined as T
			}

			if (contentType.includes('application/json') || contentType.includes('+json')) {
				return (await response.json()) as T
			}

			const text = await response.text()
			if (!text) {
				return undefined as T
			}

			try {
				return JSON.parse(text) as T
			} catch {
				return text as T
			}
		} catch (error) {
			throw this.normalizeError(error)
		}
	}

	protected async executeStreamRequest(
		url: string,
		options: RequestOptions,
	): Promise<ReadableStream<Uint8Array>> {
		try {
			const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
			const request = this.prepareRelayRequest(url, options)
			const response = await tauriFetch(appendRequestParams(request.url, request.options.params), {
				method: request.options.method ?? 'GET',
				headers: request.options.headers,
				body: toFetchBody(request.options.body),
				signal: request.options.signal,
				redirect: isRelayUrl(request.url, this.config.relayBaseUrl) ? 'error' : undefined,
			})

			if (!response.ok) {
				throw this.createNormalizedError(
					new Error(`HTTP ${response.status}: ${response.statusText}`),
					response.status,
					await parseResponseErrorData(response),
				)
			}

			if (!response.body) {
				throw this.createNormalizedError(
					new Error('Streaming response has no readable body'),
					response.status,
					undefined,
				)
			}

			return response.body
		} catch (error) {
			throw this.normalizeError(error)
		}
	}

	protected normalizeError(error: unknown): ModrinthApiError {
		if (error instanceof Error) {
			const httpError = error as HttpError
			const statusCode = httpError.statusCode
			const responseData = httpError.responseData

			return this.createNormalizedError(error, statusCode, responseData)
		}

		return super.normalizeError(error)
	}
}
