// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'

import { createRelayUrlResolver } from '../../apps/app-frontend/src/helpers/relay.ts'
import { createHostingPurchaseIntentContext } from '../../packages/ui/src/providers/hosting-purchase-intent.ts'
import { renderForClient } from '../../packages/ui/src/utils/render-for-client.ts'

const relay = 'https://relay.modbridge.internal'
const resolveUrl = createRelayUrlResolver(relay)
const client = {
	allowExternalEmbeds: false,
	resolveMediaUrl: (value) => {
		const resolved = resolveUrl(value)
		if (!resolved.startsWith(relay)) return resolved
		const url = new URL(resolved)
		url.searchParams.set('relay_token', 'media-auth')
		return url.href
	},
}
const render = (html) => {
	const template = document.createElement('template')
	template.innerHTML = renderForClient(html, client, 'Open in browser')
	return template.content
}

describe('desktop Markdown media', () => {
	it('preserves website HTML and never requires browser DOM for default policy', () => {
		const html =
			'<iframe src="https://www.youtube.com/embed/p1Dg-fud0TQ"></iframe><img src="https://external.test/a.png">'
		const createElement = vi.spyOn(document, 'createElement')
		expect(renderForClient(html, { allowExternalEmbeds: true }, 'Open')).toBe(html)
		expect(renderForClient(html, null, 'Open')).toBe(html)
		expect(createElement).not.toHaveBeenCalled()
		createElement.mockRestore()
	})

	it('converts YouTube frames to browser watch links preserving start time', () => {
		const dom = render(
			'<iframe src="https://www.youtube-nocookie.com/embed/p1Dg-fud0TQ?start=12"></iframe>',
		)
		expect(dom.querySelector('iframe')).toBeNull()
		const link = dom.querySelector('a')
		expect(link.href).toBe('https://www.youtube.com/watch?v=p1Dg-fud0TQ&t=12s')
		expect(link.target).toBe('_blank')
		expect(link.rel).toBe('noopener noreferrer')
	})

	it.each([
		'javascript:alert(1)',
		'data:text/html,blocked',
		'/relative-frame',
		'https://user:secret@external.test',
	])('removes invalid frame destination %s', (source) => {
		const dom = render(`<iframe src="${source}"></iframe>`)
		expect(dom.querySelector('iframe, a')).toBeNull()
	})

	it('routes a known project image through Relay with browser media authentication', () => {
		const image = render(
			'<img src="https://cdn.modrinth.com/screenshot.png?size=small" alt="Screenshot">',
		).querySelector('img')
		expect(image.src).toBe(`${relay}/cdn/screenshot.png?size=small&relay_token=media-auth`)
		expect(image.alt).toBe('Screenshot')
	})

	it.each([
		'data:image/png;base64,AA==',
		'blob:https://tauri.localhost/preview',
		'asset://localhost/image.png',
		'/assets/image.png',
	])('preserves local media %s', (source) => {
		expect(render(`<img src="${source}">`).querySelector('img').getAttribute('src')).toBe(source)
	})

	it('converts unsupported images into descriptive links without nesting anchors', () => {
		const dom = render(
			'<a href="https://example.test/project"><img src="https://external.test/image.png" alt="Preview"></a>',
		)
		expect(dom.querySelector('img, a a')).toBeNull()
		const links = dom.querySelectorAll('a')
		expect(links).toHaveLength(1)
		expect(links[0].href).toBe('https://external.test/image.png')
		expect(links[0].textContent).toBe('Open in browser: Preview')
	})

	it('normalizes responsive sources and drops unsupported candidates', () => {
		const dom = render(
			'<picture><source srcset="https://external.test/a.png 1x, https://cdn.modrinth.com/high.png 2x"><img src="https://cdn.modrinth.com/low.png" srcset="data:image/png;base64,AA== 1x, https://cdn.modrinth.com/high.png 2x, https://external.test/a.png 3x"></picture>',
		)
		expect(dom.querySelector('source').getAttribute('srcset')).toBe(
			`${relay}/cdn/high.png?relay_token=media-auth 2x`,
		)
		expect(dom.querySelector('img').getAttribute('srcset')).toBe(
			`data:image/png;base64,AA== 1x, ${relay}/cdn/high.png?relay_token=media-auth 2x`,
		)
	})

	it('retains an approved srcset when the fallback image is unsupported', () => {
		const image = render(
			'<img src="https://external.test/a.png" srcset="https://cdn.modrinth.com/a.png 640w, https://cdn.modrinth.com/b.png 1280w">',
		).querySelector('img')
		expect(image.hasAttribute('src')).toBe(false)
		expect(image.getAttribute('srcset')).toBe(
			`${relay}/cdn/a.png?relay_token=media-auth 640w, ${relay}/cdn/b.png?relay_token=media-auth 1280w`,
		)
	})

	it('retains the picture image when its source is approved and fallback is unsupported', () => {
		const dom = render(
			'<picture><source srcset="https://cdn.modrinth.com/a.png 1x"><img src="https://external.test/a.png" alt="Preview"></picture>',
		)
		expect(dom.querySelector('picture img').hasAttribute('src')).toBe(false)
		expect(dom.querySelector('source').getAttribute('srcset')).toBe(
			`${relay}/cdn/a.png?relay_token=media-auth 1x`,
		)
	})
})

