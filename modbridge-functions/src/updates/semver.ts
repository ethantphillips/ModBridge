export interface ParsedSemVer {
	major: number
	minor: number
	patch: number
	prerelease?: string
}

export function parseSemVer(versionString: string): ParsedSemVer | null {
	const cleaned = versionString.trim().replace(/^v/i, '')
	const regex =
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
	const match = cleaned.match(regex)
	if (!match) {
		return null
	}
	if (
		match[4]
			?.split('.')
			.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))
	) {
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
		const identifiersA = parsedA.prerelease.split('.')
		const identifiersB = parsedB.prerelease.split('.')
		for (let index = 0; index < Math.max(identifiersA.length, identifiersB.length); index++) {
			const a = identifiersA[index]
			const b = identifiersB[index]
			if (a === b) continue
			if (a === undefined) return -1
			if (b === undefined) return 1
			const numericA = /^\d+$/.test(a)
			const numericB = /^\d+$/.test(b)
			if (numericA && numericB) return BigInt(a) > BigInt(b) ? 1 : -1
			if (numericA !== numericB) return numericA ? -1 : 1
			return a > b ? 1 : -1
		}
	}

	return 0
}
