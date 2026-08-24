import { U } from '../core/dom.js';
import { S } from '../core/state.js';
import {
  assertCanvasBudget,
  base,
  clamp,
  dl,
  msg,
  pdfLoadParams,
  prog,
  toAB,
  uid
} from '../core/utils.js';

export function createStampTools({DBI, WK}) {
  function renderStampSelect() {
    const pdfs = S.meta.filter(f => f.kind === 'pdf');
    const old = U.stFile.value;
    U.stFile.innerHTML = '';
    if (!pdfs.length) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = 'PDFファイルがありません';
      U.stFile.appendChild(o);
      return;
    }
    for (const f of pdfs) {
      const o = document.createElement('option');
      o.value = f.id; o.textContent = f.name;
      U.stFile.appendChild(o);
    }
    if (pdfs.some(x => x.id === old)) U.stFile.value = old;
  }

  async function loadStamp() {
    const fid = U.stFile.value;
    if (!fid) return;
    msg(U.stMsg, 'PDF読込中...');

    try {
      const r = await DBI.get(fid);
      if (!r || r.kind !== 'pdf') throw new Error('PDFが見つかりません');

      if (S.stDoc) try { await S.stDoc.destroy(); } catch {}

      const bytes = toAB(r.data);
      S.stFileId = fid;
      S.stBytes = bytes;
      S.stDoc = await pdfjsLib.getDocument(pdfLoadParams(bytes)).promise;
      S.stPage = 1;
      if (U.stPageInput) { U.stPageInput.min = '1'; U.stPageInput.max = String(S.stDoc.numPages); U.stPageInput.value = '1'; }
      if (!S.stampsByFile[fid]) S.stampsByFile[fid] = [];
      S.stPt = {x: 0.15, y: 0.15};

      renderStPoint();
      renderStampList();
      await renderStampPage();
      msg(U.stMsg, '読み込み完了');
    } catch (e) {
      console.error(e);
      msg(U.stMsg, 'エラー: ' + (e?.message || e));
    }
  }

  const getStamps = () => S.stFileId ? (S.stampsByFile[S.stFileId] || []) : [];

  function renderStPoint() {
    U.stPoint.textContent = 'x:' + (S.stPt.x * 100).toFixed(1) + '%, y:' + (S.stPt.y * 100).toFixed(1) + '%';
  }

  function renderStampList() {
    const arr = getStamps();
    U.stList.replaceChildren();

    if (!arr.length) {
      const li = document.createElement('li');
      li.textContent = 'スタンプはまだありません';
      U.stList.appendChild(li);
      return;
    }

    for (const s of arr) {
      const li = document.createElement('li');
      const label = s.kind === 'mask'
        ? 'P' + s.page + ' / 白マスク / ' + (s.xRatio * 100).toFixed(1) + '%, ' + (s.yRatio * 100).toFixed(1) + '%'
        : 'P' + s.page + ' / ' + s.text + ' / ' + (s.xRatio * 100).toFixed(1) + '%, ' + (s.yRatio * 100).toFixed(1) + '%';

      const span = document.createElement('span');
      span.textContent = label;
      const button = document.createElement('button');
      button.textContent = '削除';
      button.style.cssText = 'border:1px solid #d4deea;background:#fff;border-radius:5px;cursor:pointer;font-size:11px;padding:4px 7px';
      button.addEventListener('click', () => {
        const fid = S.stFileId;
        S.stampsByFile[fid] = getStamps().filter(x => x.id !== s.id);
        renderStampList();
        renderStampOverlay();
      });
      li.append(span, button);
      U.stList.appendChild(li);
    }
  }

  function removeStamp(id) {
    if (!S.stFileId) return;
    S.stampsByFile[S.stFileId] = getStamps().filter(x => x.id !== id);
    renderStampList();
    renderStampOverlay();
  }

  function attachMove(el, s) {
    el.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest('.st-del') || ev.target.closest('.st-resize')) return;
      ev.preventDefault();
      ev.stopPropagation();

      const startX = ev.clientX;
      const startY = ev.clientY;
      const startL = parseFloat(el.style.left) || 0;
      const startT = parseFloat(el.style.top) || 0;

      const onMove = (mv) => {
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        const nx = clamp(startL + (mv.clientX - startX), 0, Math.max(0, U.stCanvas.width - w));
        const ny = clamp(startT + (mv.clientY - startY), 0, Math.max(0, U.stCanvas.height - h));
        el.style.left = nx + 'px';
        el.style.top = ny + 'px';
        s.xRatio = clamp(nx / U.stCanvas.width, 0, 1);
        s.yRatio = clamp(ny / U.stCanvas.height, 0, 1);
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        renderStampList();
        renderStPoint();
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  function attachMaskResize(el, s, handle) {
    handle.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();

      const startX = ev.clientX;
      const startY = ev.clientY;
      const startW = el.offsetWidth;
      const startH = el.offsetHeight;
      const left = parseFloat(el.style.left) || 0;
      const top = parseFloat(el.style.top) || 0;

      const onMove = (mv) => {
        const nw = clamp(startW + (mv.clientX - startX), 10, Math.max(10, U.stCanvas.width - left));
        const nh = clamp(startH + (mv.clientY - startY), 10, Math.max(10, U.stCanvas.height - top));
        el.style.width = nw + 'px';
        el.style.height = nh + 'px';
        s.widthRatio = clamp(nw / U.stCanvas.width, 0.01, 1);
        s.heightRatio = clamp(nh / U.stCanvas.height, 0.01, 1);
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        renderStampList();
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  function renderStampOverlay() {
    if (!U.stOverlay || !U.stCanvas.width || !U.stCanvas.height) return;
    U.stOverlay.replaceChildren();
    U.stOverlay.style.width = U.stCanvas.width + 'px';
    U.stOverlay.style.height = U.stCanvas.height + 'px';

    const arr = getStamps().filter(s => s.page === S.stPage);
    for (const s of arr) {
      const el = document.createElement('div');
      el.className = 'st-item ' + (s.kind === 'mask' ? 'st-item-mask' : 'st-item-text');

      const left = clamp(Number(s.xRatio) || 0, 0, 1) * U.stCanvas.width;
      const top = clamp(Number(s.yRatio) || 0, 0, 1) * U.stCanvas.height;
      el.style.left = left + 'px';
      el.style.top = top + 'px';
      el.style.opacity = String(clamp(Number(s.opacity) || 1, 0.05, 1));

      if (s.kind === 'mask') {
        const rw = clamp(Number(s.widthRatio) || 0.2, 0.01, 1) * U.stCanvas.width;
        const rh = clamp(Number(s.heightRatio) || 0.08, 0.01, 1) * U.stCanvas.height;
        el.style.width = rw + 'px';
        el.style.height = rh + 'px';
        el.style.background = 'rgba(255,255,255,' + clamp(Number(s.opacity) || 1, 0.05, 1) + ')';

        const res = document.createElement('div');
        res.className = 'st-resize';
        el.appendChild(res);
        attachMaskResize(el, s, res);
      } else {
        el.textContent = String(s.text || '');
        el.style.color = s.color || '#d00000';
        el.style.fontSize = Math.max(6, Number(s.size) || 20) + 'px';
        el.style.fontWeight = '700';
      }

      const del = document.createElement('button');
      del.className = 'st-del';
      del.textContent = '×';
      del.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); removeStamp(s.id); });
      el.appendChild(del);

      attachMove(el, s);
      U.stOverlay.appendChild(el);
    }

    const cross = document.createElement('div');
    cross.className = 'st-cross';
    cross.style.left = (S.stPt.x * U.stCanvas.width) + 'px';
    cross.style.top = (S.stPt.y * U.stCanvas.height) + 'px';
    U.stOverlay.appendChild(cross);
  }

  async function renderStampPage() {
    const token = ++S.stRenderToken;
    let page = null;
    if (S.stRenderTask) {
      try { S.stRenderTask.cancel(); } catch {}
      S.stRenderTask = null;
    }
    if (!S.stDoc) {
      U.stPage.textContent = '- / -';
      if (U.stOverlay) U.stOverlay.replaceChildren();
      return;
    }

    U.stPage.textContent = S.stPage + ' / ' + S.stDoc.numPages;
    if (U.stPageInput) { U.stPageInput.max = String(S.stDoc.numPages); U.stPageInput.value = String(S.stPage); }
    try {
      page = await S.stDoc.getPage(S.stPage);
      if (token !== S.stRenderToken) return;
      const v = page.getViewport({scale: 1.35});
      assertCanvasBudget(v.width, v.height, 'スタンププレビュー');
      const c = U.stCanvas;
      const x = c.getContext('2d');
      c.width = Math.max(1, Math.floor(v.width));
      c.height = Math.max(1, Math.floor(v.height));
      const task = page.render({canvasContext: x, viewport: v, background: 'white'});
      S.stRenderTask = task;
      await task.promise;
      if (token !== S.stRenderToken) return;
      renderStampOverlay();
    } catch (e) {
      const name = String(e?.name || '');
      const message = String(e?.message || '');
      if (name === 'RenderingCancelledException' || /cancel/i.test(message)) return;
      console.error(e);
      msg(U.stMsg, 'プレビュー失敗: ' + (e?.message || e));
    }finally{
      if (page && typeof page.cleanup === 'function') try { page.cleanup(); } catch {}
      if (token === S.stRenderToken) S.stRenderTask = null;
    }
  }

  function jumpStampPage() {
    if (!S.stDoc || !U.stPageInput) return;
    const n = parseInt(U.stPageInput.value, 10);
    if (!Number.isFinite(n)) return;
    S.stPage = clamp(n, 1, S.stDoc.numPages);
    void renderStampPage();
  }

  function addTextStamp(text, color, size, opacity) {
    if (!S.stFileId) return;
    const arr = S.stampsByFile[S.stFileId] || [];
    arr.push({
      id: uid(), kind: 'text', page: S.stPage,
      text: String(text || ''), color: color || '#d00000', size: Math.max(6, Number(size) || 24),
      opacity: clamp(Number(opacity) || 1, 0.05, 1),
      xRatio: S.stPt.x, yRatio: S.stPt.y, rotation: 0
    });
    S.stampsByFile[S.stFileId] = arr;
    renderStampList();
    renderStampOverlay();
  }

  function addMaskStamp() {
    if (!S.stFileId || !U.stCanvas.width || !U.stCanvas.height) return;
    const wPx = Math.max(10, Number(U.stMaskW.value) || 150);
    const hPx = Math.max(10, Number(U.stMaskH.value) || 50);
    const wr = clamp(wPx / U.stCanvas.width, 0.01, 1);
    const hr = clamp(hPx / U.stCanvas.height, 0.01, 1);
    const arr = S.stampsByFile[S.stFileId] || [];

    arr.push({
      id: uid(), kind: 'mask', page: S.stPage,
      color: '#ffffff', opacity: clamp(Number(U.stMaskOp.value) || 1, 0.05, 1),
      xRatio: S.stPt.x, yRatio: S.stPt.y, widthRatio: wr, heightRatio: hr
    });

    S.stampsByFile[S.stFileId] = arr;
    renderStampList();
    renderStampOverlay();
  }

  async function stampPayloadForSave() {
    const source = getStamps();
    const payload = source.map(s => ({...s}));
    if (!S.stDoc) return payload;
    const pages = new Map();
    try {
      for (const stamp of payload) {
        if (stamp.kind !== 'mask') continue;
        const pageNo = clamp(Math.trunc(Number(stamp.page) || 1), 1, S.stDoc.numPages);
        let page = pages.get(pageNo);
        if (!page) {
          page = await S.stDoc.getPage(pageNo);
          pages.set(pageNo, page);
        }
        const viewport = page.getViewport({scale: 1});
        const left = clamp(Number(stamp.xRatio) || 0, 0, 1) * viewport.width;
        const top = clamp(Number(stamp.yRatio) || 0, 0, 1) * viewport.height;
        const right = clamp((Number(stamp.xRatio) || 0) + (Number(stamp.widthRatio) || 0.2), 0, 1) * viewport.width;
        const bottom = clamp((Number(stamp.yRatio) || 0) + (Number(stamp.heightRatio) || 0.08), 0, 1) * viewport.height;
        const a = viewport.convertToPdfPoint(left, top);
        const b = viewport.convertToPdfPoint(right, bottom);
        stamp.pdfRect = {x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1])};
      }
    } finally {
      for (const page of pages.values()) if (typeof page.cleanup === 'function') try { page.cleanup(); } catch {}
    }
    return payload;
  }

  async function applySt() {
    if (!S.stFileId || !S.stBytes) { msg(U.stMsg, '先にPDFを読み込んでください'); return; }
    const arr = getStamps();
    if (!arr.length) { msg(U.stMsg, 'スタンプがありません'); return; }

    U.stApply.disabled = true;
    prog(U.stProg, U.stFill, true, 0);
    msg(U.stMsg, '保存処理中...');

    try {
      const pdfData = S.stBytes.slice(0);
      const stamps = await stampPayloadForSave();
      const out = await WK.call('st', {pdfData, stamps}, {
        transfer: [pdfData],
        onP: (pc, m) => { prog(U.stProg, U.stFill, true, pc); msg(U.stMsg, '処理中 ' + pc + '% ' + (m || '')); }
      });

      const m = S.meta.find(f => f.id === S.stFileId);
      dl(new Blob([out], {type: 'application/pdf'}), (m ? base(m.name) : 'stamped') + '_stamped.pdf');
      msg(U.stMsg, '保存完了');
    } catch (e) {
      console.error(e);
      msg(U.stMsg, 'エラー: ' + (e?.message || e));
    } finally {
      U.stApply.disabled = false;
      prog(U.stProg, U.stFill, false, 0);
    }
  }

  return {
    renderStampSelect,
    loadStamp,
    getStamps,
    renderStPoint,
    renderStampList,
    removeStamp,
    attachMove,
    attachMaskResize,
    renderStampOverlay,
    renderStampPage,
    jumpStampPage,
    addTextStamp,
    addMaskStamp,
    stampPayloadForSave,
    applySt
  };
}
