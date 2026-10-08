import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	readUpdateSize,
	runUpdateCheckWithRetry,
	selectUpdateResource,
} from '../../apps/app-frontend/src/helpers/app-update.ts'

afterEach(() => vi.useRealTimers())

describe('desktop update resource ownership', () => {
	it('closes ignored duplicate resources while retaining the displayed update', async () => {
		const close = vi.fn().mockResolvedValue(undefined)
		const accept = vi.fn()
		const current = { rid: 1, version: '1.2.3' }
		const duplicate = { rid: 2, version: '1.2.3' }
		expect(await selectUpdateResource(duplicate, current, false, close, accept)).toBe('known')
		expect(close.mock.calls).toEqual([[2]])
		expect(accept).not.toHaveBeenCalled()
		expect(current).toEqual({ rid: 1, version: '1.2.3' })
	})

	it('retains an active download and releases a newer unused check resource', async () => {
		const close = vi.fn().mockResolvedValue(undefined)
		const accept = vi.fn()
		const current = { rid: 3, version: '1.2.3' }
		const newer = { rid: 4, version: '1.2.4' }
		expect(await selectUpdateResource(newer, current, true, close, accept)).toBe('deferred')
		expect(close.mock.calls).toEqual([[4]])
		expect(accept).not.toHaveBeenCalled()
	})

	it('publishes the replacement before closing the retired resource', async () => {
		const current = { rid: 5, version: '1.2.3' }
		const next = { rid: 6, version: '1.2.4' }
		let displayed = current
		const order = []
		const close = vi.fn(async (rid) => {
			order.push(`close:${rid}`)
			expect(displayed).toBe(next)
		})
		const accept = (update) => {
			displayed = update
			order.push(`accept:${update.rid}`)
		}
		expect(await selectUpdateResource(next, current, false, close, accept)).toBe('available')
		expect(order).toEqual(['accept:6', 'close:5'])
		expect(close.mock.calls).toEqual([[5]])
	})

	it('does not close the current resource when a check reuses its identifier', async () => {
		const close = vi.fn()
		const accept = vi.fn()
		const update = { rid: 7, version: '1.2.3' }
		expect(await selectUpdateResource(update, update, false, close, accept)).toBe('known')
		expect(close).not.toHaveBeenCalled()
		expect(accept).not.toHaveBeenCalled()
	})

	it('keeps the available resource when no newer update is returned', async () => {
		const close = vi.fn()
		const accept = vi.fn()
		expect(
			await selectUpdateResource(null, { rid: 8, version: '1.2.3' }, false, close, accept),
		).toBe('none')
		expect(close).not.toHaveBeenCalled()
		expect(accept).not.toHaveBeenCalled()
	})
})

describe('desktop update retries and optional size reads', () => {
	it('handles a transient failure and checks again on the scheduled retry', async () => {
		vi.useFakeTimers()
		const error = new Error('Relay temporarily unavailable')
		const check = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined)
		const onError = vi.fn()
		const scheduleRetry = vi.fn(() => {
			if (check.mock.calls.length < 2) setTimeout(() => void run(), 5 * 60 * 1000)
		})
		const run = () => runUpdateCheckWithRetry(check, onError, scheduleRetry)
		await expect(run()).resolves.toBeUndefined()
		expect(onError.mock.calls).toEqual([[error]])
		expect(scheduleRetry).toHaveBeenCalledOnce()
		await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
		expect(check).toHaveBeenCalledTimes(2)
		expect(scheduleRetry).toHaveBeenCalledTimes(2)
	})

	it('handles a failed size request without rejecting or changing displayed progress', async () => {
		const error = new Error('HEAD request denied')
		const onError = vi.fn()
		const onSize = vi.fn()
		await expect(
			readUpdateSize(1, vi.fn().mockRejectedValue(error), () => 1, onSize, onError),
		).resolves.toBeUndefined()
		expect(onError.mock.calls).toEqual([[error]])
		expect(onSize).not.toHaveBeenCalled()
	})

	it('ignores a delayed size response after its update resource was replaced', async () => {
		let completeSize
		const getSize = vi.fn(() => new Promise((resolve) => (completeSize = resolve)))
		let displayedRid = 1
		const onSize = vi.fn()
		const onError = vi.fn()
		const read = readUpdateSize(1, getSize, () => displayedRid, onSize, onError)
		displayedRid = 2
		completeSize(1024)
		await read
		expect(onSize).not.toHaveBeenCalled()
		expect(onError).not.toHaveBeenCalled()
	})

	it('applies a size response only to its currently displayed update', async () => {
		const onSize = vi.fn()
		await readUpdateSize(2, vi.fn().mockResolvedValue(2048), () => 2, onSize, vi.fn())
		expect(onSize.mock.calls).toEqual([[2048]])
	})
})
