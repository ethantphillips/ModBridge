import { describe, it, expect } from 'vitest'
import { deriveOfflineUuid, normalizeUsername } from '../src/shared/uuid.js'

describe('Deterministic Offline UUID Derivation', () => {
	it('consistently derives identical UUID for same username and same PIN', () => {
		const uuid1 = deriveOfflineUuid('Steve', '1234')
		const uuid2 = deriveOfflineUuid('Steve', '1234')
		expect(uuid1).toBe(uuid2)
	})

	it('derives different UUIDs for different PINs with same username', () => {
		const uuid1 = deriveOfflineUuid('Steve', '1234')
		const uuid2 = deriveOfflineUuid('Steve', '5678')
		expect(uuid1).not.toBe(uuid2)
	})

	it('derives different UUIDs for different usernames with same PIN', () => {
		const uuid1 = deriveOfflineUuid('Steve', '1234')
		const uuid2 = deriveOfflineUuid('Alex', '1234')
		expect(uuid1).not.toBe(uuid2)
	})

	it('normalizes username casing so Steve and steve produce identical UUIDs', () => {
		const uuid1 = deriveOfflineUuid('Steve', '1234')
		const uuid2 = deriveOfflineUuid('steve', '1234')
		expect(uuid1).toBe(uuid2)
	})

	it('validates against locked test vectors generated from algorithm', () => {
		const steve1234 = deriveOfflineUuid('Steve', '1234')
		const steve5678 = deriveOfflineUuid('Steve', '5678')
		const alex1234 = deriveOfflineUuid('Alex', '1234')

		expect(steve1234).toBe('e199b16b-7efd-4584-a964-04038430f6cf')
		expect(steve5678).toBe('dbb6aacc-f85b-478e-8219-147c5d195790')
		expect(alex1234).toBe('4faf5a1e-ab98-473c-81c9-e452cf027e50')
	})

	it('sets valid RFC 4122 Variant and Version 4 bits', () => {
		const uuid = deriveOfflineUuid('Steve', '1234')
		// Version 4 is at char 14 (8-4-[4]-4-12)
		expect(uuid.charAt(14)).toBe('4')
		// Variant (8, 9, a, or b) is at char 19 (8-4-4-[4]-12)
		const variantChar = uuid.charAt(19).toLowerCase()
		expect(['8', '9', 'a', 'b']).toContain(variantChar)
	})

	it('validates input format', () => {
		expect(() => deriveOfflineUuid('', '1234')).toThrow(/empty/i)
		expect(() => deriveOfflineUuid('Steve', '')).toThrow(/empty/i)
		expect(() => deriveOfflineUuid('Invalid Name!', '1234')).toThrow(/invalid characters/i)
	})
})
