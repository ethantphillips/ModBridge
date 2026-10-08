import type { RouteTarget } from '../shared/types.js'

export const ALLOWED_UPSTREAM_HOSTS = new Set([
	'api.modrinth.com',
	'staging-api.modrinth.com',
	'modrinth.com',
	'api.github.com',
	'avatars.githubusercontent.com',
	'avatars0.githubusercontent.com',
	'avatars1.githubusercontent.com',
	'avatars2.githubusercontent.com',
	'avatars3.githubusercontent.com',
	'cdn.modrinth.com',
	'staging-cdn.modrinth.com',
	'archon.modrinth.com',
	'staging-archon.modrinth.com',
	'shared-instances.modrinth.com',
	'staging-shared-instances.modrinth.com',
	'api.azul.com',
	'cdn.azul.com',
	'fill.papermc.io',
	'api.purpurmc.org',
	'api.mclo.gs',
	'flagcdn.com',
	'launcher-meta.modrinth.com',
	'launcher-files.modrinth.com',
	'piston-meta.mojang.com',
	'piston-data.mojang.com',
	'resources.download.minecraft.net',
	'libraries.minecraft.net',
	'api.minecraftservices.com',
	'sessionserver.mojang.com',
	'textures.minecraft.net',
	'launchermeta.mojang.com',
	'launcher.mojang.com',
])

interface RouteMapping {
	prefix: string
	target: RouteTarget
}

