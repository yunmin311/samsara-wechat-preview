<script>
	import { loadMp4, webCodecsSupported } from '$lib/components/videoPlayer.js';
	import { mediaBase, mobileMedia } from '$lib/clipPath.js';
	import { onMount } from 'svelte';
	import { screen } from '$lib/stores.js';
	import { initGame } from '$lib/game/core.js';
	import { wireNotifications } from '$lib/notify.js';
	import SCREENS from '$lib/screens.js';
	import Background from '$lib/components/Background.svelte';
	import BackgroundMusic from '$lib/components/BackgroundMusic.svelte';
	import NotificationHost from '$lib/components/NotificationHost.svelte';
	import VideoStage from '$lib/components/VideoStage.svelte';

	let ready = $state(false);
	let Current = $derived(SCREENS[$screen]);

	onMount(async () => {
		wireNotifications();
		if (mobileMedia && webCodecsSupported()) {
			// Country selection is the first screen that can lead into the life data.
			for (const clip of [2, 3]) {
				await loadMp4(`${mediaBase}/videos/${clip}.mp4`).catch(() => {});
			}
		}
		await initGame();
		ready = true;
	});
</script>

<!-- Persistent across every screen swap -- see videoStage.svelte.js for why
     this can't be conditionally rendered per-screen the way it used to be. -->
<VideoStage />

<!-- Also persistent, and deliberately outside the {#if ready || (mobileMedia && $screen === 'CITYINTRO')} gate below:
     the background track should be running before the game data finishes
     loading, not after. -->
<BackgroundMusic />

{#if $screen === 'SUMMARY'}
	<Background screen={$screen} />
{/if}

{#if ready || (mobileMedia && $screen === 'CITYINTRO')}
	<Current />
{:else}
	<div class="loading">♀Samsara</div>
{/if}

<NotificationHost />

<style>
	.loading {
		min-height: calc(100 * var(--game-visible-height-unit));
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 2.5rem;
		font-weight: bold;
	}
</style>
