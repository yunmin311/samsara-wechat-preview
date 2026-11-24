import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { exhibitPrinter } from './scripts/exhibit-printer.js';

// The exhibition launcher supplies its own base path for the local kiosk.
const base = process.env.NODE_ENV === 'production' ? process.env.BASE_PATH || '/samsara-wechat-preview' : '';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) => filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			output: { bundleStrategy: 'single' },
			paths: { base }
		}),
		// Silent receipt printing for `npm run exhibit`; inert otherwise.
		exhibitPrinter()
	],
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.js',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
