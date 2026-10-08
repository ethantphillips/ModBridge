import type { AbstractModrinthClient } from '@modrinth/api-client'

export function renderForClient(
	html: string,
	client: AbstractModrinthClient | null | undefined,
	externalLinkLabel: string,
): string {
	if (client?.allowExternalEmbeds !== false) return html

	const template = document.createElement('template')
	template.innerHTML = html
	const replaceWithLink = (element: Element, source: string, label = externalLinkLabel) => {
		try {
			const url = new URL(source)
			if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
				element.remove()
				return
			}
			const link = document.createElement('a')
			link.href = url.href
			link.target = '_blank'
			link.rel = 'noopener noreferrer'
			link.className = 'text-link'
			link.textContent = label
			const parentLink = element.closest('a')
			if (parentLink) {
				parentLink.after(link)
				element.remove()
				if (!parentLink.textContent && !parentLink.children.length) parentLink.remove()
			} else {
				element.replaceWith(link)
			}
		} catch {
			element.remove()
		}
	}
	const resolveSrcset = (value: string) => {
		const candidates: string[] = []
		let remaining = value
		while (remaining) {
			remaining = remaining.replace(/^[\t\n\f\r ,]+/, '')
			if (!remaining) break
			const urlEnd = remaining.search(/[\t\n\f\r ]/)
			let source = urlEnd < 0 ? remaining : remaining.slice(0, urlEnd)
			remaining = urlEnd < 0 ? '' : remaining.slice(urlEnd)
			let descriptor = ''
			if (source.endsWith(',')) {
				source = source.replace(/,+$/, '')
			} else {
				const descriptorEnd = remaining.indexOf(',')
				descriptor = (descriptorEnd < 0 ? remaining : remaining.slice(0, descriptorEnd)).trim()
				remaining = descriptorEnd < 0 ? '' : remaining.slice(descriptorEnd + 1)
			}
			if (descriptor && !/^(?:[1-9]\d*w|(?:\d+(?:\.\d*)?|\.\d+)x)$/.test(descriptor)) continue
			try {
				const resolved = client.resolveMediaUrl(source)
				candidates.push(`${resolved}${descriptor ? ` ${descriptor}` : ''}`)
			} catch {
				continue
			}
		}
		return candidates.join(', ')
	}
	for (const source of template.content.querySelectorAll('picture > source[srcset]')) {
		const srcset = resolveSrcset(source.getAttribute('srcset') ?? '')
		if (srcset) source.setAttribute('srcset', srcset)
		else source.remove()
	}
	for (const image of template.content.querySelectorAll('img')) {
		const source = image.getAttribute('src') ?? ''
		let supported = Boolean(
			image.parentElement?.matches('picture') &&
			image.parentElement.querySelector('source[srcset]'),
		)
		if (image.hasAttribute('srcset')) {
			const srcset = resolveSrcset(image.getAttribute('srcset') ?? '')
			if (srcset) {
				image.setAttribute('srcset', srcset)
				supported = true
			} else image.removeAttribute('srcset')
		}
		if (source) {
			try {
				image.setAttribute('src', client.resolveMediaUrl(source))
				supported = true
			} catch {
				image.removeAttribute('src')
			}
		}
		if (!supported) {
			const alt = image.getAttribute('alt')?.trim()
			replaceWithLink(image, source, alt ? `${externalLinkLabel}: ${alt}` : externalLinkLabel)
		}
	}
	for (const iframe of template.content.querySelectorAll('iframe')) {
		try {
			const source = new URL(iframe.getAttribute('src') ?? '')
			if (!['http:', 'https:'].includes(source.protocol)) {
				iframe.remove()
				continue
			}
			const videoId = source.pathname.match(/^\/embed\/([a-zA-Z0-9_-]{11})$/)?.[1]
			if (videoId && /^(www\.)?youtube(-nocookie)?\.com$/.test(source.hostname)) {
				const start = source.searchParams.get('start')
				source.href = `https://www.youtube.com/watch?v=${videoId}`
				if (start) source.searchParams.set('t', `${start}s`)
			}
			replaceWithLink(iframe, source.href)
		} catch {
			iframe.remove()
		}
	}
	return template.innerHTML
}
