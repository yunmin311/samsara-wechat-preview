import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadMp4, openMp4 } from './videoPlayer.js';

const clip = readFileSync(new URL('../../../static/videos/2.mp4', import.meta.url));

afterEach(() => vi.unstubAllGlobals());

function connection() {
	let stream;
	vi.stubGlobal('EncodedVideoChunk', class {
		constructor({ type, timestamp, duration }) { Object.assign(this, { type, timestamp, duration }); }
	});
	const response = new Response(new ReadableStream({ start(controller) { stream = controller; } }));
	const fetch = vi.fn().mockResolvedValue(response);
	vi.stubGlobal('fetch', fetch);
	return { stream, fetch };
}

it('can play the opening samples while the rest of the same download is pending', async () => {
	const { stream, fetch } = connection();
	const playback = openMp4('/stream-test.mp4');
	const downloaded = loadMp4('/stream-test.mp4');
	stream.enqueue(clip.subarray(0, 640000));
	const media = await playback;
	expect(media.chunks[0].type).toBe('key');
	const earlyCount = media.chunks.length;
	expect(earlyCount).toBeGreaterThan(1);
	expect(media.complete).toBe(false);
	stream.enqueue(clip.subarray(640000));
	stream.close();
	expect(await downloaded).toBe(media);
	expect(media.chunks.length).toBeGreaterThan(earlyCount);
	expect(media.complete).toBe(true);
	expect(fetch).toHaveBeenCalledTimes(1);
});

it('discards an interrupted stream so the same URL can be fetched again', async () => {
	const first = connection();
	const playback = openMp4('/retry-test.mp4');
	const downloaded = loadMp4('/retry-test.mp4');
	first.stream.enqueue(clip.subarray(0, 640000));
	const partial = await playback;
	first.stream.error(new Error('interrupted'));
	await expect(downloaded).rejects.toThrow('interrupted');
	expect(partial.error).toBeTruthy();

	const retry = connection();
	const complete = loadMp4('/retry-test.mp4');
	retry.stream.enqueue(clip);
	retry.stream.close();
	expect((await complete).complete).toBe(true);
	expect(retry.fetch).toHaveBeenCalledTimes(1);
});
