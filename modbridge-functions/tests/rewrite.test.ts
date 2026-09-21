import { describe, it, expect } from 'vitest'
import { rewriteJsonContent } from '../src/relay/rewrite.js'

describe('URL Rewriting', () => {
	const relayOrigin = 'https://relay.modbridge.internal'

	it('rewrites Modrinth CDN URLs to relay CDN endpoints', () => {
		const input = JSON.stringify({
			files: [
				{
					url: 'https://cdn.modrinth.com/data/12345/versions/1.0/mod.jar',
					filename: 'mod.jar',
				},
			],
		})
		const output = rewriteJsonContent(input, relayOrigin)
		const parsed = JSON.parse(output)
		expect(parsed.files[0].url).toBe('https://relay.modbridge.internal/cdn/data/12345/versions/1.0/mod.jar')
	})

	it('rewrites launcher-meta URLs to relay meta endpoints', () => {
		const input = JSON.stringify({
			manifest: 'https://launcher-meta.modrinth.com/minecraft/v1/manifest.json',
		})
		const output = rewriteJsonContent(input, relayOrigin)
		const parsed = JSON.parse(output)
		expect(parsed.manifest).toBe('https://relay.modbridge.internal/meta/minecraft/v1/manifest.json')
	})

	it('rewrites Minecraft piston-meta and piston-data URLs', () => {
		const input = JSON.stringify({
			downloads: {
				client: {
					url: 'https://piston-data.mojang.com/v1/objects/112233/client.jar',
				},
			},
			assetIndex: {
				url: 'https://piston-meta.mojang.com/v1/packages/445566/1.20.1.json',
			},
		})
		const output = rewriteJsonContent(input, relayOrigin)
		const parsed = JSON.parse(output)
		expect(parsed.downloads.client.url).toBe('https://relay.modbridge.internal/minecraft/data/v1/objects/112233/client.jar')
		expect(parsed.assetIndex.url).toBe('https://relay.modbridge.internal/minecraft/meta/v1/packages/445566/1.20.1.json')
	})

	it('rewrites Minecraft libraries and assets URLs', () => {
		const input = JSON.stringify({
			library: 'https://libraries.minecraft.net/org/lwjgl/lwjgl.jar',
			asset: 'https://resources.download.minecraft.net/ab/abcdef123',
		})
		const output = rewriteJsonContent(input, relayOrigin)
		const parsed = JSON.parse(output)
		expect(parsed.library).toBe('https://relay.modbridge.internal/minecraft/libraries/org/lwjgl/lwjgl.jar')
		expect(parsed.asset).toBe('https://relay.modbridge.internal/minecraft/assets/ab/abcdef123')
	})

	it('does NOT rewrite unrelated external URLs', () => {
		const input = JSON.stringify({
			source_repo: 'https://github.com/someone/somerepo',
			discord: 'https://discord.gg/example',
			patreon: 'https://www.patreon.com/example',
			author_site: 'https://example.com/mod',
			docs: 'https://docs.modrinth.com',
		})
		const output = rewriteJsonContent(input, relayOrigin)
		const parsed = JSON.parse(output)
		expect(parsed.source_repo).toBe('https://github.com/someone/somerepo')
		expect(parsed.discord).toBe('https://discord.gg/example')
		expect(parsed.patreon).toBe('https://www.patreon.com/example')
		expect(parsed.author_site).toBe('https://example.com/mod')
		expect(parsed.docs).toBe('https://docs.modrinth.com')
	})
})
