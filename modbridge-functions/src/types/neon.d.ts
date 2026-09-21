declare module '@neon/config/v1' {
	export interface NeonFunctionConfig {
		name?: string
		source: string
	}

	export interface NeonPreviewConfig {
		functions?: Record<string, NeonFunctionConfig>
	}

	export interface NeonConfig {
		preview?: NeonPreviewConfig
		functions?: Record<string, NeonFunctionConfig>
	}

	export function defineConfig(config: NeonConfig): NeonConfig
}
