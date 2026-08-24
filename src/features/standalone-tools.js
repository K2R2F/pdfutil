import { U } from '../core/dom.js';
import { C } from '../core/state.js';
import { LIMITS } from '../core/constants.js';
import {
  assertCanvasBudget,
  base,
  canvasToBlobSafe,
  clamp,
  dl,
  fmt,
  msg,
  pdfLoadParams,
  prog,
  resolvePageRange
} from '../core/utils.js';
import { loadExternalScript } from '../services/external-libraries.js';

async function ensureTesseractLib() {
  await loadExternalScript('tesseract', [
    {url: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js', integrity: 'sha384-GJqSu7vueQ9qN0E9yLPb3Wtpd7OrgK8KmYzC8T1IysG1bcvxvIO4qtYR/D3A991F'},
    {url: 'https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js', integrity: 'sha384-GJqSu7vueQ9qN0E9yLPb3Wtpd7OrgK8KmYzC8T1IysG1bcvxvIO4qtYR/D3A991F'}
  ], () => typeof Tesseract !== 'undefined');
}

function ocrStartupStatusText(event) {
  const labels = {
    'loading tesseract core': 'OCR本体を読込中',
    'loaded tesseract core': 'OCR本体を読み込みました',
    'initializing tesseract': 'OCR本体を初期化中',
    'initialized tesseract': 'OCR本体を初期化しました',
    'loading language traineddata': '言語データを読込中',
    'loading language trained data': '言語データを読込中',
    'loaded language traineddata': '言語データを読み込みました',
    'loaded language trained data': '言語データを読み込みました',
    'initializing api': '認識APIを初期化中',
    'initialized api': '認識APIを初期化しました',
    'OCR worker connection pending': 'OCR Workerの応答待ち'
  };
  const raw = String(event?.status || 'OCRエンジン起動中');
  const label = labels[raw] || raw;
  const progress = Number(event?.progress);
  const suffix = Number.isFinite(progress) && progress > 0 && progress < 1 ? ' ' + Math.round(progress * 100) + '%' : '';
  const elapsed = Number(event?.elapsed);
  return label + suffix + (Number.isFinite(elapsed) && elapsed >= 10 ? '（' + Math.round(elapsed) + '秒経過）' : '');
}

async function createTesseractWorkerSafe(lang, logger, isCancelled) {
  const workerConfigs = [
    {workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js', corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1', langPath: 'https://tessdata.projectnaptha.com/4.0.0'},
    {workerPath: 'https://unpkg.com/tesseract.js@5.1.1/dist/worker.min.js', corePath: 'https://unpkg.com/tesseract.js-core@5.1.1', langPath: 'https://tessdata.projectnaptha.com/4.0.0'}
  ];
  let lastErr = null;
  for (let index = 0; index < workerConfigs.length; index++) {
    const cfg = workerConfigs[index];
    let workerPromise = null;
    let timedOut = false;
    let timeoutId = 0;
    let cancelId = 0;
    let heartbeatId = 0;
    let active = true;
    const startedAt = Date.now();
    let lastStatusAt = startedAt;
    const relay = (event) => {
      if (!active) return;
      lastStatusAt = Date.now();
      if (typeof logger === 'function') logger(event || {});
    };
    try {
      if (index > 0) relay({status: 'OCR配信元を切り替えて再試行中'});
      workerPromise = Tesseract.createWorker(lang, 1, {logger: relay, ...cfg});
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          reject(new Error('OCRエンジンの起動が90秒以内に完了しませんでした'));
        }, 90000);
      });
      const cancelPromise = new Promise((_, reject) => {
        cancelId = setInterval(() => {
          if (isCancelled?.()) reject(new Error('OCR処理を中止しました'));
        }, 250);
      });
      heartbeatId = setInterval(() => {
        if (Date.now() - lastStatusAt >= 8000) relay({status: 'OCR worker connection pending', elapsed: (Date.now() - startedAt) / 1000});
      }, 2000);
      const worker = await Promise.race([workerPromise, timeoutPromise, cancelPromise]);
      if (isCancelled?.()) {
        try { await worker.terminate(); } catch {}
        throw new Error('OCR処理を中止しました');
      }
      return worker;
    } catch (e) {
      lastErr = e;
      if ((timedOut || isCancelled?.()) && workerPromise) {
        workerPromise.then(worker => worker?.terminate?.()).catch(() => {});
      }
      if (isCancelled?.()) throw new Error('OCR処理を中止しました');
    } finally {
      active = false;
      if (timeoutId) clearTimeout(timeoutId);
      if (cancelId) clearInterval(cancelId);
      if (heartbeatId) clearInterval(heartbeatId);
    }
  }
  throw new Error('OCRエンジン(Worker)の読み込みに失敗しました。ネットワークまたはCDN制限の可能性があります。' + (lastErr?.message ? (' 詳細: ' + lastErr.message) : ''));
}

