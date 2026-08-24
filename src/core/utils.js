import { LIMITS, PDF_JS_OPTIONS } from './constants.js';

export const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
export const fmt = (b) => !isFinite(b) || b <= 0 ? '0 MB' : (b / 1048576).toFixed(2) + ' MB';
export const uid = () => crypto?.randomUUID ? crypto.randomUUID() : 'id_' + Date.now() + '_' + Math.random().toString(16).slice(2);
export const base = (n) => String(n || '').replace(/\.[^/.]+$/, '') || 'document';
export const normRot = (d) => {
  const n = ((Number(d) || 0) % 360 + 360) % 360;
  return n - (n % 90);
};
export const msg = (el, t) => { el.textContent = t || ''; };
export const prog = (box, fill, on, p = 0) => {
  box.style.display = on ? 'block' : 'none';
  fill.style.width = clamp(Number(p) || 0, 0, 100) + '%';
};
export const emptyNode = (text) => {
  const d = document.createElement('div');
  d.className = 'empty';
  d.textContent = text;
  return d;
};
export const pdfLoadParams = (bytes) => ({data: new Uint8Array(bytes.slice(0)), ...PDF_JS_OPTIONS});

export function assertCanvasBudget(w, h, label = '処理') {
  const px = (Number(w) || 0) * (Number(h) || 0);
  if (px > LIMITS.maxCanvasPixels) {
    throw new Error(label + 'の描画サイズが大きすぎます。解析倍率を下げるか、ページ範囲を分けてください。');
  }
}

export const dl = (blob, name) => {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => {
    try { URL.revokeObjectURL(url); } catch {}
  }, 30000);
};

export const toAB = (v) => v instanceof ArrayBuffer ? v.slice(0) : v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);

export function dataUrlToBlob(dataUrl) {
  const p = String(dataUrl || '').split(',');
  if (p.length < 2) return null;
  const mime = (p[0].match(/:(.*?);/) || [])[1] || 'application/octet-stream';
  const bin = atob(p[1]);
  const len = bin.length;
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], {type: mime});
}

export function canvasToBlobSafe(canvas, mime = 'image/png', quality) {
  return new Promise((res, rej) => {
    try {
      canvas.toBlob((b) => {
        if (b) {
          res(b);
          return;
        }
        try {
          const dataUrl = canvas.toDataURL(mime, quality);
          const fb = dataUrlToBlob(dataUrl);
          if (fb) res(fb);
          else rej(new Error('canvas blob化に失敗しました'));
        } catch (e) {
          rej(e);
        }
      }, mime, quality);
    } catch (e) {
      try {
        const dataUrl = canvas.toDataURL(mime, quality);
        const fb = dataUrlToBlob(dataUrl);
        if (fb) res(fb);
        else rej(new Error('canvas blob化に失敗しました'));
      } catch (err) {
        rej(err);
      }
    }
  });
}

export function resolvePageRange(total, startRaw, endRaw) {
  const t = Math.max(1, Number(total) || 1);
  let s = parseInt(startRaw, 10);
  if (!Number.isFinite(s) || s < 1) s = 1;
  let e = parseInt(endRaw, 10);
  if (!Number.isFinite(e) || e < 1) e = t;
  s = clamp(s, 1, t);
  e = clamp(e, 1, t);
  if (e < s) {
    const tmp = s;
    s = e;
    e = tmp;
  }
  return {start: s, end: e, count: (e - s + 1)};
}
