<script>
	// The Trajectory backdrop, in three acts, all one continuous shot,
	// played through the shared VideoStage canvas (see videoStage.svelte.js
	// -- this component no longer owns a canvas of its own; Plaza's frozen
	// 4.mp4 frame is already sitting on that shared canvas the instant this
	// mounts, so 5.mp4 just continues straight out of it with nothing to
	// bridge):
	//
	//   1. 5.mp4 plays once (walking through the corridor's EXIT door into
	//      the stairwell, ending looking straight up its void) and freezes
	//      on its final frame -- `onAllocReady` fires, and Trajectory shows
	//      the stat-allocation panel over that motionless frame.
	//   2. When allocation is confirmed, `advance` flips true and 6.mp4
	//      plays once (dropping from the void down into a side view of the
	//      stair flights).
	//   3. On 6.mp4's final frame, the walking loop starts (`onWalking`
	//      fires; Trajectory begins the life sim): an endless stair-climb
	//      built from that very frame (stairwell.jpg, extracted from the
	//      clip) -- two stacked copies of the still, each slowly zooming
	//      toward the upper-left flight (the direction the staircase
	//      ascends) and crossfading into the other, so the climb never
	//      visibly resets; a gentle vertical bob on top gives it a walking
	//      rhythm. This replaces the earlier spinning-frame treatment.
	//   4. When the life ends and View Summary is clicked, `exit` flips
	//      true: the loop stops and 7.mp4 (opening on this same stair
	//      view, fading out to black) plays once -- `onExited` fires at
	//      its end and Trajectory hands over to the SUMMARY screen from
	//      under full black.
	import { onMount, onDestroy } from 'svelte';
	import { base } from '$app/paths';
	import { videoStage } from '../videoStage.svelte.js';

	let { onAllocReady = null, advance = false, onWalking = null, exit = false, onExited = null } = $props();

	const clip = n => `${base}/videos/${n}.mp4`;

	let audio5El = $state(null);
	let audio6El = $state(null);
	let audio7El = $state(null);
	let advanceStarted = false;
	let exitStarted = false;

	// True once 6.mp4 has ended: swaps the frozen canvas for the two
	// crossfading walk layers.
	let walking = $state(false);

	function startWalking() {
		if (walking) return;
		walking = true;
		onWalking?.();
	}

	onMount(() => {
		// The walking loop's two layers (below) reference stairwell.jpg via
		// CSS background-image, first painted only once 6.mp4 ends -- by
		// then 5.mp4 and 6.mp4 (21s combined) have already played, so this
		// warms the HTTP cache with time to spare and the image is never the
		// thing making that entrance late.
		new Image().src = `${base}/images/stairwell.jpg`;

		videoStage.play(clip(5), { audio: audio5El, next: clip(6), onEnded: () => onAllocReady?.() });
	});

	$effect(() => {
		if (!advance || advanceStarted) return;
		advanceStarted = true;
		videoStage.play(clip(6), { audio: audio6El, next: clip(7), onEnded: startWalking });
	});

	$effect(() => {
		if (!exit || exitStarted) return;
		exitStarted = true;
		walking = false;
		videoStage.play(clip(7), { audio: audio7El, next: clip(8), onEnded: () => onExited?.() });
	});

	onDestroy(() => {
		audio5El?.pause();
		audio6El?.pause();
		audio7El?.pause();
	});
</script>

{#if walking}
	<!-- The endless climb: both layers carry the same still (6.mp4's final
	     frame); each runs the same slow zoom toward the upper-left stair
	     flight over WALK_PERIOD*2, offset by one period, fading in/out at
	     its cycle's ends -- at any moment at least one layer is fully
	     opaque, so the reset never shows. The bob wrapper adds the step
	     rhythm. No z-index of its own: it just needs to paint above the
	     shared VideoStage canvas (z-index -1), which normal stacking order
	     already gives it. -->
	<div class="walk-bob" aria-hidden="true">
		<div class="walk-layer" style="background-image: url('{base}/images/stairwell.jpg');"></div>
		<div class="walk-layer late" style="background-image: url('{base}/images/stairwell.jpg');"></div>
	</div>
{/if}
<audio bind:this={audio5El} src="{base}/audios/5.m4a" preload="none"></audio>
<audio bind:this={audio6El} src="{base}/audios/6.m4a" preload="none"></audio>
<audio bind:this={audio7El} src="{base}/audios/7.m4a" preload="none"></audio>

<style>
	/* Slightly overscanned so the bob's vertical drift never uncovers the
	   viewport edges at a layer's scale-1 start. */
	.walk-bob {
		position: fixed;
		inset: -2%;
		animation: walk-bob 1.9s ease-in-out infinite;
	}
	/* Each layer's full cycle is 2x the effective loop period; the second
	   layer runs the same animation shifted by exactly one period. Opacity
	   holds at 1 through the middle half of the cycle and only ramps at
	   the ends, so the two ramps always overlap a fully-opaque partner. */
	.walk-layer {
		position: absolute;
		inset: 0;
		background-size: cover;
		background-position: center;
		background-repeat: no-repeat;
		/* Forward motion = toward the upper-left flight the staircase
		   ascends into; keeping the origin there makes the zoom read as
		   walking that direction rather than a centered enlarge. */
		transform-origin: 32% 26%;
		opacity: 0;
		animation: walk-zoom 16s linear infinite;
	}
	.walk-layer.late {
		animation-delay: -8s;
	}
	@keyframes walk-zoom {
		0% {
			transform: scale(1);
			opacity: 0;
		}
		25% {
			opacity: 1;
		}
		75% {
			opacity: 1;
		}
		100% {
			transform: scale(1.18);
			opacity: 0;
		}
	}
	@keyframes walk-bob {
		0%,
		100% {
			transform: translateY(0);
		}
		50% {
			transform: translateY(0.55%);
		}
	}
</style>
