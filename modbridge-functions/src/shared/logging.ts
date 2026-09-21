export interface LogEntry {
	timestamp: string
	functionName: string
	method: string
	route: string
	upstreamHost?: string
	status?: number
	durationMs?: number
	error?: string
}

export function logProxyRequest(entry: LogEntry): void {
	console.log(
		JSON.stringify({
			timestamp: entry.timestamp || new Date().toISOString(),
			function: entry.functionName,
			method: entry.method,
			route: entry.route,
			upstreamHost: entry.upstreamHost,
			status: entry.status,
			durationMs: entry.durationMs,
			error: entry.error,
		}),
	)
}
