// WebCodecs-based canvas video playback.
//
// Why not a plain <video> element: the intro needs (a) a seamless switch
// from a looping ambient clip to a one-shot transition clip with no black
// flash or decoder spin-up visible, and (b) a hard, reliable freeze on the
// transition clip's final frame. <video> gives you neither guarantee --
// its end-of-stream behavior (flicker, last-frame blanking) is up to the
// browser. Decoding manually via VideoDecoder means every frame is drawn
// by us, so "freeze on the last frame" is simply "stop drawing new
// frames": the canvas keeps whatever was painted last.
//
// VideoDecoder consumes raw encoded samples, not an MP4 container, so
// mp4box.js demuxes the fetched file into EncodedVideoChunks first. The
// chunks are tiny (compressed); only a small rolling window of decoded
// VideoFrames (which are huge) is ever alive at once -- see the
// backpressure logic in play().

import { createFile, DataStream, MP4BoxBuffer } from 'mp4box';
import { onSkip } from '../skip.js';
import { fitScale, STAGE_BG } from './videoFit.js';

export function webCodecsSupported() {
	return typeof VideoDecoder !== 'undefined';
}

// The avcC/hvcC "description" blob VideoDecoder needs for H.264/H.265:
// serialize the sample-entry config box and strip its 8-byte box header
// (size + fourcc) -- the standard mp4box-to-WebCodecs recipe. VP8/VP9/AV1
// need no description, so absence is fine.
function extractDescription(file, trackId) {
	const trak = file.getTrackById(trackId);
	for (const entry of trak.mdia.minf.stbl.stsd.entries) {
		const box = entry.avcC ?? entry.hvcC;
		if (box) {
			const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
			box.write(stream);
			return new Uint8Array(stream.buffer, 8);
		}
	}
	return undefined;
}

// A clip has two milestones. Playback can start with a short runway of
// original samples. A prefetch for the following scene waits for this one
// to finish downloading, so the two never compete during a cold opening.
const mediaCache = new Map();

function streamFor(url) {
	let media = mediaCache.get(url);
	if (media) return media;

	let makePlayable, failOpening;
	const playable = new Promise((resolve, reject) => {
		makePlayable = resolve;
		failOpening = reject;
	});
	playable.catch(() => {}); // a prefetch may only observe finished
	media = { config: null, chunks: [], complete: false, error: null, playable };
	mediaCache.set(url, media);
	media.finished = readMp4(url, media, () => makePlayable(media)).catch(error => {
		media.error = error;
		mediaCache.delete(url);
		failOpening(error);
		throw error;
	});
	media.finished.catch(() => {}); // a player may only observe playable
	return media;
}

export function openMp4(url) {
	return streamFor(url).playable;
}

export function loadMp4(url) {
	return streamFor(url).finished;
}

async function readMp4(url, media, playable) {
	const response = await fetch(url);
	if (!response.ok) throw new Error('HTTP ' + response.status + ' loading ' + url);
	const file = createFile();
	let sampleCount = 0;
	let bufferSamples = 0;
	let offset = 0;
	let parseError;

	file.onError = (...args) => { parseError = new Error('Invalid MP4 ' + url + ': ' + args.join(' ')); };
	file.onReady = info => {
		const track = info.videoTracks[0];
		if (!track) { parseError = new Error('Missing video track in ' + url); return; }
		sampleCount = track.nb_samples;
		// The sample table includes the exact presentation times before the
		// video payload arrives, including frames stored out of display order.
		const samples = file.getTrackSamplesInfo(track.id);
		const lastCts = samples.reduce((last, sample) => Math.max(last, sample.cts), 0);
		media.endTimestamp = Math.round(1e6 * lastCts / track.timescale);
		// About one second at the file's actual frame rate, including B frames.
		bufferSamples = Math.min(sampleCount, Math.ceil(sampleCount * track.timescale / track.duration));
		media.config = {
			codec: track.codec,
			codedWidth: track.video.width,
			codedHeight: track.video.height,
			description: extractDescription(file, track.id)
		};
		file.setExtractionOptions(track.id, null, { nbSamples: 8 });
		file.start();
	};
	file.onSamples = (id, _, samples) => {
		for (const s of samples) {
			media.chunks.push(new EncodedVideoChunk({
				type: s.is_sync ? 'key' : 'delta',
				timestamp: Math.round(1e6 * s.cts / s.timescale),
				duration: Math.round(1e6 * s.duration / s.timescale),
				data: s.data
			}));
		}
		file.releaseUsedSamples(id, media.chunks.length);
		if (media.chunks.length >= bufferSamples) playable();
	};

	function append(bytes) {
		const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buffer, offset));
		offset += bytes.byteLength;
		if (parseError) throw parseError;
	}
	if (response.body?.getReader) {
		const reader = response.body.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				append(value);
			}
		} catch (error) {
			await reader.cancel().catch(() => {});
			throw error;
		} finally {
			reader.releaseLock();
		}
	} else {
		append(new Uint8Array(await response.arrayBuffer()));
	}
	file.flush();
	if (parseError) throw parseError;
	if (!sampleCount || media.chunks.length !== sampleCount) throw new Error('Incomplete MP4 ' + url);
	media.complete = true;
	playable();
	return media;
}

