export const GITHUB_OWNER = 'ethantphillips'
export const GITHUB_REPO = 'ModBridge'
export const GITHUB_API_BASE = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`

export const ALLOWED_GITHUB_DOWNLOAD_HOSTS = new Set([
	'github.com',
	'objects.githubusercontent.com',
	'github-releases.githubusercontent.com',
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

export async function fetchGitHubReleases(): Promise<GitHubRelease[]> {
	const headers: Record<string, string> = {
		Accept: 'application/vnd.github.v3+json',
		'User-Agent': 'Modbridge-Update-Function/1.0.0',
	}

	// Optional GitHub token for higher rate limits if configured
	const githubToken = process.env.GITHUB_TOKEN
	if (githubToken) {
		headers.Authorization = `token ${githubToken}`
	}

	const response = await fetch(`${GITHUB_API_BASE}/releases`, { headers })
	if (!response.ok) {
		throw new Error(`GitHub API returned HTTP ${response.status}: ${await response.text()}`)
	}

	return (await response.json()) as GitHubRelease[]
}

export async function fetchLatestRelease(includePrerelease = false): Promise<GitHubRelease | null> {
	const releases = await fetchGitHubReleases()
	const filtered = releases.filter((r) => !r.draft && (includePrerelease || !r.prerelease))
	return filtered[0] || null
}

export async function fetchReleaseByTag(tag: string): Promise<GitHubRelease | null> {
	const releases = await fetchGitHubReleases()
	const cleanTag = tag.replace(/^v/i, '')
	return releases.find((r) => r.tag_name.replace(/^v/i, '') === cleanTag) || null
}