export const ROUTE_MAPPINGS: RouteMapping[] = [
	...[
		['/staging-api', 'staging-api.modrinth.com'],
		['/site', 'modrinth.com'],
	].map(([prefix, upstreamHost]): RouteMapping => ({
		prefix,
		target: { upstreamHost, upstreamPrefix: '', category: 'modrinth-api', enableRewrite: true },
	})),
	{
		prefix: '/github-api',
		target: {
			upstreamHost: 'api.github.com',
			upstreamPrefix: '',
			category: 'modrinth-api',
			enableRewrite: true,
		},
	},
	{
		prefix: '/github-avatars',
		target: {
			upstreamHost: 'avatars.githubusercontent.com',
			upstreamPrefix: '',
			category: 'media',
			enableRewrite: true,
		},
	},
	{
		prefix: '/github-avatars0',
		target: {
			upstreamHost: 'avatars0.githubusercontent.com',
			upstreamPrefix: '',
			category: 'media',
			enableRewrite: true,
		},
	},
	{
		prefix: '/github-avatars1',
		target: {
			upstreamHost: 'avatars1.githubusercontent.com',
			upstreamPrefix: '',
			category: 'media',
			enableRewrite: true,
		},
	},
	{
		prefix: '/github-avatars2',
		target: {
			upstreamHost: 'avatars2.githubusercontent.com',
			upstreamPrefix: '',
			category: 'media',
			enableRewrite: true,
		},
	},
	{
		prefix: '/github-avatars3',
		target: {
			upstreamHost: 'avatars3.githubusercontent.com',
			upstreamPrefix: '',
			category: 'media',
			enableRewrite: true,
		},
	},
	{
		prefix: '/staging-cdn',
		target: {
			upstreamHost: 'staging-cdn.modrinth.com',
			upstreamPrefix: '',
			category: 'modrinth-cdn',
		},
	},
	{
		prefix: '/archon',
		target: {
			upstreamHost: 'archon.modrinth.com',
			upstreamPrefix: '',
			category: 'hosting',
			enableRewrite: true,
		},
	},
	{
		prefix: '/staging-archon',
		target: {
			upstreamHost: 'staging-archon.modrinth.com',
			upstreamPrefix: '',
			category: 'hosting',
			enableRewrite: true,
		},
	},
	{
		prefix: '/shared-instances',
		target: {
			upstreamHost: 'shared-instances.modrinth.com',
			upstreamPrefix: '',
			category: 'hosting',
			enableRewrite: true,
		},
	},
	{
		prefix: '/staging-shared-instances',
		target: {
			upstreamHost: 'staging-shared-instances.modrinth.com',
			upstreamPrefix: '',
			category: 'hosting',
			enableRewrite: true,
		},
	},
	{
		prefix: '/azul-api',
		target: {
			upstreamHost: 'api.azul.com',
			upstreamPrefix: '',
			category: 'java',
			enableRewrite: true,
		},
	},
	{
		prefix: '/azul-cdn',
		target: {
			upstreamHost: 'cdn.azul.com',
			upstreamPrefix: '',
			category: 'java',
			enableRewrite: true,
		},
	},
	{
		prefix: '/paper',
		target: {
			upstreamHost: 'fill.papermc.io',
			upstreamPrefix: '',
			category: 'hosting',
			enableRewrite: true,
		},
	},
	{
		prefix: '/purpur',
		target: {
			upstreamHost: 'api.purpurmc.org',
			upstreamPrefix: '',
			category: 'hosting',
			enableRewrite: true,
		},
	},
	{
		prefix: '/mclogs',
		target: {
			upstreamHost: 'api.mclo.gs',
			upstreamPrefix: '',
			category: 'logs',
			enableRewrite: true,
		},
	},
	{
		prefix: '/flags',
		target: {
			upstreamHost: 'flagcdn.com',
			upstreamPrefix: '',
			category: 'media',
			enableRewrite: true,
		},
	},
	{
		prefix: '/api',
		target: {
			upstreamHost: 'api.modrinth.com',
			upstreamPrefix: '',
			category: 'modrinth-api',
			enableRewrite: true,
		},
	},
	{
		prefix: '/ws',
		target: {
			upstreamHost: 'api.modrinth.com',
			upstreamPrefix: '',
			category: 'modrinth-api',
			enableRewrite: true,
		},
	},
	{
		prefix: '/modrinth/api',
		target: {
			upstreamHost: 'api.modrinth.com',
			upstreamPrefix: '',
			category: 'modrinth-api',
			enableRewrite: true,
		},
	},
	{
		prefix: '/cdn',
		target: {
			upstreamHost: 'cdn.modrinth.com',
			upstreamPrefix: '',
			category: 'modrinth-cdn',
		},
	},
	{
		prefix: '/modrinth/cdn',
		target: {
			upstreamHost: 'cdn.modrinth.com',
			upstreamPrefix: '',
			category: 'modrinth-cdn',
		},
	},
	{
		prefix: '/meta',
		target: {
			upstreamHost: 'launcher-meta.modrinth.com',
			upstreamPrefix: '',
			category: 'modrinth-cdn',
			enableRewrite: true,
		},
	},
	{
		prefix: '/launcher-meta',
		target: {
			upstreamHost: 'launcher-meta.modrinth.com',
			upstreamPrefix: '',
			category: 'modrinth-cdn',
			enableRewrite: true,
		},
	},
	{
		prefix: '/launcher-files',
		target: {
			upstreamHost: 'launcher-files.modrinth.com',
			upstreamPrefix: '',
			category: 'modrinth-cdn',
		},
	},
	{
		prefix: '/minecraft/meta',
		target: {
			upstreamHost: 'piston-meta.mojang.com',
			upstreamPrefix: '',
			category: 'minecraft-meta',
			enableRewrite: true,
		},
	},
	{
		prefix: '/piston-meta',
		target: {
			upstreamHost: 'piston-meta.mojang.com',
			upstreamPrefix: '',
			category: 'minecraft-meta',
			enableRewrite: true,
		},
	},
	{
		prefix: '/minecraft/data',
		target: {
			upstreamHost: 'piston-data.mojang.com',
			upstreamPrefix: '',
			category: 'minecraft-data',
		},
	},
	{
		prefix: '/piston-data',
		target: {
			upstreamHost: 'piston-data.mojang.com',
			upstreamPrefix: '',
			category: 'minecraft-data',
		},
	},
	{
		prefix: '/minecraft/assets',
		target: {
			upstreamHost: 'resources.download.minecraft.net',
			upstreamPrefix: '',
			category: 'minecraft-assets',
		},
	},
	{
		prefix: '/minecraft-resources',
		target: {
			upstreamHost: 'resources.download.minecraft.net',
			upstreamPrefix: '',
			category: 'minecraft-assets',
		},
	},
	{
		prefix: '/minecraft/libraries',
		target: {
			upstreamHost: 'libraries.minecraft.net',
			upstreamPrefix: '',
			category: 'minecraft-libraries',
		},
	},
	{
		prefix: '/minecraft-libraries',
		target: {
			upstreamHost: 'libraries.minecraft.net',
			upstreamPrefix: '',
			category: 'minecraft-libraries',
		},
	},
	{
		prefix: '/minecraft/services',
		target: {
			upstreamHost: 'api.minecraftservices.com',
			upstreamPrefix: '',
			category: 'minecraft-services',
			enableRewrite: true,
		},
	},
	{
		prefix: '/minecraft-services',
		target: {
			upstreamHost: 'api.minecraftservices.com',
			upstreamPrefix: '',
			category: 'minecraft-services',
			enableRewrite: true,
		},
	},
	{
		prefix: '/minecraft/session',
		target: {
			upstreamHost: 'sessionserver.mojang.com',
			upstreamPrefix: '',
			category: 'minecraft-session',
			enableRewrite: true,
		},
	},
	{
		prefix: '/mojang-session',
		target: {
			upstreamHost: 'sessionserver.mojang.com',
			upstreamPrefix: '',
			category: 'minecraft-session',
			enableRewrite: true,
		},
	},
	{
		prefix: '/minecraft/textures',
		target: {
			upstreamHost: 'textures.minecraft.net',
			upstreamPrefix: '',
			category: 'minecraft-textures',
		},
	},
	{
		prefix: '/minecraft-textures',
		target: {
			upstreamHost: 'textures.minecraft.net',
			upstreamPrefix: '',
			category: 'minecraft-textures',
		},
	},
	{
		prefix: '/minecraft/legacy-meta',
		target: {
			upstreamHost: 'launchermeta.mojang.com',
			upstreamPrefix: '',
			category: 'minecraft-meta',
			enableRewrite: true,
		},
	},
	{
		prefix: '/mojang-meta',
		target: {
			upstreamHost: 'launchermeta.mojang.com',
			upstreamPrefix: '',
			category: 'minecraft-meta',
			enableRewrite: true,
		},
	},
	{
		prefix: '/minecraft/legacy-launcher',
		target: {
			upstreamHost: 'launcher.mojang.com',
			upstreamPrefix: '',
			category: 'minecraft-meta',
			enableRewrite: true,
		},
	},
	{
		prefix: '/mojang-launcher',
		target: {
			upstreamHost: 'launcher.mojang.com',
			upstreamPrefix: '',
			category: 'minecraft-meta',
			enableRewrite: true,
		},
	},
]

export function matchRoute(pathname: string): { target: RouteTarget; subpath: string } | null {
	const nodeRoute = pathname.match(/^\/nodes\/([^/]+)(\/.*)?$/)
	if (nodeRoute && isAllowedNodeHost(nodeRoute[1])) {
		return {
			target: {
				upstreamHost: nodeRoute[1],
				upstreamPrefix: '',
				category: 'hosting',
				enableRewrite: true,
			},
			subpath: nodeRoute[2] || '/',
		}
	}
	for (const mapping of ROUTE_MAPPINGS) {
		if (pathname === mapping.prefix) {
			return { target: mapping.target, subpath: '/' }
		}
		if (pathname.startsWith(mapping.prefix + '/')) {
			const subpath = pathname.slice(mapping.prefix.length)
			return { target: mapping.target, subpath: subpath.startsWith('/') ? subpath : `/${subpath}` }
		}
	}
	return null
}

export function isAllowedNodeHost(host: string): boolean {
	return (
		host.length <= 253 &&
		(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+nodes\.modrinth\.com$/.test(host)
			|| /^node-[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?\.modrinth\.com$/.test(host))
	)
}
