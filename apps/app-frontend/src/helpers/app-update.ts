type UpdateResource = {
	rid: number
	version: string
}

export async function selectUpdateResource<T extends UpdateResource>(
	update: T | null,
	current: T | null,
	downloading: boolean,
	closeResource: (rid: number) => Promise<void>,
	onAvailable: (update: T) => void,
): Promise<'none' | 'known' | 'deferred' | 'available'> {
	if (!update) return 'none'
	if (current?.version === update.version || (current && downloading)) {
		if (update.rid !== current.rid) await closeResource(update.rid)
		return current.version === update.version ? 'known' : 'deferred'
	}
	onAvailable(update)
	if (current && current.rid !== update.rid) await closeResource(current.rid)
	return 'available'
}

export async function runUpdateCheckWithRetry(
	check: () => Promise<void>,
	onError: (error: unknown) => void,
	scheduleRetry: () => void,
): Promise<void> {
	try {
		await check()
	} catch (error) {
		onError(error)
	} finally {
		scheduleRetry()
	}
}

export async function readUpdateSize(
	rid: number,
	getSize: (rid: number) => Promise<number | null>,
	currentRid: () => number | undefined,
	onSize: (size: number | null) => void,
	onError: (error: unknown) => void,
): Promise<void> {
	try {
		const size = await getSize(rid)
		if (currentRid() === rid) onSize(size)
	} catch (error) {
		onError(error)
	}
}