export class CanvasVideoPlayer {
	#canvas;
	#ctx;
	#session = null;
	// The most recently painted frame, kept open (not closed) so the canvas
	// can be repainted after a resize -- resizing a canvas clears it, and
	// during the "frozen on last frame" phase there is no playback loop
	// left to repaint it for us.
	#lastFrame = null;
	// Active clip-boundary alignment (see play()'s `align` option), or null.
	#align = null;
	// Same idea, other end of the clip (see play()'s `alignOut` option). Held
	// past end-of-clip on purpose -- #align self-clears once eased out, but
	// this one is still in force on the frozen final frame, so redraw() after
	// a resize has to keep applying it.
	#alignOut = null;

	constructor(canvas) {
		this.#canvas = canvas;
		this.#ctx = canvas.getContext('2d');
	}

	// Repaint the current frame (after e.g. a canvas resize).
	redraw() {
		if (this.#lastFrame) this.#paint(this.#lastFrame);
	}

	// Fit the frame's height (see videoFit.js): on screens narrower than
	// 16:9 this is cover, on wider ones the frame is centred between dark
	// side bars instead of losing its top and bottom.
	#paint(frame) {
		const cw = this.#canvas.width;
		const ch = this.#canvas.height;
		if (!cw || !ch) return;
		const fw = frame.displayWidth;
		const fh = frame.displayHeight;
		const s = fitScale(cw, ch, fw, fh);
		let dw = fw * s;
		let dh = fh * s;
		let dx = (cw - dw) / 2;
		let dy = (ch - dh) / 2;
		if (dx > 0) {
			// The canvas is never cleared (see the warp note below), so paint
			// the side bars explicitly or they would keep stale pixels.
			const ctx = this.#ctx;
			ctx.fillStyle = STAGE_BG;
			ctx.fillRect(0, 0, Math.ceil(dx), ch);
			ctx.fillRect(Math.floor(dx + dw), 0, Math.ceil(dx) + 1, ch);
		}
		// Clip-boundary alignment: warp this clip's early frames so its
		// content starts exactly where the previous clip's content was, then
		// ease the warp out -- the framing mismatch plays as a deliberate
		// camera move instead of a snap. The warp is a video-pixel-space
		// scale k about the origin plus offset u, composed with the cover
		// transform: screen = off + s*(k*v + u). Any strip the warped rect
		// leaves uncovered keeps the previous clip's pixels (the canvas is
		// never cleared), which is the correct scene content there.
		const a = this.#align;
		if (a) {
			const t = frame.timestamp / a.durationUs;
			if (t >= 1) this.#align = null;
			else {
				const remain = Math.pow(1 - Math.max(0, t), 3); // easeOutCubic
				const kx = 1 + (a.kx - 1) * remain;
				const ky = 1 + (a.ky - 1) * remain;
				dx += s * a.ux * remain;
				dy += s * a.uy * remain;
				dw *= kx;
				dh *= ky;
			}
		}
		// Same warp, ramped IN over the clip's tail instead of out over its
		// head: zero at durationMs before the end, full on the final frame.
		// Used where the NEXT clip's framing is the fixed thing and this one
		// has to arrive at it (8.mp4 -> 1.mp4: the restart clip's last frame
		// sits further back than 1.mp4's opening, so the woman snaps larger
		// on the handoff). easeInOutCubic rather than a cubic ramp so the
		// correction both starts and settles at zero velocity -- it reads as
		// the tail of the dolly, not a lurch at the cut.
		const b = this.#alignOut;
		if (b) {
			const left = (b.endUs - frame.timestamp) / b.durationUs;
			const p = 1 - Math.min(1, Math.max(0, left)); // 0 far from end, 1 at end
			const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
			dx += s * b.ux * e;
			dy += s * b.uy * e;
			dw *= 1 + (b.kx - 1) * e;
			dh *= 1 + (b.ky - 1) * e;
		}
		this.#ctx.drawImage(frame, dx, dy, dw, dh);
	}

