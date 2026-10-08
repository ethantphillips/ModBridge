import { fetchAllowlisted } from '../shared/fetch.js'
import { compareSemVer } from './semver.js'

export const GITHUB_OWNER = 'ethantphillips'
export const GITHUB_REPO = 'ModBridge'
export const GITHUB_API_BASE = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`

export const ALLOWED_GITHUB_DOWNLOAD_HOSTS = new Set([
	'github.com',
	'objects.githubusercontent.com',
	'github-releases.githubusercontent.com',
	'release-assets.githubusercontent.com',
	'raw.githubusercontent.com',
])

export interface GitHubAsset {
	name: string
	browser_download_url: string
	size: number
	content_type: string
}

export interface GitHubRelease {
	tag_name: string
	name: string
	body?: string
	draft: boolean
	prerelease: boolean
	published_at: string
	assets: GitHubAsset[]
}

async function fetchGitHub(path: string): Promise<Response> {
	const headers: Record<string, string> = {
		Accept: 'application/vnd.github.v3+json',
		'User-Agent': 'ModBridge-Update-Function/1.0.0',
	}
	const githubToken = process.env.MODBRIDGE_GITHUB_TOKEN || process.env.GITHUB_TOKEN
	if (githubToken) headers.Authorization = `Bearer ${githubToken}`
	return (
		await fetchAllowlisted(`${GITHUB_API_BASE}${path}`, { headers }, new Set(['api.github.com']))
	).response
}

export async function fetchGitHubReleases(): Promise<GitHubRelease[]> {
	const response = await fetchGitHub('/releases?per_page=100')
	if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`)
	return (await response.json()) as GitHubRelease[]
}

export async function fetchLatestRelease(includePrerelease = false): Promise<GitHubRelease | null> {
	const releases = await fetchGitHubReleases()
	const filtered = releases.filter(
		(release) => !release.draft && (includePrerelease || !release.prerelease),
	)
	filtered.sort((a, b) => compareSemVer(b.tag_name, a.tag_name))
	return filtered[0] || null
}

export async function fetchReleaseByTag(tag: string): Promise<GitHubRelease | null> {
	for (const candidate of new Set([tag, tag.startsWith('v') ? tag.slice(1) : `v${tag}`])) {
		const response = await fetchGitHub(`/releases/tags/${encodeURIComponent(candidate)}`)
		if (response.status === 404) continue
		if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`)
		const release = (await response.json()) as GitHubRelease
		return release.draft ? null : release
	}
	return null
}

export async function fetchReleaseAsset(
	asset: GitHubAsset,
	init: RequestInit = {},
): Promise<{ response: Response; url: URL }> {
	const url = new URL(asset.browser_download_url)
	if (
		url.hostname !== 'github.com' ||
		!url.pathname.startsWith(`/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/`)
	) {
		throw new Error('Release asset is not hosted by the ModBridge repository')
	}
	return fetchAllowlisted(url, init, ALLOWED_GITHUB_DOWNLOAD_HOSTS)
}