async function ensureQRiousLib() {
  await loadExternalScript('qrious', [
    {url: 'https://cdnjs.cloudflare.com/ajax/libs/qrious/4.0.2/qrious.min.js', integrity: 'sha384-Dr98ddmUw2QkdCarNQ+OL7xLty7cSxgR0T7v1tq4UErS/qLV0132sBYTolRAFuOV'},
    {url: 'https://cdn.jsdelivr.net/npm/qrious@4.0.2/dist/qrious.min.js', integrity: 'sha384-Dr98ddmUw2QkdCarNQ+OL7xLty7cSxgR0T7v1tq4UErS/qLV0132sBYTolRAFuOV'},
    {url: 'https://unpkg.com/qrious@4.0.2/dist/qrious.min.js', integrity: 'sha384-Dr98ddmUw2QkdCarNQ+OL7xLty7cSxgR0T7v1tq4UErS/qLV0132sBYTolRAFuOV'}
  ], () => typeof QRious !== 'undefined');
}

async function getSearchableFont(doc, lang) {
  const { StandardFonts } = PDFLib;
  if (lang !== 'jpn') return await doc.embedFont(StandardFonts.Helvetica);
  if (typeof fontkit === 'undefined' || !doc.registerFontkit) {
    throw new Error('日本語の検索可能PDFにはフォントライブラリが必要です。ネットワークまたはスクリプト遮断を確認してください。');
  }
  doc.registerFontkit(fontkit);
  if (!C.fontBuf) {
    const fontUrls = [
      'https://cdn.jsdelivr.net/npm/typeface-mplus-1p@0.1.63/fonts/mplus-1p-regular.ttf'
    ];
    let lastErr = null;
    for (const url of fontUrls) {
      try {
        const res = await fetch(url, {mode: 'cors'});
        if (!res.ok) throw new Error('HTTP ' + res.status);
        C.fontBuf = await res.arrayBuffer();
        break;
      } catch (e) { lastErr = e; }
    }
    if (!C.fontBuf) throw new Error('日本語フォントを取得できませんでした。通信状態を確認して再実行してください。' + (lastErr?.message ? (' 詳細: ' + lastErr.message) : ''));
  }
  return await doc.embedFont(C.fontBuf, {subset: true});
}

function ensureCPageLimit(count, label) {
  if (count > 30) throw new Error(label + 'は30ページ以内で実行してください');
  if (count > 10) {
    const ok = confirm(label + 'は' + count + 'ページです。時間がかかる可能性があります。続行しますか？');
    if (!ok) throw new Error('ユーザーがキャンセルしました');
  }
}

