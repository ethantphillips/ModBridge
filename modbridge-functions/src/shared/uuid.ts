import { createHash } from 'node:crypto'

export function normalizeUsername(username: string): string {
	return username.trim().toLowerCase()
}

export function deriveOfflineUuid(username: string, pin: string): string {
	const trimmedUsername = username.trim()
	if (!trimmedUsername) {
		throw new Error('Username cannot be empty')
	}
	if (!/^[a-zA-Z0-9_]+$/.test(trimmedUsername)) {
		throw new Error('Username contains invalid characters (allowed: a-z, A-Z, 0-9, _)')
	}

	const trimmedPin = pin.trim()
	if (!trimmedPin) {
		throw new Error('Identity PIN cannot be empty')
	}

	const normalized = normalizeUsername(trimmedUsername)
	const input = `modbridge:offline-player:v1:${normalized}:${trimmedPin}`

	const hash = createHash('sha256').update(input, 'utf8').digest()

	const bytes = new Uint8Array(hash.buffer, hash.byteOffset, 16)
	const uuidBytes = new Uint8Array(bytes)

	// Set RFC 4122 variant (bits 6-7 of octet 8 to 10)
	uuidBytes[8] = (uuidBytes[8] & 0x3f) | 0x80

	// Set RFC 4122 version 4 (bits 4-7 of octet 6 to 0100)
	uuidBytes[6] = (uuidBytes[6] & 0x0f) | 0x40

	const hex = Array.from(uuidBytes, (b) => b.toString(16).padStart(2, '0')).join('')
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}
