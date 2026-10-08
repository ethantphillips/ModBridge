import { once } from 'node:events'
import WebSocketClient, { WebSocketServer } from 'ws'
import { expect, it } from 'vitest'
import { bridgeWebSockets } from '../src/relay/websocket.js'

it('forwards real text and binary WebSocket frames over local loopback connections', async () => {
	const echo = new WebSocketServer({ host: '127.0.0.1', port: 0 })
	const bridge = new WebSocketServer({ host: '127.0.0.1', port: 0 })
	const sockets: WebSocketClient[] = []
	const cleanups: Array<() => void> = []
	let ready!: () => void
	const bridgeReady = new Promise<void>((resolve) => {
		ready = resolve
	})
	try {
		await Promise.all([echo, bridge].map((server) => once(server, 'listening')))
		echo.on('connection', (socket) => {
			sockets.push(socket)
			socket.on('message', (data, binary) => socket.send(data, { binary }))
		})
		bridge.on('connection', async (socket) => {
			const upstream = new WebSocketClient(
				`ws://127.0.0.1:${(echo.address() as { port: number }).port}`,
			)
			sockets.push(socket, upstream)
			await once(upstream, 'open')
			cleanups.push(bridgeWebSockets(socket as unknown as WebSocket, upstream))
			ready()
		})
		const client = new WebSocketClient(
			`ws://127.0.0.1:${(bridge.address() as { port: number }).port}`,
		)
		client.binaryType = 'arraybuffer'
		sockets.push(client)
		await Promise.all([once(client, 'open'), bridgeReady])
		const text = once(client, 'message')
		client.send('{"event":"auth","jwt":"user-session"}')
		const [textData, textIsBinary] = await text
		expect(textData.toString()).toBe('{"event":"auth","jwt":"user-session"}')
		expect(textIsBinary).toBe(false)
		const binary = once(client, 'message')
		client.send(new Uint8Array([0, 1, 255]))
		const [binaryData, binaryIsBinary] = await binary
		expect(new Uint8Array(binaryData)).toEqual(new Uint8Array([0, 1, 255]))
		expect(binaryIsBinary).toBe(true)
	} finally {
		for (const cleanup of cleanups) cleanup()
		for (const socket of sockets) socket.terminate()
		await Promise.all(
			[echo, bridge].map(
				(server) =>
					new Promise<void>((resolve, reject) =>
						server.close((error) => (error ? reject(error) : resolve())),
					),
			),
		)
	}
})