export function createStandaloneTools({ classifyUploadFile } = {}) {
  if (typeof classifyUploadFile !== 'function') {
    throw new Error('classifyUploadFile is required');
  }

  function bindStandalonePdfDrop(drop, input, onPick) {
    if (!drop || !input || typeof onPick !== 'function') return;
    const pick = (file) => {
      if (!file || classifyUploadFile(file)?.kind !== 'pdf') {
        onPick(null);
        return;
      }
      onPick(file);
    };
    drop.addEventListener('click', () => input.click());
    drop.addEventListener('dragover', e => {
      e.preventDefault();
      drop.classList.add('drag');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
    drop.addEventListener('drop', e => {
      e.preventDefault();
      drop.classList.remove('drag');
      pick((e.dataTransfer?.files || [])[0] || null);
    });
    input.addEventListener('change', e => {
      pick((e.target.files || [])[0] || null);
      e.target.value = '';
    });
  }

  function pickOcrFile(file) {
    const isPdf = classifyUploadFile(file)?.kind === 'pdf';
    const tooLarge = isPdf && file.size > LIMITS.maxFileBytes;
    C.ocrFile = (isPdf && !tooLarge) ? file : null;
    C.ocrText = '';
    if (U.ocrOut) U.ocrOut.value = '';
    if (U.ocrDl) U.ocrDl.disabled = true;
    if (U.ocrRun) U.ocrRun.disabled = !C.ocrFile;
    if (U.ocrCancel) U.ocrCancel.disabled = true;
    msg(U.ocrInfo, C.ocrFile
      ? ('選択中: ' + C.ocrFile.name + ' / ' + fmt(C.ocrFile.size))
      : (tooLarge ? 'PDFは' + Math.round(LIMITS.maxFileBytes / 1048576) + 'MB以内にしてください' : 'PDFを選択してください'));
    msg(U.ocrMsg, '');
    prog(U.ocrProg, U.ocrFill, false, 0);
  }

  async function cancelOcrStandalone(silent = false) {
    C.ocrAbort = true;
    if (U.ocrCancel) U.ocrCancel.disabled = true;
    if (!silent) msg(U.ocrMsg, '中止処理中...');
    if (C.ocrWorker) {
      try { await C.ocrWorker.terminate(); } catch {}
      C.ocrWorker = null;
    }
  }

  function downloadOcrText() {
    if (!C.ocrText) return;
    const name = base(C.ocrFile?.name || 'ocr') + '_ocr.txt';
    dl(new Blob([C.ocrText], {type: 'text/plain;charset=utf-8'}), name);
  }

  async function runOcrStandalone() {
    if (!C.ocrFile) {
      msg(U.ocrMsg, 'PDFを選択してください');
      return;
    }

    let jsDoc = null;
    C.ocrAbort = false;
    C.ocrText = '';
    if (U.ocrOut) U.ocrOut.value = '';
    U.ocrRun.disabled = true;
    U.ocrCancel.disabled = false;
    U.ocrDl.disabled = true;
    prog(U.ocrProg, U.ocrFill, true, 0);

    try {
      msg(U.ocrMsg, 'OCRライブラリ読込中...');
      await ensureTesseractLib();

      const bytes = await C.ocrFile.arrayBuffer();
      jsDoc = await pdfjsLib.getDocument(pdfLoadParams(bytes)).promise;
      const range = resolvePageRange(jsDoc.numPages, U.ocrStart?.value, U.ocrEnd?.value);
      ensureCPageLimit(range.count, 'OCR抽出');

      const lang = (U.ocrLang?.value === 'eng') ? 'eng' : 'jpn';
      const scale = clamp(Number(U.ocrScale?.value) || 2.0, 1.0, 3.0);
      let done = 0;

      msg(U.ocrMsg, 'OCRエンジン起動中...');
      C.ocrWorker = await createTesseractWorkerSafe(lang, (l) => {
        if (C.ocrAbort) return;
        if (l.status === 'recognizing text') {
          const startPc = (done / range.count) * 100;
          const perPc = (1 / range.count) * 100;
          prog(U.ocrProg, U.ocrFill, true, Math.min(99, startPc + (Number(l.progress) || 0) * perPc));
        } else {
          msg(U.ocrMsg, ocrStartupStatusText(l));
          prog(U.ocrProg, U.ocrFill, true, Math.min(8, Math.max(1, (Number(l.progress) || 0) * 8)));
        }
      }, () => C.ocrAbort);

      let txt = '';
      for (let pNo = range.start; pNo <= range.end; pNo++) {
        if (C.ocrAbort) throw new Error('OCR抽出を中止しました');
        msg(U.ocrMsg, (done + 1) + '/' + range.count + ' ページ抽出中...');

        const p = await jsDoc.getPage(pNo);
        const vp = p.getViewport({scale});
        assertCanvasBudget(vp.width, vp.height, 'OCR抽出');
        const c = document.createElement('canvas');
        const x = c.getContext('2d', {willReadFrequently: true});
        c.width = Math.max(1, Math.floor(vp.width));
        c.height = Math.max(1, Math.floor(vp.height));
        await p.render({canvasContext: x, viewport: vp, background: 'white'}).promise;

        const {data} = await C.ocrWorker.recognize(c.toDataURL('image/jpeg', 0.92));
        txt += '--- Page ' + pNo + ' ---\n' + (data?.text || '') + '\n\n';

        done++;
        prog(U.ocrProg, U.ocrFill, true, Math.round((done / range.count) * 100));
        try { x.clearRect(0, 0, c.width, c.height); } catch {}
        c.width = 1;
        c.height = 1;
        if (typeof p.cleanup === 'function') try { p.cleanup(); } catch {}
        await new Promise(r => setTimeout(r, 0));
      }

      C.ocrText = txt;
      U.ocrOut.value = txt;
      U.ocrDl.disabled = !txt.trim();
      msg(U.ocrMsg, 'OCR抽出が完了しました');
    } catch (e) {
      if (C.ocrAbort) {
        msg(U.ocrMsg, 'OCR抽出を中止しました');
      } else {
        console.error(e);
        msg(U.ocrMsg, 'エラー: ' + (e?.message || e));
      }
    } finally {
      if (C.ocrWorker) {
        try { await C.ocrWorker.terminate(); } catch {}
        C.ocrWorker = null;
      }
      if (jsDoc) try { await jsDoc.destroy(); } catch {}
      prog(U.ocrProg, U.ocrFill, false, 0);
      U.ocrCancel.disabled = true;
      U.ocrRun.disabled = !C.ocrFile;
      C.ocrAbort = false;
    }
  }

  function pickSearchableFile(file) {
    const isPdf = classifyUploadFile(file)?.kind === 'pdf';
    const tooLarge = isPdf && file.size > LIMITS.maxFileBytes;
    C.srcFile = (isPdf && !tooLarge) ? file : null;
    C.srcBytes = null;
    C.srcName = '';
    if (U.srcDl) U.srcDl.disabled = true;
    if (U.srcRun) U.srcRun.disabled = !C.srcFile;
    if (U.srcCancel) U.srcCancel.disabled = true;
    msg(U.srcInfo, C.srcFile
      ? ('選択中: ' + C.srcFile.name + ' / ' + fmt(C.srcFile.size))
      : (tooLarge ? 'PDFは' + Math.round(LIMITS.maxFileBytes / 1048576) + 'MB以内にしてください' : 'PDFを選択してください'));
    msg(U.srcMsg, '');
    prog(U.srcProg, U.srcFill, false, 0);
  }

  async function cancelSearchableStandalone(silent = false) {
    C.srcAbort = true;
    if (U.srcCancel) U.srcCancel.disabled = true;
    if (!silent) msg(U.srcMsg, '中止処理中...');
    if (C.srcWorker) {
      try { await C.srcWorker.terminate(); } catch {}
      C.srcWorker = null;
    }
  }

  function downloadSearchablePdf() {
    if (!C.srcBytes) return;
    const out = C.srcBytes instanceof Uint8Array ? C.srcBytes : new Uint8Array(C.srcBytes);
    dl(new Blob([out], {type: 'application/pdf'}), C.srcName || 'searchable.pdf');
  }

  async function runSearchableStandalone() {
    if (!C.srcFile) {
      msg(U.srcMsg, 'PDFを選択してください');
      return;
    }

    let jsDoc = null;
    C.srcAbort = false;
    C.srcBytes = null;
    C.srcName = '';
    U.srcRun.disabled = true;
    U.srcCancel.disabled = false;
    U.srcDl.disabled = true;
    prog(U.srcProg, U.srcFill, true, 0);

    try {
      msg(U.srcMsg, 'OCRライブラリ読込中...');
      await ensureTesseractLib();

      const bytes = await C.srcFile.arrayBuffer();
      jsDoc = await pdfjsLib.getDocument(pdfLoadParams(bytes)).promise;
      const range = resolvePageRange(jsDoc.numPages, U.srcStart?.value, U.srcEnd?.value);
      ensureCPageLimit(range.count, '検索可能化');

      const lang = (U.srcLang?.value === 'eng') ? 'eng' : 'jpn';
      const scale = clamp(Number(U.srcScale?.value) || 2.0, 1.0, 3.0);
      const quality = clamp(Number(U.srcQuality?.value) || 0.85, 0.5, 1.0);
      const { PDFDocument, rgb } = PDFLib;
      const outDoc = await PDFDocument.create();
      const font = await getSearchableFont(outDoc, lang);

      let done = 0;
      msg(U.srcMsg, 'OCRエンジン起動中...');
      C.srcWorker = await createTesseractWorkerSafe(lang, (l) => {
        if (C.srcAbort) return;
        if (l.status === 'recognizing text') {
          const startPc = (done / range.count) * 100;
          const perPc = (1 / range.count) * 100;
          prog(U.srcProg, U.srcFill, true, Math.min(99, startPc + (Number(l.progress) || 0) * perPc));
        } else {
          msg(U.srcMsg, ocrStartupStatusText(l));
          prog(U.srcProg, U.srcFill, true, Math.min(8, Math.max(1, (Number(l.progress) || 0) * 8)));
        }
      }, () => C.srcAbort);
      let textTokenCount = 0;
      let embeddedTextTokenCount = 0;
      let skippedTextTokenCount = 0;
      let firstTextEmbedError = '';

      for (let pNo = range.start; pNo <= range.end; pNo++) {
        if (C.srcAbort) throw new Error('検索可能化を中止しました');
        msg(U.srcMsg, (done + 1) + '/' + range.count + ' ページ処理中...');

        const p = await jsDoc.getPage(pNo);
        const vp = p.getViewport({scale});
        assertCanvasBudget(vp.width, vp.height, '検索可能化');
        const c = document.createElement('canvas');
        const x = c.getContext('2d', {willReadFrequently: true});
        c.width = Math.max(1, Math.floor(vp.width));
        c.height = Math.max(1, Math.floor(vp.height));
        await p.render({canvasContext: x, viewport: vp, background: 'white'}).promise;

        const {data} = await C.srcWorker.recognize(c.toDataURL('image/jpeg', 0.92));
        const np = outDoc.addPage([c.width, c.height]);
        const jpg = await outDoc.embedJpg(c.toDataURL('image/jpeg', quality));
        np.drawImage(jpg, {x: 0, y: 0, width: c.width, height: c.height});

        const drawToken = (txt, bbox) => {
          const t = String(txt || '').trim();
          if (!t || !bbox) return;
          textTokenCount++;
          const x0 = Number(bbox.x0) || 0;
          const y0 = Number(bbox.y0) || 0;
          const y1 = Number(bbox.y1) || 0;
          const size = Math.max((y1 - y0) * 0.82, 1);
          try {
            np.drawText(t, {x: x0, y: c.height - y1, size, font, color: rgb(0, 0, 0), opacity: 0});
            embeddedTextTokenCount++;
          } catch (e) {
            skippedTextTokenCount++;
            if (!firstTextEmbedError) firstTextEmbedError = String(e?.message || e);
          }
        };

        if (Array.isArray(data?.words)) {
          for (const w of data.words) {
            if (Array.isArray(w?.symbols) && w.symbols.length) {
              for (const s of w.symbols) { drawToken(s?.text, s?.bbox); }
            } else {
              drawToken(w?.text, w?.bbox);
            }
          }
        } else if (String(data?.text || '').trim()) {
          throw new Error('OCRの位置情報を取得できませんでした。OCRライブラリを再読み込みして再実行してください。');
        }

        done++;
        prog(U.srcProg, U.srcFill, true, Math.round((done / range.count) * 100));
        try { x.clearRect(0, 0, c.width, c.height); } catch {}
        c.width = 1;
        c.height = 1;
        if (typeof p.cleanup === 'function') try { p.cleanup(); } catch {}
        await new Promise(r => setTimeout(r, 0));
      }

      if (textTokenCount > 0 && embeddedTextTokenCount === 0) {
        throw new Error('検索テキストをPDFへ埋め込めませんでした。' + (firstTextEmbedError ? (' 詳細: ' + firstTextEmbedError) : ''));
      }
      C.srcBytes = await outDoc.save();
      C.srcName = base(C.srcFile.name) + '_searchable.pdf';
      U.srcDl.disabled = false;
      msg(U.srcMsg, skippedTextTokenCount
        ? '検索可能PDFを生成しました（埋め込めなかった文字: ' + skippedTextTokenCount + '件）'
        : '検索可能PDFの生成が完了しました');
    } catch (e) {
      if (C.srcAbort) {
        msg(U.srcMsg, '検索可能化を中止しました');
      } else {
        console.error(e);
        msg(U.srcMsg, 'エラー: ' + (e?.message || e));
      }
    } finally {
      if (C.srcWorker) {
        try { await C.srcWorker.terminate(); } catch {}
        C.srcWorker = null;
      }
      if (jsDoc) try { await jsDoc.destroy(); } catch {}
      prog(U.srcProg, U.srcFill, false, 0);
      U.srcCancel.disabled = true;
      U.srcRun.disabled = !C.srcFile;
      C.srcAbort = false;
    }
  }

  async function runQrStandalone() {
    const text = String(U.qrText?.value || '').trim();
    if (!text) {
      msg(U.qrMsg, 'テキスト / URL を入力してください');
      return;
    }

    U.qrRun.disabled = true;
    msg(U.qrMsg, 'QRライブラリ読込中...');

    try {
      await ensureQRiousLib();
      const size = Math.round(clamp(Number(U.qrSize?.value) || 320, 80, 2000));
      U.qrSize.value = String(size);
      const level = (['L', 'M', 'Q', 'H'].includes(U.qrLevel?.value) ? U.qrLevel.value : 'H');
      new QRious({
        element: U.qrCanvas,
        value: text,
        size,
        level,
        foreground: U.qrFg?.value || '#111111',
        background: U.qrBg?.value || '#ffffff'
      });
      U.qrDl.disabled = false;
      msg(U.qrMsg, 'QRを生成しました');
    } catch (e) {
      console.error(e);
      msg(U.qrMsg, 'エラー: ' + (e?.message || e));
    } finally {
      U.qrRun.disabled = false;
    }
  }

  async function downloadQrImage() {
    if (U.qrDl?.disabled) return;
    try {
      const blob = await canvasToBlobSafe(U.qrCanvas, 'image/png');
      dl(blob, 'qr_' + Date.now() + '.png');
    } catch (e) {
      console.error(e);
      msg(U.qrMsg, 'ダウンロードに失敗しました: ' + (e?.message || e));
    }
  }

  function bind() {
    bindStandalonePdfDrop(U.ocrDrop, U.ocrInput, pickOcrFile);
    bindStandalonePdfDrop(U.srcDrop, U.srcInput, pickSearchableFile);

    U.ocrRun?.addEventListener('click', () => void runOcrStandalone());
    U.ocrCancel?.addEventListener('click', () => void cancelOcrStandalone());
    U.ocrDl?.addEventListener('click', downloadOcrText);

    U.srcRun?.addEventListener('click', () => void runSearchableStandalone());
    U.srcCancel?.addEventListener('click', () => void cancelSearchableStandalone());
    U.srcDl?.addEventListener('click', downloadSearchablePdf);

    U.qrRun?.addEventListener('click', () => void runQrStandalone());
    U.qrDl?.addEventListener('click', () => void downloadQrImage());
  }

  function resetInitialState() {
    pickOcrFile(null);
    pickSearchableFile(null);
    if (U.qrDl) U.qrDl.disabled = true;
    msg(U.qrMsg, '');
  }

  return {
    bind,
    resetInitialState,
    pickOcrFile,
    pickSearchableFile,
    runOcrStandalone,
    runSearchableStandalone,
    runQrStandalone
  };
}
