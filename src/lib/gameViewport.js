export function isAndroidWeChat(userAgent) {
	return /Android/i.test(userAgent) && /MicroMessenger/i.test(userAgent);
}

export function gameViewport() {
	const stage = document.getElementById('game-viewport');
	return {
		width: stage?.clientWidth || window.innerWidth,
		height: stage?.clientHeight || window.innerHeight,
		sideways: stage?.classList.contains('sideways') ?? false
	};
}

export function observeGameViewport(update) {
	const resize = () => update(gameViewport());
	const observer = new ResizeObserver(resize);
	observer.observe(document.getElementById('game-viewport'));
	window.addEventListener('resize', resize);
	resize();
	return () => {
		observer.disconnect();
		window.removeEventListener('resize', resize);
	};
}
