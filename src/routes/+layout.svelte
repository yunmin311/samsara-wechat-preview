<script>
	import '../app.css';
	import { onMount } from 'svelte';
	import { isAndroidWeChat } from '$lib/gameViewport.js';
	import { base } from '$app/paths';
	import RotateGate from '$lib/components/RotateGate.svelte';
	import { lang } from '$lib/i18n.js';

	let { children } = $props();
	let sideways = $state(false);

	onMount(() => {
		if (!isAndroidWeChat(navigator.userAgent)) return;

		const portrait = matchMedia('(orientation: portrait) and (max-width: 599px)');
		const root = document.documentElement;
		const sync = () => {
			sideways = portrait.matches;
			root.classList.toggle('samsara-sideways', sideways);
		};
		sync();
		portrait.addEventListener('change', sync);
		return () => {
			portrait.removeEventListener('change', sync);
			root.classList.remove('samsara-sideways');
		};
	});

	// app.html ships lang="en"; keep the document's language in step with the
	// selected one (screen readers, CJK font selection, hyphenation).
	$effect(() => {
		document.documentElement.lang = $lang === 'zh' ? 'zh-CN' : 'en';
	});
</script>

<svelte:head>
	<link rel="icon" href="{base}/favicon.ico" />
	<!-- The manifest's `orientation: landscape` only binds when the page is
	     installed/launched as a PWA -- in a plain browser tab, RotateGate's
	     portrait overlay below is what actually steers the player. -->
	<link rel="manifest" href="{base}/manifest.webmanifest" />
</svelte:head>

<div id="game-viewport" class:sideways>
	{@render children()}
</div>

{#if !sideways}
	<RotateGate />
{/if}

<style>
	#game-viewport {
		display: contents;
	}

	/* WeChat can keep its Android window in portrait. Swap the dimensions
	   before rotation so the video and its overlays both lay out landscape. */
	#game-viewport.sideways {
		display: block;
		position: fixed;
		top: 0;
		left: 0;
		width: calc(100 * var(--game-width-unit));
		height: 100vw;
		transform-origin: top left;
		transform: translateX(100vw) rotate(90deg);
	}
</style>
