import type { AbstractFeature } from '../core/abstract-feature'
import type { RequestContext } from './request'

export type MaybePromise<T> = T | Promise<T>
export type UserAgentProvider = string | (() => MaybePromise<string | undefined>)
export type BaseUrlConfig = string | (() => string)

/**
 * Request lifecycle hooks
 */
export type RequestHooks = {
	/**
	 * Called before request is sent (after all features have processed)
	 */
	onRequest?: (context: RequestContext) => void | Promise<void>

	/**
	 * Called after successful response (before features process response)
	 */
	onResponse?: <T>(data: T, context: RequestContext) => void | Promise<void>

	/**
	 * Called when request fails (after all features have processed error)
	 */
	onError?: (error: Error, context: RequestContext) => void | Promise<void>
}

/**
 * Client configuration
 */
export interface ClientConfig {
	/** Resolve outgoing service and media URLs, for example through an application relay. */
	resolveUrl?: (url: string) => string

	/** Resolve browser-loaded media URLs, which cannot carry the client's request headers. */
	resolveMediaUrl?: (url: string) => string

	/** Resolve WebSocket URLs, whose browser connections cannot carry request headers. */
	resolveWebSocketUrl?: (url: string) => string

	/** Whether third-party embedded content may load directly in the application. */
	allowExternalEmbeds?: boolean

	/**
	 * User agent string or provider for requests
	 * Should identify your application (e.g., 'my-app/1.0.0')
	 * If not provided, the platform's default user agent will be used
	 */
	userAgent?: UserAgentProvider

	/**
	 * Base URL for Labrinth API (main Modrinth API)
	 * @default 'https://api.modrinth.com'
	 */
	labrinthBaseUrl?: BaseUrlConfig

	/**
	 * Base URL for Archon API (Modrinth Hosting API)
	 * Can be a callback so apps can drive this from runtime feature flags.
	 *
	 * @default 'https://archon.modrinth.com'
	 */
	archonBaseUrl?: BaseUrlConfig

	/**
	 * Base URL for the Shared Instances API
	 * @default 'https://shared-instances.modrinth.com'
	 */
	sharedInstancesBaseUrl?: BaseUrlConfig

	/**
	 * Default request timeout in milliseconds
	 * @default 10000
	 */
	timeout?: number

	/**
	 * Additional default headers to include in all requests
	 */
	headers?: Record<string, string>

	/**
	 * Whether to attach `modrinth-sentry-capture: 1` to Archon requests.
	 * Can be a callback so apps can drive this from runtime feature flags.
	 *
	 * @default false
	 */
	archonSentryCapture?: boolean | (() => boolean)

	/**
	 * Features to enable for this client
	 * Features are applied in the order they appear in this array
	 */
	features?: AbstractFeature[]

	/**
	 * Request lifecycle hooks
	 */
	hooks?: RequestHooks
}
