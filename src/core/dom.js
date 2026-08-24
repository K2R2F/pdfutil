export const $ = (id) => document.getElementById(id);

export const U = {
  tabs: [...document.querySelectorAll('.tab')],
  panels: {ws: $('p-ws'), st: $('p-st'), rs: $('p-rs'), dg: $('p-dg'), cOcr: $('p-c-ocr'), cSrc: $('p-c-src'), cQr: $('p-c-qr')},
  drop: $('drop'), inFile: $('in-file'),
  wsGrid: $('ws-grid'), wsMsg: $('ws-msg'), wsProg: $('ws-prog'), wsFill: document.querySelector('#ws-prog .fill'), wsSnack: $('ws-snackbar'), wsSnackText: $('ws-snackbar-text'), wsSnackUndo: $('ws-snackbar-undo'), wsEntryMenu: $('ws-entry-menu'), wsPreviewModal: $('ws-preview-modal'), wsPreviewImg: $('ws-preview-img'), wsPreviewTitle: $('ws-preview-title'), wsPreviewClose: $('ws-preview-close'),
  fList: $('f-list'),
  wsUndo: $('ws-undo'), wsRedo: $('ws-redo'), wsSelAll: $('ws-sel-all'), wsSelNone: $('ws-sel-none'), wsRotSel: $('ws-rot-sel'), wsDelSel: $('ws-del-sel'), wsSplit: $('ws-split'), wsMerge: $('ws-merge'), wsAdvToggle: $('ws-adv-toggle'), wsToolbarAdvanced: $('ws-toolbar-advanced'),
  wsExpAll: $('ws-exp-all'), wsExpSel: $('ws-exp-sel'), wsExpImgAll: $('ws-exp-img-all'), wsExpImgSel: $('ws-exp-img-sel'),
  opMar: $('op-mar'), opMarScale: $('op-mar-scale'), opMarScaleInput: $('op-mar-scale-input'), wsSpreadDir: $('ws-spread-dir'), wsMergeCover: $('ws-merge-cover'),
  opPn: $('op-pn'), opPnPrintStart: $('op-pn-print-start'), opPnSeed: $('op-pn-seed'), opPnPrintEnd: $('op-pn-print-end'),
  opPnPos: $('op-pn-pos'), opPnFont: $('op-pn-font'), opPnSize: $('op-pn-size'), opPnOffX: $('op-pn-offx'), opPnOffY: $('op-pn-offy'),
  wsToolSt: $('ws-tool-st'), wsToolRs: $('ws-tool-rs'), wsToolDg: $('ws-tool-dg'), wsToolClose: $('ws-tool-close'), stBackWs: $('st-back-ws'), rsBackWs: $('rs-back-ws'), dgBackWs: $('dg-back-ws'),
  rsTargetInfo: $('rs-target-info'), rsRun: $('rs-run'), rsMsg: $('rs-msg'), rsProg: $('rs-prog'), rsFill: document.querySelector('#rs-prog .fill'),
  rsCompress: $('rs-compress'), rsScale: $('rs-scale'), rsQuality: $('rs-quality'), rsGray: $('rs-gray'), rsWhiten: $('rs-whiten'), rsWhite: $('rs-white'), rsBlack: $('rs-black'),
  rsPrevSrc: $('rs-prev-src'), rsPrevOut: $('rs-prev-out'), rsPrevMsg: $('rs-prev-msg'), rsPrevRefresh: $('rs-prev-refresh'),
  stFile: $('st-file'), stLoad: $('st-load'), stPrev: $('st-prev'), stNext: $('st-next'), stPage: $('st-page'), stPageInput: $('st-page-input'), stPageGo: $('st-page-go'),
  stStage: $('st-stage'), stCanvas: $('st-canvas'), stOverlay: $('st-overlay'), stMsg: $('st-msg'), stProg: $('st-prog'), stFill: document.querySelector('#st-prog .fill'),
  stPoint: $('st-point'), stText: $('st-text'), stColor: $('st-color'), stSize: $('st-size'), stOp: $('st-op'),
  stAddText: $('st-add-text'), stMaskW: $('st-mask-w'), stMaskH: $('st-mask-h'), stMaskOp: $('st-mask-op'), stAddMask: $('st-add-mask'),
  stClear: $('st-clear'), stApply: $('st-apply'), stList: $('st-list'),
  dgFiles: $('dg-files'), dgEntries: $('dg-entries'), dgSize: $('dg-size'), dgRebuild: $('dg-rebuild'), dgClear: $('dg-clear'), dgMsg: $('dg-msg'),
  ocrDrop: $('ocr-drop'), ocrInput: $('ocr-file'), ocrInfo: $('ocr-info'), ocrLang: $('ocr-lang'), ocrScale: $('ocr-scale'), ocrStart: $('ocr-start'), ocrEnd: $('ocr-end'), ocrRun: $('ocr-run'), ocrCancel: $('ocr-cancel'), ocrProg: $('ocr-prog'), ocrFill: document.querySelector('#ocr-prog .fill'), ocrMsg: $('ocr-msg'), ocrOut: $('ocr-out'), ocrDl: $('ocr-dl'),
  srcDrop: $('src-drop'), srcInput: $('src-file'), srcInfo: $('src-info'), srcLang: $('src-lang'), srcScale: $('src-scale'), srcStart: $('src-start'), srcEnd: $('src-end'), srcQuality: $('src-quality'), srcRun: $('src-run'), srcCancel: $('src-cancel'), srcProg: $('src-prog'), srcFill: document.querySelector('#src-prog .fill'), srcMsg: $('src-msg'), srcDl: $('src-dl'),
  qrText: $('qr-text'), qrSize: $('qr-size'), qrLevel: $('qr-level'), qrFg: $('qr-fg'), qrBg: $('qr-bg'), qrRun: $('qr-run'), qrDl: $('qr-dl'), qrCanvas: $('qr-canvas'), qrMsg: $('qr-msg'),
  manualOpen: $('app-manual-open'), manualModal: $('app-manual-modal'), manualClose: $('app-manual-close')
};
