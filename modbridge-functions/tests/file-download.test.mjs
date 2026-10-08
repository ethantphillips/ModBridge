// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createRelayUrlResolver } from '../../apps/app-frontend/src/helpers/relay.ts'
import {
	buildBackupDownloadUrl,
	downloadForClient,
	saveBlobForClient,
} from '../../packages/ui/src/utils/file-download.ts'

const dependencies = vi.hoisted(() => ({
	client: null,
	context: null,
	addNotification: vi.fn(),
}))

vi.mock('../../packages/ui/src/providers/api-client.ts', () => ({
	injectModrinthClient: () => dependencies.client,
}))
vi.mock('../../packages/ui/src/providers/page-context.ts', () => ({
	injectPageContext: () => dependencies.context,
}))
vi.mock('../../packages/ui/src/providers/web-notifications.ts', () => ({
	injectNotificationManager: () => ({ addNotification: dependencies.addNotification }),
}))
vi.mock('../../packages/ui/src/composables/i18n.ts', () => ({
	defineMessages: (messages) => messages,
	useVIntl: () => ({ formatMessage: (message) => message.defaultMessage }),
}))

import { useServerWorldDownload } from '../../packages/ui/src/composables/server-download.ts'

const relay = 'https://relay.modbridge.internal'
const node = 'us1.nodes.modrinth.com'
const resolve = createRelayUrlResolver(relay)
const client = {
	resolveMediaUrl: (url) => {
		const destination = new URL(resolve(url))
		destination.searchParams.set('relay_token', 'relay-auth')
		return destination.href
	},
}

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

describe('hosting downloads', () => {
	it('routes native backup downloads to Relay and preserves the encoded node session', async () => {
		const downloadFile = vi.fn()
		const url = buildBackupDownloadUrl(node, 'backup/a', 'node token&extra=blocked')
		await downloadForClient(client, { downloadFile }, url, 'backup.zip')
		const [destination, name] = downloadFile.mock.calls[0]
		const parsed = new URL(destination)
		expect(parsed.origin).toBe(relay)
		expect(parsed.pathname).toBe(`/nodes/${node}/modrinth/v0/backups/backup%2Fa/download`)
		expect(parsed.searchParams.get('auth')).toBe('node token&extra=blocked')
		expect(parsed.searchParams.get('extra')).toBeNull()
		expect(parsed.searchParams.get('relay_token')).toBe('relay-auth')
		expect(name).toBe('backup.zip')
	})

	it('supports qualified node and existing Relay filesystem base paths', () => {
		expect(buildBackupDownloadUrl(`https://${node}/modrinth/v0/fs`, 'id', 'auth')).toBe(
			`https://${node}/modrinth/v0/backups/id/download?auth=auth`,
		)
		expect(buildBackupDownloadUrl(`${relay}/nodes/${node}/modrinth/v0/fs`, 'id', 'auth')).toBe(
			`${relay}/nodes/${node}/modrinth/v0/backups/id/download?auth=auth`,
		)
	})

	it('rejects unsupported nodes before invoking a native download or browser navigation', async () => {
		const downloadFile = vi.fn()
		const assign = vi.fn()
		vi.stubGlobal('window', { location: { assign } })
		await expect(
			downloadForClient(client, { downloadFile }, 'https://external.test/archive.zip', 'a.zip'),
		).rejects.toThrow('not available through Relay')
		expect(downloadFile).not.toHaveBeenCalled()
		expect(assign).not.toHaveBeenCalled()
	})

	it('preserves website download navigation with the default identity resolver', async () => {
		const assign = vi.fn()
		vi.stubGlobal('window', { location: { assign } })
		const url = `https://${node}/v1/worlds/id/files/download-full-zip?token=node-auth`
		await downloadForClient({ resolveMediaUrl: (value) => value }, null, url, 'world.zip')
		expect(assign).toHaveBeenCalledWith(url)
	})

	it('propagates native download errors so the caller can display failure', async () => {
		await expect(
			downloadForClient(
				client,
				{ downloadFile: vi.fn().mockRejectedValue(new Error('failed')) },
				`https://${node}/archive.zip`,
				'world.zip',
			),
		).rejects.toThrow('failed')
	})

	it('preserves a canceled native save without navigating or reporting completion', async () => {
		const assign = vi.fn()
		vi.stubGlobal('window', { location: { assign } })
		const saved = await downloadForClient(
			client,
			{ downloadFile: vi.fn().mockResolvedValue(false) },
			`https://${node}/archive.zip`,
			'world.zip',
		)
		expect(saved).toBe(false)
		expect(assign).not.toHaveBeenCalled()
	})

	it('saves already fetched native file contents without opening a browser URL', async () => {
		const saveBlob = vi.fn()
		const blob = new Blob(['server file'])
		const createElement = vi.spyOn(document, 'createElement')
		await saveBlobForClient({ saveBlob }, blob, 'latest.log')
		expect(saveBlob).toHaveBeenCalledWith(blob, 'latest.log')
		expect(createElement).not.toHaveBeenCalled()
	})

	it('propagates file-save errors rather than attempting a Blob browser fallback', async () => {
		const createElement = vi.spyOn(document, 'createElement')
		await expect(
			saveBlobForClient(
				{ saveBlob: vi.fn().mockRejectedValue(new Error('save failed')) },
				new Blob(['file']),
				'file.txt',
			),
		).rejects.toThrow('save failed')
		expect(createElement).not.toHaveBeenCalled()
	})

	it('keeps website Blob downloads and revokes the temporary URL after the click', async () => {
		vi.useFakeTimers()
		const createObjectURL = vi.fn(() => 'blob:https://website.test/download')
		const revokeObjectURL = vi.fn()
		vi.stubGlobal('window', { URL: { createObjectURL, revokeObjectURL } })
		const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
		await saveBlobForClient(null, new Blob(['file']), 'file.txt')
		expect(click).toHaveBeenCalledOnce()
		expect(click.mock.instances[0].download).toBe('file.txt')
		expect(click.mock.instances[0].getAttribute('href')).toBe('blob:https://website.test/download')
		expect(revokeObjectURL).not.toHaveBeenCalled()
		vi.runAllTimers()
		expect(revokeObjectURL).toHaveBeenCalledWith('blob:https://website.test/download')
	})
})

