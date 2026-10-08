<template>
	<div
		v-if="accounts.length === 0"
		class="flex flex-col gap-3 bg-button-bg border border-solid border-surface-5 rounded-xl p-3 mt-2"
	>
		<div class="flex flex-col gap-1">
			<span class="font-semibold text-contrast text-sm">{{
				formatMessage(messages.offlineAccount)
			}}</span>
			<span class="text-secondary text-xs">{{ formatMessage(messages.offlineHelp) }}</span>
		</div>
		<div class="flex flex-col gap-2">
			<Input
				v-model="offlineUsername"
				:placeholder="formatMessage(messages.usernamePlaceholder)"
				:icon="UserIcon"
				:maxlength="16"
				:disabled="isCreatingOffline"
				autocomplete="off"
				:spellcheck="false"
				size="small"
			/>
			<Input
				v-model="offlinePin"
				type="password"
				:placeholder="formatMessage(messages.pinPlaceholder)"
				:icon="LockIcon"
				:disabled="isCreatingOffline"
				autocomplete="off"
				size="small"
			/>
			<span v-if="offlineError" class="text-xs text-red">{{ offlineError }}</span>
			<Button
				type="colored"
				color="brand"
				class="w-full"
				:disabled="
					!offlineUsername.trim() ||
					!offlinePin.trim() ||
					isCreatingOffline ||
					isUpdatingAccount ||
					loginDisabled
				"
				@click="handleCreateOfflineUser()"
			>
				<PlusIcon v-if="!isCreatingOffline" />
				<SpinnerIcon v-else class="animate-spin" />
				{{ formatMessage(messages.createOfflineProfile) }}
			</Button>
		</div>
	</div>
	<Accordion
		v-else
		ref="accountsAccordion"
		class="w-full mt-2 bg-button-bg border border-solid border-surface-5 rounded-xl overflow-clip"
		button-class="button-base w-full bg-transparent px-3 py-2 border-0 cursor-pointer"
		:open-by-default="false"
	>
		<template #title>
			<div class="flex gap-2 w-full min-w-0 items-center">
				<Avatar size="36px" :src="selectedAccount ? avatarUrl : defaultAvatarUrl" />
				<div class="flex flex-col items-start w-full min-w-0">
					<div class="flex items-center gap-2 w-full min-w-0">
						<span class="truncate text-left font-semibold text-contrast">{{
							selectedAccount ? selectedAccount.profile.name : formatMessage(messages.selectAccount)
						}}</span>
						<span
							v-if="selectedAccount"
							class="text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 bg-brand/20 text-brand"
						>
							{{
								formatMessage(
									isAccountOffline(selectedAccount)
										? messages.offlineLabel
										: messages.microsoftLabel,
								)
							}}
						</span>
					</div>
					<span class="text-secondary text-xs">{{ formatMessage(messages.minecraftAccount) }}</span>
				</div>
			</div>
		</template>
		<div class="bg-button-bg pt-1 pb-2 border-0 border-t border-solid border-surface-5">
			<template v-if="accounts.length > 0">
				<div v-for="account in accounts" :key="account.profile.id" class="flex gap-1 items-center">
					<button
						class="flex items-center flex-shrink flex-grow overflow-clip gap-2 p-2 border-0 bg-transparent cursor-pointer button-base min-w-0"
						:disabled="isCreatingOffline || isUpdatingAccount"
						@click="setAccount(account)"
					>
						<RadioButtonCheckedIcon
							v-if="selectedAccount && selectedAccount.profile.id === account.profile.id"
							class="w-5 h-5 text-brand shrink-0"
						/>
						<RadioButtonIcon v-else class="w-5 h-5 text-secondary shrink-0" />
						<Avatar :src="getAccountAvatarUrl(account)" size="24px" />
						<p
							class="m-0 truncate min-w-0"
							:class="
								selectedAccount && selectedAccount.profile.id === account.profile.id
									? 'text-contrast font-semibold'
									: 'text-primary'
							"
						>
							{{ account.profile.name }}
						</p>
						<span
							class="text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ml-auto mr-1 bg-brand/20 text-brand"
						>
							{{
								formatMessage(
									isAccountOffline(account) ? messages.offlineLabel : messages.microsoftLabel,
								)
							}}
						</span>
					</button>
					<IconButton
						v-tooltip="formatMessage(messages.removeAccount)"
						type="quiet"
						color="red"
						:label="formatMessage(messages.removeAccount)"
						:disabled="isCreatingOffline || isUpdatingAccount"
						class="mr-2 !bg-button-bg !text-primary ![box-shadow:var(--shadow-button)] hover:!bg-red focus-visible:!bg-red hover:!text-[var(--color-accent-contrast)] focus-visible:!text-[var(--color-accent-contrast)]"
						@click="logout(account.profile.id)"
					>
						<TrashIcon />
					</IconButton>
				</div>
			</template>
			<div v-if="!showAddOfflineForm" class="flex flex-col gap-2 px-2 pt-2">
				<Button
					class="w-full !bg-button-bg !text-primary ![box-shadow:var(--shadow-button)]"
					@click="showAddOfflineForm = true"
				>
					<PlusIcon />
					{{ formatMessage(messages.addOfflineAccount) }}
				</Button>
			</div>
			<div
				v-else
				class="flex flex-col gap-2 p-3 mx-2 mt-2 bg-surface-2 border border-solid border-surface-5 rounded-lg"
			>
				<div class="flex items-center justify-between">
					<span class="text-xs font-semibold text-contrast">{{
						formatMessage(messages.newOfflineAccount)
					}}</span>
					<button
						class="text-xs text-secondary hover:text-contrast bg-transparent border-0 cursor-pointer p-0"
						:disabled="isCreatingOffline"
						@click="resetOfflineForm()"
					>
						{{ formatMessage(messages.cancel) }}
					</button>
				</div>
				<Input
					v-model="offlineUsername"
					:placeholder="formatMessage(messages.usernamePlaceholder)"
					:icon="UserIcon"
					:maxlength="16"
					:disabled="isCreatingOffline"
					autocomplete="off"
					:spellcheck="false"
					size="small"
				/>
				<Input
					v-model="offlinePin"
					type="password"
					:placeholder="formatMessage(messages.pinPlaceholder)"
					:icon="LockIcon"
					:disabled="isCreatingOffline"
					autocomplete="off"
					size="small"
				/>
				<span v-if="offlineError" class="text-xs text-red">{{ offlineError }}</span>
				<Button
					type="colored"
					color="brand"
					class="w-full"
					:disabled="
						!offlineUsername.trim() ||
						!offlinePin.trim() ||
						isCreatingOffline ||
						isUpdatingAccount ||
						loginDisabled
					"
					@click="handleCreateOfflineUser()"
				>
					<PlusIcon v-if="!isCreatingOffline" />
					<SpinnerIcon v-else class="animate-spin" />
					{{ formatMessage(messages.createOfflineProfile) }}
				</Button>
			</div>
		</div>
	</Accordion>
