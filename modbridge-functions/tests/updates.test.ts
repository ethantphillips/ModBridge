import { describe, it, expect } from 'vitest'
import { compareSemVer, parseSemVer } from '../src/updates/semver.js'
import { buildUpdateManifest } from '../src/updates/manifest.js'
import { GITHUB_OWNER, GITHUB_REPO, GITHUB_API_BASE } from '../src/updates/github.js'

describe('Updates & Versioning', () => {
	it('locks repository exclusively to ethantphillips/ModBridge', () => {
		expect(GITHUB_OWNER).toBe('ethantphillips')
		expect(GITHUB_REPO).toBe('ModBridge')
		expect(GITHUB_API_BASE).toBe('https://api.github.com/repos/ethantphillips/ModBridge')
	})

	describe('SemVer comparison', () => {
		it('correctly compares minor versions (1.10.0 > 1.9.0)', () => {
			expect(compareSemVer('1.10.0', '1.9.0')).toBe(1)
			expect(compareSemVer('1.9.0', '1.10.0')).toBe(-1)
		})

		it('correctly compares patch versions (1.0.1 > 1.0.0)', () => {
			expect(compareSemVer('1.0.1', '1.0.0')).toBe(1)
			expect(compareSemVer('1.0.0', '1.0.1')).toBe(-1)
		})

		it('correctly compares major versions (2.0.0 > 1.99.99)', () => {
			expect(compareSemVer('2.0.0', '1.99.99')).toBe(1)
			expect(compareSemVer('1.99.99', '2.0.0')).toBe(-1)
		})

		it('considers equal versions equal', () => {
			expect(compareSemVer('1.2.3', '1.2.3')).toBe(0)
			expect(compareSemVer('v1.2.3', '1.2.3')).toBe(0)
		})

		it('ranks stable releases higher than prereleases', () => {
			expect(compareSemVer('1.0.0', '1.0.0-beta.1')).toBe(1)
			expect(compareSemVer('1.0.0-beta.1', '1.0.0')).toBe(-1)
		})
	})

	describe('Manifest building', () => {
		it('builds a valid Tauri v2 updater manifest', () => {
			const mockRelease = {
				tag_name: 'v1.0.5',
				name: 'Modbridge 1.0.5',
				body: 'Release notes for 1.0.5',
				draft: false,
				prerelease: false,
				published_at: '2026-09-21T00:00:00Z',
				assets: [
					{
						name: 'Modbridge-1.0.5-windows-x86_64.msi.zip',
						browser_download_url: 'https://github.com/ethantphillips/ModBridge/releases/download/v1.0.5/Modbridge-1.0.5-windows-x86_64.msi.zip',
						size: 80000000,
						content_type: 'application/zip',
					},
					{
						name: 'Modbridge-1.0.5-linux-x86_64.AppImage.tar.gz',
						browser_download_url: 'https://github.com/ethantphillips/ModBridge/releases/download/v1.0.5/Modbridge-1.0.5-linux-x86_64.AppImage.tar.gz',
						size: 90000000,
						content_type: 'application/gzip',
					},
				],
			}

			const manifest = buildUpdateManifest(mockRelease, 'https://updates.modbridge.internal')
			expect(manifest.version).toBe('1.0.5')
			expect(manifest.channel).toBe('stable')
			expect(manifest.platforms['windows-x86_64']).toBeDefined()
			expect(manifest.platforms['windows-x86_64'].url).toContain('https://updates.modbridge.internal/download/1.0.5/windows-x86_64/')
			expect(manifest.platforms['linux-x86_64']).toBeDefined()
			expect(manifest.platforms['linux-x86_64'].url).toContain('https://updates.modbridge.internal/download/1.0.5/linux-x86_64/')
		})
	})
})
