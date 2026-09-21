import type { RouteTarget } from '../shared/types.js'

export const ALLOWED_UPSTREAM_HOSTS = new Set([
	'api.modrinth.com',
	'cdn.modrinth.com',
	'staging-cdn.modrinth.com',
	'launcher-meta.modrinth.com',
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
		prefix: '/cdn',
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
		prefix: '/minecraft/meta',
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
		prefix: '/minecraft/assets',
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
		prefix: '/minecraft/services',
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
		prefix: '/minecraft/legacy-meta',
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
]

export function matchRoute(pathname: string): { target: RouteTarget; subpath: string } | null {
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
