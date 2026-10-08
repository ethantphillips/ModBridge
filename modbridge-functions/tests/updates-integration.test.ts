import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import relay from '../src/relay/index.js'
import { assetPlatforms, loadUpdateManifest } from '../src/updates/manifest.js'
import { fetchReleaseByTag, type GitHubRelease } from '../src/updates/github.js'
import { compareSemVer, parseSemVer } from '../src/updates/semver.js'

const origin = 'https://relay.modbridge.internal'
const baseDownload = 'https://github.com/ethantphillips/ModBridge/releases/download/v1.2.0'
const release: GitHubRelease = {
	tag_name: 'v1.2.0',
	name: 'ModBridge 1.2.0',
	body: 'Release notes',
	draft: false,
	prerelease: false,
	published_at: '2026-10-01T00:00:00Z',
	assets: [
		{
			name: 'Modbridge_1.2.0_x64-setup.nsis.zip',
			browser_download_url: `${baseDownload}/Modbridge_1.2.0_x64-setup.nsis.zip`,
			size: 100,
			content_type: 'application/zip',
		},
		{
			name: 'Modbridge_1.2.0_x64-setup.nsis.zip.sig',
			browser_download_url: `${baseDownload}/Modbridge_1.2.0_x64-setup.nsis.zip.sig`,
			size: 10,
			content_type: 'text/plain',
		},
		{
			name: 'Modbridge_1.2.0_universal.app.tar.gz',
			browser_download_url: `${baseDownload}/Modbridge_1.2.0_universal.app.tar.gz`,
			size: 200,
			content_type: 'application/gzip',
		},
		{
			name: 'Modbridge_1.2.0_universal.app.tar.gz.sig',
			browser_download_url: `${baseDownload}/Modbridge_1.2.0_universal.app.tar.gz.sig`,
			size: 10,
			content_type: 'text/plain',
		},
		{
			name: 'Modbridge_1.2.0_amd64.deb',
			browser_download_url: `${baseDownload}/Modbridge_1.2.0_amd64.deb`,
			size: 100,
			content_type: 'application/octet-stream',
		},
	],
}

beforeEach(() => {
	vi.stubEnv('MODBRIDGE_RELAY_SECRET', '')
	vi.stubEnv('MODBRIDGE_RELAY_TOKEN', '')
})
afterEach(() => {
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})

