const REWRITE_RULES: Array<{ pattern: RegExp; replacement: (relayOrigin: string) => string }> = [
	{
		pattern: /https:\/\/cdn\.modrinth\.com/g,
		replacement: (origin) => `${origin}/cdn`,
	},
	{
		pattern: /https:\/\/launcher-meta\.modrinth\.com/g,
		replacement: (origin) => `${origin}/meta`,
	},
	{
		pattern: /https:\/\/piston-meta\.mojang\.com/g,
		replacement: (origin) => `${origin}/minecraft/meta`,
	},
	{
		pattern: /https:\/\/piston-data\.mojang\.com/g,
		replacement: (origin) => `${origin}/minecraft/data`,
	},
	{
		pattern: /https:\/\/resources\.download\.minecraft\.net/g,
		replacement: (origin) => `${origin}/minecraft/assets`,
	},
	{
		pattern: /https:\/\/libraries\.minecraft\.net/g,
		replacement: (origin) => `${origin}/minecraft/libraries`,
	},
	{
		pattern: /https:\/\/api\.minecraftservices\.com/g,
		replacement: (origin) => `${origin}/minecraft/services`,
	},
	{
		pattern: /https:\/\/sessionserver\.mojang\.com/g,
		replacement: (origin) => `${origin}/minecraft/session`,
	},
	{
		pattern: /https?:\/\/textures\.minecraft\.net/g,
		replacement: (origin) => `${origin}/minecraft/textures`,
	},
	{
		pattern: /https:\/\/launchermeta\.mojang\.com/g,
		replacement: (origin) => `${origin}/minecraft/legacy-meta`,
	},
	{
		pattern: /https:\/\/launcher\.mojang\.com/g,
		replacement: (origin) => `${origin}/minecraft/legacy-launcher`,
	},
]

export function rewriteJsonContent(jsonText: string, relayOrigin: string): string {
	let rewritten = jsonText
	const cleanOrigin = relayOrigin.replace(/\/$/, '')

	for (const rule of REWRITE_RULES) {
		rewritten = rewritten.replace(rule.pattern, rule.replacement(cleanOrigin))
	}

	return rewritten
}
