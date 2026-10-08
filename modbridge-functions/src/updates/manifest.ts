import { fetchReleaseAsset, type GitHubAsset, type GitHubRelease } from './github.js'

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

export function assetPlatforms(assetName: string): string[] {
	const name = assetName.toLowerCase()
	if (name.endsWith('.sig') || name.endsWith('.sha256')) return []
	const arm = /aarch64|arm64/.test(name)
	if (name.endsWith('.nsis.zip') || name.endsWith('.msi.zip') || name.endsWith('.exe')) {
		return [arm ? 'windows-aarch64' : 'windows-x86_64']
	}
	if (name.endsWith('.appimage.tar.gz') || name.endsWith('.appimage')) {
		return [arm ? 'linux-aarch64' : 'linux-x86_64']
	}
	if (name.endsWith('.app.tar.gz')) {
		if (name.includes('universal')) return ['darwin-x86_64', 'darwin-aarch64']
		if (arm) return ['darwin-aarch64']
		if (/x86_64|x64|amd64/.test(name)) return ['darwin-x86_64']
		return ['darwin-x86_64', 'darwin-aarch64']
	}
	return []
}

export function buildUpdateManifest(
	release: GitHubRelease,
	updateOrigin: string,
	signatures: ReadonlyMap<string, string> = new Map(),
): TauriUpdateManifest {
	const version = release.tag_name.replace(/^v/i, '')
	const cleanOrigin = updateOrigin.replace(/\/$/, '')
	const platforms: Record<string, PlatformAssetInfo> = {}
	const priority = (name: string) =>
		/\.nsis\.zip$|\.msi\.zip$|\.appimage\.tar\.gz$/i.test(name) ? 1 : 0
	for (const asset of [...release.assets].sort((a, b) => priority(a.name) - priority(b.name))) {
		for (const platform of assetPlatforms(asset.name)) {
			platforms[platform] = {
				url: `${cleanOrigin}/download/${encodeURIComponent(version)}/${platform}/${encodeURIComponent(asset.name)}`,
				size: asset.size,
				...(signatures.has(asset.name) ? { signature: signatures.get(asset.name) } : {}),
			}
		}
	}
	return {
		version,
		notes: release.body || '',
		pub_date: release.published_at,
		channel: release.prerelease ? 'beta' : 'stable',
		release_notes_url: `${cleanOrigin}/manifest/${encodeURIComponent(version)}`,
		platforms,
	}
}

/** Builds an installable manifest using release signatures, retaining published platform mappings. */
export async function loadUpdateManifest(
	release: GitHubRelease,
	updateOrigin: string,
): Promise<TauriUpdateManifest> {
	const publishedAsset = release.assets.find((asset) => asset.name === 'latest.json')
	if (publishedAsset) {
		const { response } = await fetchReleaseAsset(publishedAsset)
		if (!response.ok) throw new Error(`Update manifest download returned HTTP ${response.status}`)
		const published = (await response.json()) as { platforms?: Record<string, PlatformAssetInfo> }
		const manifest = buildUpdateManifest(release, updateOrigin)
		manifest.platforms = {}
		for (const [platform, info] of Object.entries(published.platforms || {})) {
			if (
				!info ||
				typeof info.url !== 'string' ||
				typeof info.signature !== 'string' ||
				!info.signature.trim()
			)
				continue
			const upstreamUrl = new URL(info.url)
			const name = decodeURIComponent(upstreamUrl.pathname.split('/').pop() || '')
			const asset = release.assets.find(
				(asset) => asset.name === name && asset.browser_download_url === upstreamUrl.toString(),
			)
			if (!asset)
				throw new Error(`Update platform '${platform}' references an asset outside this release`)
			manifest.platforms[platform] = {
				url: `${updateOrigin.replace(/\/$/, '')}/download/${encodeURIComponent(manifest.version)}/${encodeURIComponent(platform)}/${encodeURIComponent(asset.name)}`,
				signature: info.signature.trim(),
				size: asset.size,
			}
		}
		return manifest
	}

	const signatures = new Map<string, string>()
	for (const asset of release.assets) {
		if (assetPlatforms(asset.name).length === 0) continue
		const signatureAsset = release.assets.find(
			(candidate) => candidate.name === `${asset.name}.sig`,
		)
		if (!signatureAsset) continue
		const { response } = await fetchReleaseAsset(signatureAsset)
		if (!response.ok) throw new Error(`Update signature download returned HTTP ${response.status}`)
		const signature = (await response.text()).trim()
		if (signature) signatures.set(asset.name, signature)
	}
	const manifest = buildUpdateManifest(
		{ ...release, assets: release.assets.filter((asset) => signatures.has(asset.name)) },
		updateOrigin,
		signatures,
	)
	return manifest
}
