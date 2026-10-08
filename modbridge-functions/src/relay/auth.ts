export function validateRelayAuth(request: Request): { authorized: boolean; reason?: string } {
	const secret = process.env.MODBRIDGE_RELAY_SECRET || process.env.MODBRIDGE_RELAY_TOKEN

	// If no secret configured in the environment, allow access (open dev mode)
	if (!secret || secret.trim() === '') {
		return { authorized: true }
	}

	// Check custom header first (avoids colliding with upstream Authorization)
	const customHeader = request.headers.get('x-modbridge-token')
	if (customHeader && customHeader === secret) {
		return { authorized: true }
	}

	// Check Authorization header
	const authHeader = request.headers.get('authorization')
	if (authHeader) {
		const match = authHeader.match(/^Bearer\s+(.+)$/i)
		if (match && match[1] === secret) {
			return { authorized: true }
		}
	}

	// Check query string token for streaming downloads where headers may not be attachable
	const url = new URL(request.url)
	const queryTokens = [
		...url.searchParams.getAll('relay_token'),
		...url.searchParams.getAll('token'),
	]
	if (queryTokens.includes(secret)) {
		return { authorized: true }
	}

	return { authorized: false, reason: 'Missing or invalid relay authorization token' }
}

export function stripRelayQueryAuth(params: URLSearchParams): URLSearchParams {
	const forwarded = new URLSearchParams()
	const secret = process.env.MODBRIDGE_RELAY_SECRET || process.env.MODBRIDGE_RELAY_TOKEN
	for (const [key, value] of params) {
		if (key === 'relay_token' || (key === 'token' && secret && value === secret)) continue
		forwarded.append(key, value)
	}
	return forwarded
}