</template>

<script setup lang="ts">
import {
	LockIcon,
	PlusIcon,
	RadioButtonCheckedIcon,
	RadioButtonIcon,
	SpinnerIcon,
	TrashIcon,
	UserIcon,
} from '@modrinth/assets'
import {
	Accordion,
	Avatar,
	Button,
	defineMessages,
	IconButton,
	injectNotificationManager,
	Input,
	useVIntl,
} from '@modrinth/ui'
import type { Ref } from 'vue'
import { computed, onUnmounted, ref } from 'vue'

import { config } from '@/config'
import { useAppEvent } from '@/composables/use-app-event'
import { trackEvent } from '@/helpers/analytics'
import {
	add_offline_user,
	get_default_user,
	remove_user,
	set_default_user,
	users,
} from '@/helpers/auth'
import { getPlayerHeadUrl } from '@/helpers/rendering/player-head'
import type { Skin } from '@/helpers/skins'
import { get_available_skins } from '@/helpers/skins'

const { formatMessage } = useVIntl()
const { handleError } = injectNotificationManager()

const emit = defineEmits<{
	change: []
	open: []
}>()

type MinecraftCredential = {
	profile: {
		id: string
		name: string
	}
	access_token?: string
	refresh_token?: string
}

const accounts: Ref<MinecraftCredential[]> = ref([])
const loginDisabled = ref(false)
const defaultUser = ref<string | undefined>()
const equippedSkin = ref<Skin | null>(null)
const equippedHeadUrl = ref<string>()
let headRequest = 0