describe('desktop checkout browser handoff', () => {
	const scopes = []
	afterEach(() => {
		for (const scope of scopes.splice(0)) scope.stop()
		window.sessionStorage.clear()
	})

	function purchaseFlow(overrides = {}) {
		const options = {
			authRequestSignIn: vi.fn(),
			signInRedirectPath: '/hosting/manage',
			intentSource: 'hosting-manage',
			loggedIn: ref(false),
			availableProducts: ref([{ id: 'plan', metadata: { type: 'pyro', ram: 6144 } }]),
			canOpenCheckout: ref(false),
			guestPlanModal: ref({ show: vi.fn() }),
			checkoutModal: ref({ show: vi.fn() }),
			onCheckoutPending: vi.fn(),
			...overrides,
		}
		const scope = effectScope()
		scopes.push(scope)
		const flow = scope.run(() => createHostingPurchaseIntentContext(options))
		return { options, flow }
	}

	it('opens the browser directly without waiting for embedded checkout or app login', () => {
		const openExternalCheckout = vi.fn()
		const { flow, options } = purchaseFlow({ openExternalCheckout })
		flow.openPurchaseModal()
		expect(openExternalCheckout).toHaveBeenCalledOnce()
		expect(options.guestPlanModal.value.show).not.toHaveBeenCalled()
		expect(options.checkoutModal.value.show).not.toHaveBeenCalled()
		expect(options.authRequestSignIn).not.toHaveBeenCalled()
		expect(options.onCheckoutPending).not.toHaveBeenCalled()
	})

	it('hands guest plan continuation to the browser without initiating embedded payment', () => {
		const openExternalCheckout = vi.fn()
		const { flow, options } = purchaseFlow({ openExternalCheckout })
		flow.handleGuestPlanContinue({ interval: 'yearly', planId: 'plan' })
		expect(openExternalCheckout).toHaveBeenCalledOnce()
		expect(options.checkoutModal.value.show).not.toHaveBeenCalled()
		expect(options.authRequestSignIn).not.toHaveBeenCalled()
		expect(window.sessionStorage.length).toBe(0)
	})

	it('preserves website guest plan selection and authenticated embedded checkout', () => {
		const { flow, options } = purchaseFlow({ loggedIn: ref(true), canOpenCheckout: ref(true) })
		flow.openPurchaseModal()
		expect(options.guestPlanModal.value.show).toHaveBeenCalledWith('quarterly', undefined)
		flow.handleGuestPlanContinue({ interval: 'yearly', planId: 'plan' })
		expect(options.checkoutModal.value.show).toHaveBeenCalledWith(
			'yearly',
			options.availableProducts.value[0],
		)
	})

	it('preserves website sign-in continuation when no browser handoff is configured', () => {
		const { flow, options } = purchaseFlow()
		flow.handleGuestPlanContinue({ interval: 'monthly', planId: 'plan' })
		expect(options.authRequestSignIn).toHaveBeenCalledWith('/hosting/manage')
		expect(
			JSON.parse(window.sessionStorage.getItem('modrinth:servers-purchase-intent')),
		).toMatchObject({
			interval: 'monthly',
			planId: 'plan',
			source: 'hosting-manage',
		})
	})
})
