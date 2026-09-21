export function createErrorResponse(
	status: number,
	message: string,
	code?: string,
): Response {
	return new Response(
		JSON.stringify({
			error: code || `HTTP_${status}`,
			description: message,
		}),
		{
			status,
			headers: {
				'Content-Type': 'application/json',
				'Access-Control-Allow-Origin': '*',
			},
		},
	)
}
