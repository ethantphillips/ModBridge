import type { GitHubRelease } from './github.js'

export interface PlatformAssetInfo {
	url: string
	signature?: string
	sha256?: string
	size?: number
}

export interface TauriUpdateManifest {
	version: string
	notes?: string
	pub_date?: string
	channel: 'stable' | 'beta'
	release_notes_url: string
	platforms: Record<string, PlatformAssetInfo>
}

export function buildUpdateManifest(release: GitHubRelease, updateOrigin: string): TauriUpdateManifest {
	const version = release.tag_name.replace(/^v/i, '')
	const cleanOrigin = updateOrigin.replace(/\/$/, '')

	const platforms: Record<string, PlatformAssetInfo> = {}

	// Scan release assets to map binaries and optional signatures/checksums
	for (const asset of release.assets) {
		const name = asset.name.toLowerCase()

		// Windows x86_64
		if ((name.includes('windows') || name.endsWith('.msi.zip') || name.endsWith('.nsis.zip') || name.endsWith('.exe')) && !name.endsWith('.sig') && !name.endsWith('.sha256')) {
			platforms['windows-x86_64'] = {
				url: `${cleanOrigin}/download/${version}/windows-x86_64/${encodeURIComponent(asset.name)}`,
				size: asset.size,
			}
		}

		// Linux x86_64
		if ((name.includes('linux') || name.endsWith('.appimage.tar.gz') || name.endsWith('.deb')) && !name.endsWith('.sig') && !name.endsWith('.sha256')) {
			platforms['linux-x86_64'] = {
				url: `${cleanOrigin}/download/${version}/linux-x86_64/${encodeURIComponent(asset.name)}`,
				size: asset.size,
			}
		}

		// macOS x86_64
		if (name.includes('darwin-x86_64') || (name.includes('mac') && name.includes('x64') && name.endsWith('.app.tar.gz'))) {
			platforms['darwin-x86_64'] = {
				url: `${cleanOrigin}/download/${version}/darwin-x86_64/${encodeURIComponent(asset.name)}`,
				size: asset.size,
			}
		}

		// macOS aarch64
		if (name.includes('darwin-aarch64') || name.includes('darwin-arm64') || (name.includes('mac') && name.includes('aarch64') && name.endsWith('.app.tar.gz'))) {
			platforms['darwin-aarch64'] = {
				url: `${cleanOrigin}/download/${version}/darwin-aarch64/${encodeURIComponent(asset.name)}`,
				size: asset.size,
			}
		}
	}

	return {
		version,
		notes: release.body || '',
		pub_date: release.published_at,
		channel: release.prerelease ? 'beta' : 'stable',
		release_notes_url: `https://github.com/ethantphillips/ModBridge/releases/tag/${release.tag_name}`,
		platforms,
	}
}
