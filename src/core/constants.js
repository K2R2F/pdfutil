export const MAX_THUMB = 0.23;

export const LIMITS = {
  maxFileBytes: 200 * 1024 * 1024,
  maxWorkspaceBytes: 750 * 1024 * 1024,
  maxUploadFiles: 80,
  maxWorkspacePages: 600,
  maxCanvasPixels: 16777216,
  pdfMaxImageSize: 268435456,
  pdfCanvasMaxAreaBytes: 67108864
};

export const PDF_JS_OPTIONS = {
  maxImageSize: LIMITS.pdfMaxImageSize,
  canvasMaxAreaInBytes: LIMITS.pdfCanvasMaxAreaBytes
};

export const WS_ADV_KEY = 'ws_toolbar_advanced_open_v1';

export const isWsToolbarMobile = () => window.matchMedia('(max-width:980px)').matches;
