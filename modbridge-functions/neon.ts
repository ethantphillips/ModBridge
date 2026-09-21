import { defineConfig } from '@neon/config/v1'

export default defineConfig({
	preview: {
		functions: {
			relay: {
				name: 'Modbridge Relay',
				source: './src/relay/index.ts',
			},
			updates: {
				name: 'Modbridge Updates',
				source: './src/updates/index.ts',
			},
		},
	},
})