	#present(frame) {
		this.#paint(frame);
		this.#lastFrame?.close();
		this.#lastFrame = frame;
	}

	// Plays a demuxed media object. loop:true restarts seamlessly (the
	// canvas keeps the last frame across the restart, so even the brief
	// re-decode of the first GOP shows no gap). Without loop, the final
	// frame stays frozen on the canvas and onEnded fires. rate scales the
	// presentation clock (0.5 = half speed) -- decode order and frame
	// selection are untouched, frames simply become due later.
	//
	// align: { kx, ky, ux, uy, durationMs } -- inverse of the measured
	// affine mismatch between the previous clip's last frame and this
	// clip's first frame (scale about the video origin plus pixel offset).
	// Applied in full at t=0 and eased out over durationMs of media time,
	// so consecutive clips shot with slightly different framing join as a
	// continuous camera move. Not reapplied on loop restarts.
	//
	// alignOut: same shape, applied at the clip's END instead -- zero until
	// durationMs before the last frame, full on it. For the case where the
	// clip that follows owns the framing and this one has to land on it.
	// The clip's end in media time comes from the chunk timestamps rather
	// than a container duration, so it is exact for the frames we actually
	// present (max, not last: decode order is not presentation order).
	play(media, { loop = false, onEnded = null, rate = 1, align = null, alignOut = null, onStarted = null, onError = null } = {}) {
		this.stop(false); // keep #lastFrame: bridges the switch between clips
		this.#align = align ? { ...align, durationUs: align.durationMs * 1000 } : null;
		const { config, chunks } = media;
		this.#alignOut = alignOut
			? {
					...alignOut,
					durationUs: alignOut.durationMs * 1000,
					endUs: media.endTimestamp,
				}
			: null;

		const session = { aborted: false, raf: 0, timer: 0, flushing: false };
		this.#session = session;

		// Rolling window: decoded frames waiting to be presented. VideoFrames
		// are uncompressed (megabytes each), so feeding is throttled below to
		// keep at most a handful alive instead of decoding the whole clip.
		const frames = [];
		let feedIndex = 0;
		let flushDone = false;

		const decoder = new VideoDecoder({
			output: frame => {
				if (session.aborted) frame.close();
				else frames.push(frame);
			},
			error: err => {
				console.error('[videoPlayer] decode error', err);
				// Surface hard decoder failures to the stage so it can demote
				// the whole session to the <video> path. `typeof VideoDecoder`
				// passing does NOT guarantee this stream's profile actually
				// decodes on this device -- the classic mobile failure mode is
				// an API that exists and a decoder that errors on first frame,
				// which used to leave a black canvas with onEnded never firing
				// (the screen flow stalls forever behind it).
				if (!session.aborted) {
					session.aborted = true;
					onError?.(err);
				}
			},
		});
		try {
			decoder.configure(config);
		} catch (err) {
			session.aborted = true;
			onError?.(err);
			return;
		}

		// Debug double-space skip (see skip.js): burst-decodes the whole clip
		// with a throwaway decoder (no real-time pacing) to get its true last
		// frame, presents that, and completes exactly as a normal end-of-clip
		// would -- same onEnded/loop handling, just without the wait. A no-op
		// on looping playback (nothing to "skip to" on a clip with no end).
		const offSkip = onSkip(async () => {
			if (loop || session.aborted || ended) return;
			if (!media.complete) {
				try { await media.finished; } catch { return; }
				if (session.aborted || ended) return;
			}
			ended = true;
			cancelAnimationFrame(session.raf);
			clearInterval(session.timer);
			offSkip();
			for (const f of frames) f.close();
			frames.length = 0;
			try {
				decoder.close();
			} catch {
				/* already closed/closing */
			}
			let lastFrame = null;
			const burst = new VideoDecoder({
				output: f => {
					lastFrame?.close();
					lastFrame = f;
				},
				error: err => console.error('[videoPlayer] skip decode error', err),
			});
			burst.configure(config);
			for (const c of chunks) burst.decode(c);
			burst
				.flush()
				.catch(() => {})
				.then(() => {
					try {
						burst.close();
					} catch {
						/* already closed */
					}
					if (session.aborted) {
						lastFrame?.close();
						return;
					}
					if (lastFrame) this.#present(lastFrame);
					this.#session = null;
					onEnded?.();
				});
		});

		const pump = () => {
			while (feedIndex < chunks.length && decoder.decodeQueueSize < 6 && frames.length < 6) {
				decoder.decode(chunks[feedIndex++]);
			}
			if (media.complete && feedIndex >= chunks.length && !session.flushing) {
				session.flushing = true;
				decoder
					.flush()
					.then(() => {
						flushDone = true;
					})
					.catch(() => {});
			}
		};

		let baseTime = null;
		let ended = false;
		const tick = now => {
			if (session.aborted || ended) return;
			if (media.error) {
				this.stop(false);
				onError?.(media.error);
				return;
			}
			pump();
			if (frames.length) {
				// Decoder outputs arrive in presentation order; anchor the
				// clock to the first presented frame's own timestamp.
				if (baseTime === null) baseTime = now - frames[0].timestamp / (1000 * rate);
				const mediaTimeUs = (now - baseTime) * 1000 * rate;
				while (frames.length && frames[0].timestamp <= mediaTimeUs) {
					const frame = frames.shift();
					const lastEligible = !frames.length || frames[0].timestamp > mediaTimeUs;
					if (lastEligible) {
						this.#present(frame);
						onStarted?.();
						onStarted = null;
					} else frame.close(); // running late: drop, don't draw stale frames
				}
			}
			if (flushDone && frames.length === 0) {
				ended = true;
				cancelAnimationFrame(session.raf);
				clearInterval(session.timer);
				offSkip();
				try {
					decoder.close();
				} catch {
					/* already closed */
				}
				if (loop) this.play(media, { loop, onEnded, rate });
				else {
					this.#session = null;
					onEnded?.();
				}
			}
		};
		// Two drivers for the same tick: rAF for frame-accurate pacing while
		// the page is visible, plus a coarse interval heartbeat so decode and
		// playback keep making real-time progress even when the browser
		// throttles rAF (occluded window, background tab) -- with rAF alone,
		// decoding stalls to a few frames per second and the clip crawls in
		// slow motion (observed live in an occluded window).
		const rafLoop = now => {
			if (session.aborted || ended) return;
			tick(now);
			session.raf = requestAnimationFrame(rafLoop);
		};
		session.raf = requestAnimationFrame(rafLoop);
		session.timer = setInterval(() => tick(performance.now()), 200);

		session.abort = () => {
			session.aborted = true;
			cancelAnimationFrame(session.raf);
			clearInterval(session.timer);
			offSkip();
			for (const f of frames) f.close();
			frames.length = 0;
			try {
				decoder.close();
			} catch {
				/* already closed */
			}
		};
	}

	stop(clearLastFrame = true) {
		this.#session?.abort?.();
		this.#session = null;
		if (clearLastFrame) {
			this.#lastFrame?.close();
			this.#lastFrame = null;
		}
	}
}
