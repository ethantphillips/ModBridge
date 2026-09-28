<template>
	<NewModal ref="modal" :header="formatMessage(messages.header)" max-width="544px" no-padding>
		<div class="grid grid-cols-[1fr_auto] gap-2.5 h-[154px] px-7 pt-4 pb-1 pr-9">
			<div class="flex flex-col gap-2.5 items-start justify-center h-min mt-5">
				<div class="font-semibold text-xl text-contrast">
					{{ formatMessage(messages.descriptionHeader) }}
				</div>
				<div class="text-secondary leading-6">
					{{ formatMessage(messages.description) }}
				</div>
			</div>
			<div class="relative h-full w-[96px] overflow-hidden mx-3">
				<div class="absolute top-0 left-0 z-0 w-full flex grow-0 flex-col items-end p-0">
					<img :src="steveImage" alt="" class="self-stretch" />
				</div>
				<div
					class="absolute left-0 bottom-0 z-10 order-1 h-6 w-[120px] shrink-0 grow-0 bg-[linear-gradient(180deg,rgba(39,41,46,0)_0%,#27292E_80%,#27292E_100%)]"
				></div>
			</div>
		</div>

		<div class="flex flex-col gap-6 px-6 pb-6">
			<div class="grid grid-cols-2 gap-2">
				<Button @click="modal?.hide()">
					{{ formatMessage(messages.close) }}
				</Button>
				<Button type="colored" color="brand" @click="createAccount">
					<PlusIcon />
					{{ formatMessage(messages.addAccount) }}
				</Button>
			</div>
		</div>
	</NewModal>
</template>

<script setup lang="ts">
import { PlusIcon } from '@modrinth/assets'
import { Button, defineMessages, NewModal, useVIntl } from '@modrinth/ui'
import { inject, type Ref, ref } from 'vue'

import steveImage from '@/assets/steve-look-up-left.webp'
import type AccountsCard from '@/components/ui/AccountsCard.vue'

const { formatMessage } = useVIntl()
const accountsCard = inject('accountsCard') as Ref<InstanceType<typeof AccountsCard> | null>

const messages = defineMessages({
	header: {
		id: 'minecraft-required.header',
		defaultMessage: 'Account required',
	},
	descriptionHeader: {
		id: 'minecraft-required.description-header',
		defaultMessage: 'Select or create an account',
	},
	description: {
		id: 'minecraft-required.description',
		defaultMessage:
			'An offline profile is required before you can launch and play.',
	},
	close: {
		id: 'minecraft-required.close',
		defaultMessage: 'Close',
	},
	addAccount: {
		id: 'minecraft-required.add-account',
		defaultMessage: 'Add Profile',
	},
})

const modal = ref<InstanceType<typeof NewModal>>()

function show() {
	modal.value?.show()
}

async function createAccount() {
	if (accountsCard.value) {
		await accountsCard.value.login()
	}
	modal.value?.hide()
}

defineExpose({
	show,
})
</script>
