import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';

export default defineConfig({
	lang: 'en-US',
	title: 'Segment',
	description:
		'A framework-agnostic, type-safe state engine built around structural paths, targeted subscriptions, and atomic commits.',
	base: '/segment/',
	cleanUrls: true,
	sitemap: {
		hostname: 'https://webeferen.github.io/segment/',
	},
	vite: {
		publicDir: fileURLToPath(new URL('../../assets', import.meta.url)),
	},
	head: [
		['link', { rel: 'icon', href: '/segment/logo.svg', type: 'image/svg+xml' }],
		['meta', { property: 'og:type', content: 'website' }],
		['meta', { property: 'og:site_name', content: 'Segment' }],
		['meta', { property: 'og:title', content: 'Segment — State you can address' }],
		[
			'meta',
			{
				property: 'og:description',
				content:
					'Path-addressed state with targeted subscriptions, atomic commits, and O(observed) memory.',
			},
		],
		['meta', { property: 'og:image', content: 'https://webeferen.github.io/segment/og.png' }],
		['meta', { property: 'og:url', content: 'https://webeferen.github.io/segment/' }],
		['meta', { name: 'twitter:card', content: 'summary_large_image' }],
		['meta', { name: 'theme-color', content: '#e90826' }],
	],
	themeConfig: {
		logo: {
			light: '/logo.svg',
			dark: '/logo-dark.svg',
			alt: 'Segment',
		},
		nav: [
			{ text: 'Guide', link: '/guide/getting-started' },
			{ text: 'Advanced', link: '/advanced' },
			{ text: 'Internals', link: '/core' },
			{
				text: '0.0.1',
				items: [
					{ text: 'Releases', link: 'https://github.com/WebEferen/segment/releases' },
					{ text: 'npm', link: 'https://www.npmjs.com/package/segment-state' },
				],
			},
		],
		sidebar: [
			{
				text: 'Guide',
				items: [
					{ text: 'Getting started', link: '/guide/getting-started' },
					{ text: 'State model', link: '/guide/state-model' },
					{ text: 'Advanced', link: '/advanced' },
				],
			},
			{
				text: 'Reference',
				items: [{ text: 'Core internals', link: '/core' }],
			},
			{
				text: 'Maintainers',
				items: [{ text: 'Releasing', link: '/releasing' }],
			},
		],
		search: { provider: 'local' },
		socialLinks: [{ icon: 'github', link: 'https://github.com/WebEferen/segment' }],
		editLink: {
			pattern: 'https://github.com/WebEferen/segment/edit/main/docs/:path',
			text: 'Edit this page on GitHub',
		},
		outline: [2, 3],
		docFooter: {
			prev: 'Previous page',
			next: 'Next page',
		},
		footer: {
			message: 'Released under the MIT License.',
			copyright: 'Copyright © Michal Makowski',
		},
	},
});
