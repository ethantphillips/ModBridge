import type { AbstractModrinthClient } from '@modrinth/api-client'

import type { PageContext } from '../providers/page-context'

type DownloadContext = Pick<PageContext, 'downloadFile' | 'saveBlob'> | null | undefined

export function buildBackupDownloadUrl(
	nodeUrlHost: string,
	backupId: string,
	token: string,
): string {
	const url = new URL(/^https?:\/\//i.test(nodeUrlHost) ? nodeUrlHost : `https://${nodeUrlHost}`)
	const basePath = url.pathname.replace(/\/modrinth\/v\d+\/fs\/?$/, '').replace(/\/$/, '')
	url.pathname = `${basePath}/modrinth/v0/backups/${encodeURIComponent(backupId)}/download`
	url.search = ''
	url.hash = ''
	url.searchParams.set('auth', token)
	return url.href
}

export async function downloadForClient(
	client: Pick<AbstractModrinthClient, 'resolveMediaUrl'> | null | undefined,
	context: DownloadContext,
	url: string,
	fileName: string,
): Promise<void | boolean> {
	const destination = client?.resolveMediaUrl(url) ?? url
	if (context?.downloadFile) {
		return await context.downloadFile(destination, fileName)
	}
	window.location.assign(destination)
}

export async function saveBlobForClient(
	context: DownloadContext,
	blob: Blob,
	fileName: string,
): Promise<void> {
	if (context?.saveBlob) {
		await context.saveBlob(blob, fileName)
		return
	}
	const url = window.URL.createObjectURL(blob)
	const link = document.createElement('a')
	link.href = url
	link.download = fileName
	try {
		link.click()
	} finally {
		setTimeout(() => window.URL.revokeObjectURL(url), 0)
	}
}