describe('Relay updater', () => {
	it('returns signed Tauri artifacts and Relay download URLs from the main service', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockImplementation(async (url: string) => {
				if (url.includes('api.github.com')) return Response.json([release])
				if (url.endsWith('.sig')) return new Response('signed-value\n')
				throw new Error(`Unexpected URL ${url}`)
			}),
		)
		const response = await relay.fetch(new Request(`${origin}/updates.json`))
		expect(response.status).toBe(200)
		const manifest = await response.json()
		expect(manifest.version).toBe('1.2.0')
		expect(Object.keys(manifest.platforms).sort()).toEqual([
			'darwin-aarch64',
			'darwin-x86_64',
			'windows-x86_64',
		])
		for (const platform of Object.values(manifest.platforms) as Array<{
			url: string
			signature: string
		}>) {
			expect(platform.url.startsWith(`${origin}/updates/download/1.2.0/`)).toBe(true)
			expect(platform.signature).toBe('signed-value')
		}
		expect(manifest.release_notes_url).toBe(`${origin}/updates/manifest/1.2.0`)
	})

	it('preserves published signatures and platform mappings while rewriting release assets', async () => {
		const releaseWithManifest: GitHubRelease = {
			...release,
			assets: [
				...release.assets,
				{
					name: 'latest.json',
					browser_download_url: `${baseDownload}/latest.json`,
					size: 500,
					content_type: 'application/json',
				},
			],
		}
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				Response.json({
					platforms: {
						'windows-x86_64': {
							url: release.assets[0].browser_download_url,
							signature: 'published-signature',
						},
					},
				}),
			),
		)
		const manifest = await loadUpdateManifest(releaseWithManifest, `${origin}/updates`)
		expect(manifest.platforms['windows-x86_64']).toEqual({
			url: `${origin}/updates/download/1.2.0/windows-x86_64/${release.assets[0].name}`,
			signature: 'published-signature',
			size: 100,
		})
	})

	it('refuses a published updater asset outside its release', async () => {
		const releaseWithManifest: GitHubRelease = {
			...release,
			assets: [
				...release.assets,
				{
					name: 'latest.json',
					browser_download_url: `${baseDownload}/latest.json`,
					size: 500,
					content_type: 'application/json',
				},
			],
		}
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				Response.json({
					platforms: {
						'windows-x86_64': {
							url: 'https://attacker.invalid/Modbridge_1.2.0_x64-setup.nsis.zip',
							signature: 'signed',
						},
					},
				}),
			),
		)
		await expect(loadUpdateManifest(releaseWithManifest, `${origin}/updates`)).rejects.toThrow(
			'outside this release',
		)
	})

	it('protects update metadata with the same Relay authentication', async () => {
		vi.stubEnv('MODBRIDGE_RELAY_SECRET', 'relay-secret')
		const fetchSpy = vi.fn()
		vi.stubGlobal('fetch', fetchSpy)
		const response = await relay.fetch(new Request(`${origin}/updates.json`))
		expect(response.status).toBe(401)
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it('streams ranged release downloads after checked GitHub redirects', async () => {
		const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
			if (url.includes('api.github.com')) return Response.json(release)
			if (url.startsWith(baseDownload))
				return new Response(null, {
					status: 302,
					headers: {
						location: 'https://release-assets.githubusercontent.com/file.zip?signature=test',
					},
				})
			return new Response('partial', {
				status: 206,
				headers: { 'content-range': 'bytes 0-6/100', 'accept-ranges': 'bytes' },
			})
		})
		vi.stubGlobal('fetch', fetchSpy)
		const response = await relay.fetch(
			new Request(`${origin}/updates/download/1.2.0/windows-x86_64/${release.assets[0].name}`, {
				headers: { range: 'bytes=0-6' },
			}),
		)
		expect(response.status).toBe(206)
		expect(response.headers.get('content-range')).toBe('bytes 0-6/100')
		expect(response.headers.get('access-control-allow-origin')).toBe('*')
		expect(await response.text()).toBe('partial')
		expect(fetchSpy.mock.calls[2][1].headers.get('range')).toBe('bytes=0-6')
		expect(fetchSpy.mock.calls.every((call) => call[1].redirect === 'manual')).toBe(true)
	})

	it('blocks a later malicious GitHub redirect before contacting it', async () => {
		const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
			if (url.includes('api.github.com')) return Response.json(release)
			if (url.startsWith(baseDownload))
				return new Response(null, {
					status: 302,
					headers: { location: 'https://release-assets.githubusercontent.com/next' },
				})
			return new Response(null, {
				status: 302,
				headers: { location: 'https://attacker.invalid/download' },
			})
		})
		vi.stubGlobal('fetch', fetchSpy)
		const response = await relay.fetch(
			new Request(`${origin}/updates/download/1.2.0/windows-x86_64/${release.assets[0].name}`),
		)
		expect(response.status).toBe(502)
		expect((await response.json()).error).toBe('BLOCKED_REDIRECT')
		expect(fetchSpy).toHaveBeenCalledTimes(3)
	})

	it('looks up old release tags directly instead of limiting download lookup to a release page', async () => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 404 }))
			.mockResolvedValueOnce(Response.json(release))
		vi.stubGlobal('fetch', fetchSpy)
		expect((await fetchReleaseByTag('1.2.0'))?.tag_name).toBe('v1.2.0')
		expect(fetchSpy.mock.calls[0][0]).toContain('/releases/tags/1.2.0')
		expect(fetchSpy.mock.calls[1][0]).toContain('/releases/tags/v1.2.0')
	})

	it('uses the documented server GitHub credential without forwarding client Relay secrets', async () => {
		vi.stubEnv('MODBRIDGE_GITHUB_TOKEN', 'server-github-secret')
		vi.stubEnv('MODBRIDGE_RELAY_SECRET', 'relay-secret')
		const fetchSpy = vi.fn().mockResolvedValue(Response.json(release))
		vi.stubGlobal('fetch', fetchSpy)
		await fetchReleaseByTag('v1.2.0')
		expect(fetchSpy.mock.calls[0][1].headers.get('authorization')).toBe(
			'Bearer server-github-secret',
		)
		expect(fetchSpy.mock.calls[0][1].headers.get('x-modbridge-token')).toBeNull()
	})

	it('returns HEAD metadata with no body and validates update channels', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([{ ...release, assets: [] }])))
		const head = await relay.fetch(new Request(`${origin}/updates/latest`, { method: 'HEAD' }))
		expect(head.status).toBe(200)
		expect(head.body).toBeNull()
		const invalid = await relay.fetch(new Request(`${origin}/updates/latest?channel=unknown`))
		expect(invalid.status).toBe(400)
	})

	it('recognizes signed universal macOS and Linux AppImage packages without installer collisions', () => {
		expect(assetPlatforms('Modbridge_universal.app.tar.gz')).toEqual([
			'darwin-x86_64',
			'darwin-aarch64',
		])
		expect(assetPlatforms('Modbridge.app.tar.gz')).toEqual(['darwin-x86_64', 'darwin-aarch64'])
		expect(assetPlatforms('Modbridge_universal.app.tar.gz.sig')).toEqual([])
		expect(assetPlatforms('Modbridge_aarch64.AppImage.tar.gz')).toEqual(['linux-aarch64'])
		expect(assetPlatforms('Modbridge_amd64.deb')).toEqual([])
	})

	it('orders numeric prereleases numerically and ignores build metadata', () => {
		expect(compareSemVer('1.2.0-beta.10', '1.2.0-beta.2')).toBe(1)
		expect(compareSemVer('1.2.0-beta.2', '1.2.0-beta.2.1')).toBe(-1)
		expect(compareSemVer('1.2.0-1', '1.2.0-alpha')).toBe(-1)
		expect(compareSemVer('1.2.0+build.123', '1.2.0+build.456')).toBe(0)
		expect(parseSemVer('1.2.0-beta.01')).toBeNull()
	})
})
