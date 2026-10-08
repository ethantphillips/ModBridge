<template>
	<div class="markdown-body" v-html="descriptionHtml" />
</template>
<script setup lang="ts">
import { renderHighlightedString } from '@modrinth/utils'
import { computed } from 'vue'

import { useVIntl } from '#ui/composables/i18n'
import { injectModrinthClient } from '#ui/providers/api-client'
import { commonMessages } from '#ui/utils/common-messages'
import { renderForClient } from '#ui/utils/render-for-client'

const client = injectModrinthClient(null)
const { formatMessage } = useVIntl()
const props = withDefaults(
	defineProps<{
		description: string
	}>(),
	{},
)
const descriptionHtml = computed(() =>
	renderForClient(
		renderHighlightedString(props.description ?? ''),
		client,
		formatMessage(commonMessages.openInBrowserButton),
	),
)
</script>
