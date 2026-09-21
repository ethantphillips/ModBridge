import { defineConfig } from '@neon/config/v1'

export default defineConfig({
	preview: {
		functions: {
			relay: {
				name: 'ModBridge Relay',
				source: './src/relay/index.ts',
			},
			updates: {
				name: 'ModBridge Updates',
				source: './src/updates/index.ts',
			},
		},
	},
})
