import { C } from '../core/state.js';

export async function loadExternalScript(key, urls, ready) {
  if (typeof ready === 'function' && ready()) return;
  if (C.libPromises[key]) return await C.libPromises[key];
  C.libPromises[key] = (async () => {
    for (const item of urls) {
      try {
        await new Promise((res, rej) => {
          const url = typeof item === 'string' ? item : item.url;
          const s = document.createElement('script');
          s.src = url;
          s.async = true;
          if (item && typeof item === 'object' && item.integrity) {
            s.integrity = item.integrity;
            s.crossOrigin = 'anonymous';
          }
          s.onload = () => res();
          s.onerror = () => rej(new Error('load failed'));
          document.head.appendChild(s);
        });
        if (!ready || ready()) return;
      } catch {}
    }
    throw new Error('外部ライブラリの読み込みに失敗しました');
  })();
  try {
    return await C.libPromises[key];
  } catch (e) {
    delete C.libPromises[key];
    throw e;
  }
}
