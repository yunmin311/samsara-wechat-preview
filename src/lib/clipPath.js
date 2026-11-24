import { base } from '$app/paths';
import { isAndroidWeChat } from './gameViewport.js';

export const mobileMedia = typeof navigator !== 'undefined' && isAndroidWeChat(navigator.userAgent);
export const mediaBase = mobileMedia ? `${base}/wechat` : base;
