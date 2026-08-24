import { U } from '../core/dom.js';
import { S } from '../core/state.js';
import {
  assertCanvasBudget,
  canvasToBlobSafe,
  clamp,
  msg,
  pdfLoadParams,
  prog
} from '../core/utils.js';

export function createRasterTools({
  buildWsPdfBuffer,
  replaceSelectionWithGeneratedPdf,
  setWsExportBusy
}) {
  function getRasterSelectedRows() {
    return S.entries.map((e, idx) => ({e, idx})).filter(x => x.e.selected).sort((a, b) => a.idx - b.idx);
  }

  function getRasterOptions() {
    let white = clamp(parseInt(U.rsWhite?.value, 10) || 180, 0, 255);
    const black = clamp(parseInt(U.rsBlack?.value, 10) || 80, 0, 255);
    if (white <= black) white = Math.min(255, black + 1);
    if (U.rsWhite) U.rsWhite.value = String(white);
    if (U.rsBlack) U.rsBlack.value = String(black);
    return {
      compress: !!U.rsCompress?.checked,
      scale: clamp(Number(U.rsScale?.value) || 1, 0.5, 2.0),
      quality: clamp(Number(U.rsQuality?.value) || 0.82, 0.3, 1),
      gray: !!U.rsGray?.checked,
      whiten: !!U.rsWhiten?.checked,
      white,
      black
    };
  }

  function renderRasterSelectionInfo() {
    if (!U.rsTargetInfo) return;
    const total = S.entries.length;
    const sel = S.entries.filter(e => e.selected).length;
    U.rsTargetInfo.textContent = '選択ページ: ' + sel + ' / 総ページ: ' + total;
    if (U.rsRun) U.rsRun.disabled = sel === 0;
  }

  function applyRasterPixelFilters(ctx, w, h, opt) {
    if (!opt.gray && !opt.whiten) return;
    const idt = ctx.getImageData(0, 0, w, h);
    const d = idt.data;
    const rv = Math.max(opt.white - opt.black, 1);
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i], g = d[i + 1], b = d[i + 2];
      if (opt.whiten) {
        r = clamp(((r - opt.black) / rv) * 255, 0, 255);
        g = clamp(((g - opt.black) / rv) * 255, 0, 255);
        b = clamp(((b - opt.black) / rv) * 255, 0, 255);
      }
      if (opt.gray) {
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
        r = l; g = l; b = l;
      }
      d[i] = r; d[i + 1] = g; d[i + 2] = b;
    }
    ctx.putImageData(idt, 0, 0);
  }

  function clearRasterPreviewCanvas(note = '') {
    if (U.rsPrevSrc) { U.rsPrevSrc.width = 0; U.rsPrevSrc.height = 0; }
    if (U.rsPrevOut) { U.rsPrevOut.width = 0; U.rsPrevOut.height = 0; }
    if (U.rsPrevMsg) msg(U.rsPrevMsg, note || '');
  }

  function scheduleRasterPreview(delay = 220) {
    if (!U.panels?.rs?.classList.contains('active')) return;
    if (S.rsPrevTimer) clearTimeout(S.rsPrevTimer);
    S.rsPrevTimer = setTimeout(() => { void renderRasterPreview(); }, Math.max(50, Number(delay) || 220));
  }

  async function renderRasterPreview() {
    if (!U.rsPrevSrc || !U.rsPrevOut || !U.rsPrevMsg) return;
    if (!U.panels?.rs?.classList.contains('active')) return;

    const rows = getRasterSelectedRows();
    if (!rows.length) {
      clearRasterPreviewCanvas('プレビュー対象がありません（ページを選択してください）');
      return;
    }

    const token = ++S.rsPrevToken;
    S.rsPrevBusy = true;
    if (U.rsPrevRefresh) U.rsPrevRefresh.disabled = true;
    msg(U.rsPrevMsg, 'プレビュー生成中...');

    let doc = null;
    try {
      const sample = rows[0].e;
      const opt = getRasterOptions();
      const wsOut = await buildWsPdfBuffer([sample], (pc) => {
        if (token !== S.rsPrevToken) return;
        msg(U.rsPrevMsg, 'プレビュー前処理 ' + pc + '%');
      });

      if (token !== S.rsPrevToken) return;
      doc = await pdfjsLib.getDocument(pdfLoadParams(wsOut)).promise;
      const p = await doc.getPage(1);
      const vp1 = p.getViewport({scale: 1});
      const maxEdge = 860;
      const fitScale = Math.min(1.45, Math.max(0.6, maxEdge / Math.max(vp1.width, vp1.height)));
      const vp = p.getViewport({scale: fitScale});
      assertCanvasBudget(vp.width, vp.height, '最適化プレビュー');

      const src = U.rsPrevSrc;
      const out = U.rsPrevOut;
      src.width = Math.max(1, Math.floor(vp.width));
      src.height = Math.max(1, Math.floor(vp.height));
      out.width = src.width;
      out.height = src.height;

      const sctx = src.getContext('2d', {willReadFrequently: true});
      const octx = out.getContext('2d', {willReadFrequently: true});
      await p.render({canvasContext: sctx, viewport: vp, background: 'white'}).promise;

      octx.clearRect(0, 0, out.width, out.height);
      octx.drawImage(src, 0, 0, out.width, out.height);
      applyRasterPixelFilters(octx, out.width, out.height, opt);

      if (opt.compress) {
        const jpg = await canvasToBlobSafe(out, 'image/jpeg', opt.quality);
        const url = URL.createObjectURL(jpg);
        try {
          const img = new Image();
          img.src = url;
          await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
          octx.clearRect(0, 0, out.width, out.height);
          octx.drawImage(img, 0, 0, out.width, out.height);
        } finally { URL.revokeObjectURL(url); }
      }

      if (typeof p.cleanup === 'function') try { p.cleanup(); } catch {}
      msg(U.rsPrevMsg, 'プレビュー対象: ' + sample.fileName + ' / P' + (sample.pageIndex + 1));
    } catch (e) {
      console.error(e);
      msg(U.rsPrevMsg, 'プレビュー失敗: ' + (e?.message || e));
    } finally {
      if (doc) try { await doc.destroy(); } catch {}
      if (token === S.rsPrevToken) {
        S.rsPrevBusy = false;
        if (U.rsPrevRefresh) U.rsPrevRefresh.disabled = false;
      }
    }
  }

  async function runRasterOptimizeSelected() {
    const selectedRows = getRasterSelectedRows();
    if (!selectedRows.length) { msg(U.rsMsg, '対象ページを選択してください'); renderRasterSelectionInfo(); return; }

    const opt = getRasterOptions();
    setWsExportBusy(true);
    if (U.rsRun) U.rsRun.disabled = true;
    prog(U.rsProg, U.rsFill, true, 0);
    msg(U.rsMsg, '最適化前処理を開始...');
    msg(U.wsMsg, '最適化処理中...');

    let srcDoc = null;
    try {
      const target = selectedRows.map(x => x.e);
      const wsOut = await buildWsPdfBuffer(target, (pc, m) => {
        const p = Math.round(pc * 0.35);
        prog(U.rsProg, U.rsFill, true, p);
        msg(U.rsMsg, '前処理 ' + pc + '% ' + (m || ''));
      });

      srcDoc = await pdfjsLib.getDocument(pdfLoadParams(wsOut)).promise;
      const total = srcDoc.numPages;
      if (total < 1) throw new Error('最適化対象ページがありません');

      const outDoc = await PDFLib.PDFDocument.create();

      for (let i = 1; i <= total; i++) {
        const p = await srcDoc.getPage(i);
        const baseVp = p.getViewport({scale: 1});
        const renderScale = opt.compress ? opt.scale : 1;
        const renderVp = p.getViewport({scale: renderScale});
        assertCanvasBudget(renderVp.width, renderVp.height, '圧縮／漂白');
        const cvs = document.createElement('canvas');
        const ctx = cvs.getContext('2d', {willReadFrequently: true});
        cvs.width = Math.max(1, Math.floor(renderVp.width));
        cvs.height = Math.max(1, Math.floor(renderVp.height));

        await p.render({canvasContext: ctx, viewport: renderVp, background: 'white'}).promise;
        applyRasterPixelFilters(ctx, cvs.width, cvs.height, opt);

        let emb;
        if (opt.compress) {
          const jpgBlob = await canvasToBlobSafe(cvs, 'image/jpeg', opt.quality);
          emb = await outDoc.embedJpg(await jpgBlob.arrayBuffer());
        } else {
          const pngBlob = await canvasToBlobSafe(cvs, 'image/png');
          emb = await outDoc.embedPng(await pngBlob.arrayBuffer());
        }

        const np = outDoc.addPage([baseVp.width, baseVp.height]);
        np.drawImage(emb, {x: 0, y: 0, width: baseVp.width, height: baseVp.height});

        try { ctx.clearRect(0, 0, cvs.width, cvs.height); } catch {}
        cvs.width = 0; cvs.height = 0;
        if (typeof p.cleanup === 'function') try { p.cleanup(); } catch {}

        const pc = 35 + Math.round((i / total) * 60);
        prog(U.rsProg, U.rsFill, true, pc);
        msg(U.rsMsg, i + '/' + total + ' ページ最適化中...');
        await new Promise(res => setTimeout(res, 0));
      }

      prog(U.rsProg, U.rsFill, true, 98);
      msg(U.rsMsg, '差し替えデータを保存中...');
      const out = await outDoc.save();
      await replaceSelectionWithGeneratedPdf(selectedRows, out, 'optimized');

      prog(U.rsProg, U.rsFill, true, 100);
      msg(U.rsMsg, '選択ページを最適化して差し替えました');
      msg(U.wsMsg, '最適化して差し替え完了');
    } catch (e) {
      console.error(e);
      msg(U.rsMsg, 'エラー: ' + (e?.message || e));
      msg(U.wsMsg, '');
    } finally {
      if (srcDoc) try { await srcDoc.destroy(); } catch {}
      prog(U.rsProg, U.rsFill, false, 0);
      setWsExportBusy(false);
      renderRasterSelectionInfo();
    }
  }

  return {
    getRasterSelectedRows,
    getRasterOptions,
    renderRasterSelectionInfo,
    applyRasterPixelFilters,
    clearRasterPreviewCanvas,
    scheduleRasterPreview,
    renderRasterPreview,
    runRasterOptimizeSelected
  };
}
