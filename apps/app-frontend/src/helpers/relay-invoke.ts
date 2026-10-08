import { invoke } from '@tauri-apps/api/core'

import { resolveRelayMediaUrl } from '@/config'

import { rewriteServiceUrls } from './relay'

/** Adapt native JSON responses so existing cached resources follow the current Relay setting. */
export async function invokeWithRelayUrls<T>(
	command: string,
	args?: Record<string, unknown>,
): Promise<T> {
	return rewriteServiceUrls(await invoke<T>(command, args), resolveRelayMediaUrl)
}
