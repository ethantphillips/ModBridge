export interface ParsedSemVer {
	major: number
	minor: number
	patch: number
	prerelease?: string
}

export function parseSemVer(versionString: string): ParsedSemVer | null {
	const cleaned = versionString.trim().replace(/^v/i, '')
	const regex = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/
	const match = cleaned.match(regex)
	if (!match) {
		return null
	}

	return {
		major: parseInt(match[1], 10),
		minor: parseInt(match[2], 10),
		patch: parseInt(match[3], 10),
		prerelease: match[4],
	}
}

/**
 * Returns:
 *   1 if a > b
 *  -1 if a < b
 *   0 if a == b
 */
export function compareSemVer(a: string, b: string): number {
	const parsedA = parseSemVer(a)
	const parsedB = parseSemVer(b)

	if (!parsedA || !parsedB) {
		return a.localeCompare(b)
	}

	if (parsedA.major !== parsedB.major) {
		return parsedA.major > parsedB.major ? 1 : -1
	}
	if (parsedA.minor !== parsedB.minor) {
		return parsedA.minor > parsedB.minor ? 1 : -1
	}
	if (parsedA.patch !== parsedB.patch) {
		return parsedA.patch > parsedB.patch ? 1 : -1
	}

	// Stable releases have higher precedence than prereleases
	if (!parsedA.prerelease && parsedB.prerelease) {
		return 1
	}
	if (parsedA.prerelease && !parsedB.prerelease) {
		return -1
	}
	if (parsedA.prerelease && parsedB.prerelease) {
		return parsedA.prerelease.localeCompare(parsedB.prerelease)
	}

	return 0
}
