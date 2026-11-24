// One canvas + one CanvasVideoPlayer, shared by every screen that plays a
// clip from videos/ (CityIntro, Trajectory's StairwellBackground). It's
// attached exactly once, by VideoStage.svelte, which +page.svelte renders
// unconditionally so it's never torn down while the app runs -- previously
// each screen created its own canvas + player, so every screen swap
// destroyed the outgoing one and started the incoming one from a blank
// slate. That gap (nothing painted until the new canvas's first frame
// decoded) was the actual black-flash bug: the two screens' frames were
// pixel-identical by design, but the canvas holding them was not the same
// object, so there was a real moment with nothing to show. Routing every
// screen's playback through this one shared instance means the same
// decoder just keeps going across screen boundaries -- nothing is ever
// destroyed at the seam, so there's nothing to flash.
import { webCodecsSupported, loadMp4, openMp4, CanvasVideoPlayer } from './videoPlayer.js';

const supported = webCodecsSupported();

class VideoStage {
	#canvas = null;
	#stageEl = null;
	#player = null;
	#resizeObserver = null;

	// Fallback (<video>) path reactive state -- VideoStage.svelte's single
	// <video> element reacts to this via an $effect (load + play whenever
	// `key` changes), the same way each screen used to drive its own
	// element directly.
	fallback = $state({ src: '', loop: false, rate: 1, muted: false, key: 0 });
	#fallbackOnEnded = null;

	get supported() {
		return supported;
	}

	attach(canvasEl, stageEl) {
		this.#canvas = canvasEl;
		this.#stageEl = stageEl;
		if (!supported) return;
		this.#player = new CanvasVideoPlayer(canvasEl);
		this.#resizeObserver = new ResizeObserver(() => this.#resize());
		this.#resizeObserver.observe(stageEl);
		this.#resize();
	}

	#resize() {
		if (!this.#stageEl || !this.#canvas || !this.#player) return;
		const w = this.#stageEl.clientWidth;
		const h = this.#stageEl.clientHeight;
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		this.#canvas.width = Math.round(w * dpr);
		this.#canvas.height = Math.round(h * dpr);
		this.#player.redraw(); // resizing clears the canvas -- repaint current frame
	}

	// Once a decode/demux failure has been seen, every later play() routes
	// to the <video> fallback for the rest of the session -- a device that
	// failed one H.264 stream will fail the next seven the same way.
	#demoted = false;
	#sequence = 0;
	#stopSound = null;
	#fallbackOnStarted = null;

	// Prime the element inside the visitor's tap on browsers that require
	// user activation. Start the audible track on the first painted frame.
	#soundtrack(audio, rate) {
		this.#stopSound?.();
		this.#stopSound = null;
		if (!audio) return;
		audio.playbackRate = rate;
		audio.currentTime = 0;
		if (navigator.userActivation?.isActive) {
			audio.play().catch(() => {});
			audio.pause();
		}
		let active = true;
		const disarm = () => {
			window.removeEventListener('pointerdown', start, true);
			window.removeEventListener('keydown', start, true);
		};
		const start = () => {
			if (!active) return;
			audio.play().then(disarm).catch(() => {
				if (!active) return;
				window.addEventListener('pointerdown', start, true);
				window.addEventListener('keydown', start, true);
			});
		};
		this.#stopSound = () => { active = false; disarm(); audio.pause(); };
		return start;
	}

	async play(url, { loop = false, onEnded = null, rate = 1, align = null, alignOut = null, audio = null, next = null, onStarted = null } = {}) {
		const sequence = ++this.#sequence;
		const startSound = this.#soundtrack(audio, rate);
		const started = () => { startSound?.(); onStarted?.(); };
		const native = () => this.playFallback(url, { loop, rate, muted: true, onEnded, onStarted: started });
		if (this.#demoted || !this.#player) { native(); return; }

		const fallback = () => {
			if (sequence !== this.#sequence) return;
			this.#demoted = true;
			this.#player.stop(false);
			if (audio) { audio.pause(); audio.currentTime = 0; }
			native();
		};
		try {
			const media = await openMp4(url);
			if (sequence !== this.#sequence) return;
			this.#player.play(media, { loop, onEnded, rate, align, alignOut, onStarted: started, onError: fallback });
			if (next) media.finished.then(() => {
				if (sequence === this.#sequence && !this.#demoted) return loadMp4(next);
			}).catch(() => {}); // an actual play retries a failed prefetch
		} catch {
			fallback();
		}
	}

	playFallback(url, { loop = false, rate = 1, muted = false, onEnded = null, onStarted = null } = {}) {
		this.#fallbackOnEnded = onEnded;
		this.#fallbackOnStarted = onStarted;
		this.fallback = { src: url, loop, rate, muted, key: this.fallback.key + 1 };
	}

	fallbackStarted() {
		this.#fallbackOnStarted?.();
		this.#fallbackOnStarted = null;
	}

	fallbackEnded() {
		const done = this.#fallbackOnEnded;
		this.#fallbackOnEnded = null;
		done?.();
	}

	stop() {
		this.#stopSound?.();
		this.#player?.stop();
	}

	detach() {
		this.#sequence++;
		this.#stopSound?.();
		this.#resizeObserver?.disconnect();
		this.#resizeObserver = null;
		this.#player?.stop();
		this.#player = null;
	}
}

export const videoStage = new VideoStage();