describe('full world download flow', () => {
	beforeEach(() => {
		dependencies.addNotification.mockClear()
		dependencies.context = { downloadFile: vi.fn() }
		dependencies.client = {
			...client,
			kyros: {
				files_v1: {
					authorizeFullWorldDownload: vi.fn().mockResolvedValue({ token: 'single-use&token' }),
					getFullWorldDownloadUrl: (host, id, token) => {
						const url = new URL(`https://${host}/v1/worlds/${id}/files/download-full-zip`)
						url.searchParams.set('token', token)
						return url.href
					},
				},
			},
		}
	})

	it('authorizes the world then hands a Relay URL to the native file saver', async () => {
		await useServerWorldDownload().downloadWorldFiles(node, 'world-id')
		expect(dependencies.client.kyros.files_v1.authorizeFullWorldDownload).toHaveBeenCalledWith(
			node,
			'world-id',
		)
		const [destination, name] = dependencies.context.downloadFile.mock.calls[0]
		const url = new URL(destination)
		expect(url.origin).toBe(relay)
		expect(url.pathname).toBe(`/nodes/${node}/v1/worlds/world-id/files/download-full-zip`)
		expect(url.searchParams.get('token')).toBe('single-use&token')
		expect(url.searchParams.get('relay_token')).toBe('relay-auth')
		expect(name).toBe('world-world-id.zip')
		expect(dependencies.addNotification).not.toHaveBeenCalled()
	})

	it('shows download failure when native save fails and never falls back to direct navigation', async () => {
		const assign = vi.fn()
		vi.stubGlobal('window', { location: { assign } })
		dependencies.context.downloadFile.mockRejectedValue(new Error('save failed'))
		await useServerWorldDownload().downloadWorldFiles(node, 'world-id')
		expect(dependencies.addNotification).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'Download failed', type: 'error' }),
		)
		expect(assign).not.toHaveBeenCalled()
	})
})
