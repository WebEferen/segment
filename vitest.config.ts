import { resolve } from 'node:path';
import { octane } from 'octane/compiler/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: 'segment-core',
					include: ['tests/*.test.ts'],
					environment: 'node',
					globals: false,
				},
			},
			{
				plugins: [octane()],
				test: {
					name: 'segment-octane',
					include: ['tests/octane/**/*.test.ts'],
					environment: 'jsdom',
					globals: false,
				},
				resolve: {
					alias: [
						{
							find: /^segment-state$/,
							replacement: resolve(import.meta.dirname, 'src/index.ts'),
						},
						{
							find: /^segment-state\/core$/,
							replacement: resolve(import.meta.dirname, 'src/core/index.ts'),
						},
						{
							find: /^segment-state\/ports$/,
							replacement: resolve(import.meta.dirname, 'src/ports/index.ts'),
						},
						{
							find: /^segment-state\/ssr$/,
							replacement: resolve(import.meta.dirname, 'src/ssr/index.ts'),
						},
					],
				},
			},
			{
				test: {
					name: 'segment-react',
					include: ['tests/react/**/*.test.tsx'],
					environment: 'jsdom',
					globals: false,
				},
				resolve: {
					alias: [
						{
							find: /^segment-state\/core$/,
							replacement: resolve(import.meta.dirname, 'src/core/index.ts'),
						},
						{
							find: /^segment-state\/react$/,
							replacement: resolve(import.meta.dirname, 'src/react/index.ts'),
						},
					],
				},
			},
		],
	},
});
