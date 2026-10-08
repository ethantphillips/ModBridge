import { describe, it, expect } from 'vitest'
import { matchRoute, ALLOWED_UPSTREAM_HOSTS, ROUTE_MAPPINGS, isAllowedNodeHost } from '../src/relay/routing.js'

describe('Relay Routing', () => {
	it.each([
		['site', 'modrinth.com'],
		['staging-api', 'staging-api.modrinth.com'],
		['archon', 'archon.modrinth.com'],
		['staging-archon', 'staging-archon.modrinth.com'],
		['shared-instances', 'shared-instances.modrinth.com'],
		['staging-shared-instances', 'staging-shared-instances.modrinth.com'],
	])('routes the %s API through its allowlisted upstream', (route, hostname) => {
		const match = matchRoute(`/${route}/v1/servers`)
		expect(match?.target.upstreamHost).toBe(hostname)
		expect(match?.subpath).toBe('/v1/servers')
		expect(match?.target.enableRewrite).toBe(true)
	})

	it('supports the prior production WebSocket base path', () => {
		const match = matchRoute('/ws/_internal/launcher_socket')
		expect(match?.target.upstreamHost).toBe('api.modrinth.com')
		expect(match?.subpath).toBe('/_internal/launcher_socket')
	})

	it.each(['node-abc.modrinth.com', 'us-east.nodes.modrinth.com', 'node.us-east.nodes.modrinth.com'])('routes approved Hosting node %s', (hostname) => {
		expect(matchRoute(`/nodes/${hostname}/modrinth/v0/fs/list`)?.target.upstreamHost).toBe(hostname)
		expect(matchRoute(`/nodes/${hostname}/modrinth/v0/fs/list`)?.subpath).toBe('/modrinth/v0/fs/list')
	})

	it.each(['nodes.modrinth.com', 'modrinth.com', 'evil.nodes.modrinth.com.attacker.com', 'node-.modrinth.com', 'node-abc.modrinth.com:443', 'user@node-abc.modrinth.com', '127.0.0.1', 'evil/modrinth.com', '-invalid.nodes.modrinth.com'])('rejects unsupported node host %s', (hostname) => {
		expect(isAllowedNodeHost(hostname)).toBe(false)
		expect(matchRoute(`/nodes/${hostname}/ws`)).toBeNull()
	})

	it('matches Modrinth API routes', () => {
		const match = matchRoute('/api/v2/project/sodium')
		expect(match).not.toBeNull()
		expect(match?.target.upstreamHost).toBe('api.modrinth.com')
		expect(match?.subpath).toBe('/v2/project/sodium')
		expect(match?.target.category).toBe('modrinth-api')
	})

	it('matches Modrinth CDN routes', () => {
		const match = matchRoute('/cdn/data/AABBCCDD/versions/1.0.0/mod.jar')
		expect(match).not.toBeNull()
		expect(match?.target.upstreamHost).toBe('cdn.modrinth.com')
		expect(match?.subpath).toBe('/data/AABBCCDD/versions/1.0.0/mod.jar')
		expect(match?.target.category).toBe('modrinth-cdn')
	})

	it('matches Minecraft piston-meta routes', () => {
		const match = matchRoute('/minecraft/meta/mc/game/version_manifest_v2.json')
		expect(match).not.toBeNull()
		expect(match?.target.upstreamHost).toBe('piston-meta.mojang.com')
		expect(match?.subpath).toBe('/mc/game/version_manifest_v2.json')
	})

	it('matches Minecraft piston-data routes', () => {
		const match = matchRoute('/minecraft/data/v1/objects/abcdef/client.jar')
		expect(match).not.toBeNull()
		expect(match?.target.upstreamHost).toBe('piston-data.mojang.com')
		expect(match?.subpath).toBe('/v1/objects/abcdef/client.jar')
	})

	it('matches Minecraft asset download routes', () => {
		const match = matchRoute('/minecraft/assets/ab/abcdef123456')
		expect(match).not.toBeNull()
		expect(match?.target.upstreamHost).toBe('resources.download.minecraft.net')
		expect(match?.subpath).toBe('/ab/abcdef123456')
	})

	it('matches Minecraft library download routes', () => {
		const match = matchRoute('/minecraft/libraries/org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar')
		expect(match).not.toBeNull()
		expect(match?.target.upstreamHost).toBe('libraries.minecraft.net')
		expect(match?.subpath).toBe('/org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar')
	})

	it('matches Minecraft services routes', () => {
		const match = matchRoute('/minecraft/services/launcher/login')
		expect(match).not.toBeNull()
		expect(match?.target.upstreamHost).toBe('api.minecraftservices.com')
		expect(match?.subpath).toBe('/launcher/login')
	})

	it('matches Minecraft session routes', () => {
		const match = matchRoute('/minecraft/session/session/minecraft/hasJoined')
		expect(match).not.toBeNull()
		expect(match?.target.upstreamHost).toBe('sessionserver.mojang.com')
		expect(match?.subpath).toBe('/session/minecraft/hasJoined')
	})

	it('rejects arbitrary or unknown routes', () => {
		expect(matchRoute('/arbitrary/url')).toBeNull()
		expect(matchRoute('/proxy?url=https://evil.com')).toBeNull()
		expect(matchRoute('/google/search')).toBeNull()
		expect(matchRoute('/some-other-host')).toBeNull()
	})

	it('ensures all route targets are in the approved upstream allowlist', () => {
		for (const mapping of ROUTE_MAPPINGS) {
			expect(ALLOWED_UPSTREAM_HOSTS.has(mapping.target.upstreamHost)).toBe(true)
		}
	})
})