const offlineUsername = ref('')
const offlinePin = ref('')
const isCreatingOffline = ref(false)
const isUpdatingAccount = ref(false)
const offlineError = ref<string | null>(null)
const showAddOfflineForm = ref(false)
const accountsAccordion = ref<InstanceType<typeof Accordion> | null>(null)

function isAccountOffline(account?: MinecraftCredential | null): boolean {
	if (!account) return false
	return (
		account.access_token === '0' || account.access_token === 'offline' || !account.refresh_token
	)
}

async function handleCreateOfflineUser() {
	if (isCreatingOffline.value || isUpdatingAccount.value || loginDisabled.value) return
	if (!offlineUsername.value.trim() || !offlinePin.value.trim()) {
		offlineError.value = formatMessage(messages.identityRequired)
		return
	}
	if (!/^[A-Za-z0-9_]{1,16}$/.test(offlineUsername.value.trim())) {
		offlineError.value = formatMessage(messages.invalidUsername)
		return
	}
	isCreatingOffline.value = true
	offlineError.value = null
	try {
		await add_offline_user(offlineUsername.value.trim(), offlinePin.value.trim())
		resetOfflineForm()
		await refreshValues()
		emit('change')
	} catch (err) {
		offlineError.value = err instanceof Error ? err.message : String(err)
	} finally {
		isCreatingOffline.value = false
	}
}

function resetOfflineForm() {
	offlineUsername.value = ''
	offlinePin.value = ''
	offlineError.value = null
	showAddOfflineForm.value = false
}

async function updateHeadUrl(skin: Skin | null) {
	const request = ++headRequest
	if (equippedHeadUrl.value) URL.revokeObjectURL(equippedHeadUrl.value)
	equippedHeadUrl.value = undefined
	if (!skin) return
	const url = await getPlayerHeadUrl(skin)
	if (request !== headRequest) URL.revokeObjectURL(url)
	else equippedHeadUrl.value = url
}

onUnmounted(() => {
	offlinePin.value = ''
	headRequest++
	if (equippedHeadUrl.value) URL.revokeObjectURL(equippedHeadUrl.value)
})

async function refreshValues() {
	defaultUser.value = await get_default_user().catch(handleError)
	const userList = await users().catch(handleError)
	accounts.value = Array.isArray(userList) ? [...userList] : []
	accounts.value.sort((a, b) => (a.profile?.name ?? '').localeCompare(b.profile?.name ?? ''))

	try {
		const skins = await get_available_skins()
		equippedSkin.value = skins.find((skin) => skin.is_equipped) ?? null

		await updateHeadUrl(equippedSkin.value)
	} catch {
		equippedSkin.value = null
		void updateHeadUrl(null)
	}
}

async function setEquippedSkin(skin: Skin) {
	equippedSkin.value = skin

	try {
		await updateHeadUrl(skin)
	} catch (error) {
		console.warn('Failed to get head render for equipped skin:', error)
	}
}

function setLoginDisabled(value: boolean) {
	loginDisabled.value = value
}

defineExpose({
	refreshValues,
	setEquippedSkin,
	setLoginDisabled,
	login,
	loginDisabled,
})

await refreshValues()

const selectedAccount = computed(() =>
	accounts.value.find((account) => account.profile.id === defaultUser.value),
)

const defaultAvatarUrl = `${config.relayBaseUrl}/launcher-files/assets/steve_head.png`

