# ツクエノウエの道具箱 — コード構成

このアプリはビルド処理を使わず、GitHub Pages からそのまま配信できるネイティブ ES Modules 構成です。入口は `tsukue_toolbox.html`、起動モジュールは `src/app.js` です。

## ディレクトリ

- `styles/tsukue-toolbox.css`: 画面全体のスタイル
- `src/app.js`: PDFワークスペース、画面切替、イベント配線、初期化
- `src/core/constants.js`: 容量・ページ数・PDF.js 描画上限
- `src/core/dom.js`: DOM参照
- `src/core/state.js`: 共有状態
- `src/core/utils.js`: バイナリ、Canvas、ダウンロードなどの共通処理
- `src/services/workspace-db.js`: IndexedDB 保存
- `src/services/pdf-worker-client.js`: PDF生成Worker、見開き、スタンプ定着
- `src/services/external-libraries.js`: 遅延読込するCDNスクリプトの検証付きローダー
- `src/features/raster-tools.js`: 圧縮、グレースケール、漂白、プレビュー
- `src/features/stamp-tools.js`: テキストスタンプ、白マスキング、PDF座標変換
- `src/features/standalone-tools.js`: OCR抽出、検索可能PDF、QR作成

## 変更時に守る条件

- CDNライブラリのバージョンとSRIを同時に管理する。
- PDF.js の `GlobalWorkerOptions.workerSrc` はPDF読込より先に設定する。
- 見開き結合で記録した `TSUKUE_TOOLBOX_SPREAD_V1` メタデータを分割時に使う。
- 奇数ページの最後は単独ページの寸法を維持する。
- 白マスクは `PageViewport.convertToPdfPoint()` で表示座標をPDF座標へ変換する。
- マスクだけの保存では日本語フォント取得を開始しない。
- OCR Worker起動は進捗表示、キャンセル、90秒タイムアウトを維持する。
- OCR用WebAssemblyに必要なCSPの `script-src 'wasm-unsafe-eval'` を維持する。広範な `'unsafe-eval'` は使用しない。
- ユーザー由来の値を `innerHTML` に渡さない。

## 確認方法

```powershell
node tests\verify-tsukue.mjs
node scripts\csp-hashes.mjs
```

ES Modules は `file://` 直開きではなくHTTP配信で確認します。

```powershell
python -m http.server 8767 --bind 127.0.0.1
```

その後 `http://127.0.0.1:8767/tsukue_toolbox.html` を開きます。