const avatarUrl = computed(() => {
	if (equippedSkin.value?.texture_key) {
		const cachedUrl = equippedHeadUrl.value
		if (cachedUrl) {
			return cachedUrl
		}
	}
	return defaultAvatarUrl
})

function getAccountAvatarUrl(account: MinecraftCredential) {
	if (
		account.profile.id === selectedAccount.value?.profile?.id &&
		equippedSkin.value?.texture_key
	) {
		const cachedUrl = equippedHeadUrl.value
		if (cachedUrl) {
			return cachedUrl
		}
	}
	return defaultAvatarUrl
}

async function setAccount(account: MinecraftCredential) {
	if (isCreatingOffline.value || isUpdatingAccount.value) return
	isUpdatingAccount.value = true
	try {
		await set_default_user(account.profile.id)
		await refreshValues()
		emit('change')
	} catch (err) {
		handleError(err)
	} finally {
		isUpdatingAccount.value = false
	}
}

async function login() {
	showAddOfflineForm.value = true
	accountsAccordion.value?.open()
	emit('open')
}

async function logout(id: string) {
	if (isCreatingOffline.value || isUpdatingAccount.value) return
	isUpdatingAccount.value = true
	try {
		await remove_user(id)
		await refreshValues()
		emit('change')
		trackEvent('AccountLogOut')
	} catch (err) {
		handleError(err)
	} finally {
		isUpdatingAccount.value = false
	}
}

useAppEvent('process', async (e) => {
	if (e.event === 'launched') {
		await refreshValues()
	}
})

const messages = defineMessages({
	offlineLabel: {
		id: 'minecraft-account.offline-label',
		defaultMessage: 'Offline',
	},
	microsoftLabel: {
		id: 'minecraft-account.microsoft-label',
		defaultMessage: 'Microsoft',
	},
	cancel: {
		id: 'minecraft-account.cancel',
		defaultMessage: 'Cancel',
	},
	identityRequired: {
		id: 'minecraft-account.identity-required',
		defaultMessage: 'Username and Identity PIN are required.',
	},
	invalidUsername: {
		id: 'minecraft-account.invalid-username',
		defaultMessage: 'Use 1–16 letters, numbers, or underscores for your player name.',
	},
	notSignedIn: {
		id: 'minecraft-account.not-signed-in',
		defaultMessage: 'Not signed in',
	},
	addAccount: {
		id: 'minecraft-account.add-account',
		defaultMessage: 'Add account',
	},
	addOfflineAccount: {
		id: 'minecraft-account.add-offline-account',
		defaultMessage: 'Add Offline Account',
	},
	newOfflineAccount: {
		id: 'minecraft-account.new-offline-account',
		defaultMessage: 'New Offline Account',
	},
	removeAccount: {
		id: 'minecraft-account.remove-account',
		defaultMessage: 'Remove account',
	},
	selectAccount: {
		id: 'minecraft-account.select-account',
		defaultMessage: 'Select account',
	},
	minecraftAccount: {
		id: 'minecraft-account.label',
		defaultMessage: 'Minecraft account',
	},
	signInToMinecraft: {
		id: 'minecraft-account.sign-in',
		defaultMessage: 'Sign in to Minecraft',
	},
	offlineAccount: {
		id: 'minecraft-account.offline-account',
		defaultMessage: 'Offline Account',
	},
	createOfflineProfile: {
		id: 'minecraft-account.create-offline',
		defaultMessage: 'Create Offline Profile',
	},
	offlineHelp: {
		id: 'minecraft-account.offline-help',
		defaultMessage:
			'Deterministic offline identity. The same Username + PIN always reproduces the same UUID.',
	},
	usernamePlaceholder: {
		id: 'minecraft-account.username-placeholder',
		defaultMessage: 'Player name (e.g. Steve)',
	},
	pinPlaceholder: {
		id: 'minecraft-account.pin-placeholder',
		defaultMessage: 'Identity PIN (e.g. 1234)',
	},
})
</script>
