import { U } from './core/dom.js';
import { S } from './core/state.js';
import { LIMITS, MAX_THUMB, WS_ADV_KEY, isWsToolbarMobile } from './core/constants.js';
import {
  assertCanvasBudget,
  base,
  canvasToBlobSafe,
  clamp,
  dl,
  emptyNode,
  fmt,
  msg,
  normRot,
  pdfLoadParams,
  prog,
  resolvePageRange,
  toAB,
  uid
} from './core/utils.js';
import { WorkspaceDb } from './services/workspace-db.js';
import { PdfWorkerClient } from './services/pdf-worker-client.js';
import { loadExternalScript } from './services/external-libraries.js';
import { createRasterTools } from './features/raster-tools.js';
import { createStampTools } from './features/stamp-tools.js';
import { createStandaloneTools } from './features/standalone-tools.js';

(()=>{
'use strict';
if(!window.PDFLib||!window.pdfjsLib){alert('必要ライブラリの読み込みに失敗しました');return;}
pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

function hideWsSnack(immediate=false){
  if(!U.wsSnack) return;
  if(S.wsSnackTimer){ clearTimeout(S.wsSnackTimer); S.wsSnackTimer=0; }
  U.wsSnack.classList.remove('show');
  U.wsSnack.setAttribute('aria-hidden','true');
  if(immediate) return;
}

function showWsSnack(text,opt={}){
  if(!U.wsSnack||!U.wsSnackText||!U.wsSnackUndo) return;
  if(S.wsSnackTimer){ clearTimeout(S.wsSnackTimer); S.wsSnackTimer=0; }
  U.wsSnackText.textContent=String(text||'');
  const canUndo = !!opt.undo && !S.history.lock && S.history.undo.length>0;
  U.wsSnackUndo.style.display = canUndo ? 'inline-flex' : 'none';
  U.wsSnack.classList.add('show');
  U.wsSnack.setAttribute('aria-hidden','false');
  const ms = clamp(Number(opt.ms)||3500,1200,10000);
  S.wsSnackTimer=setTimeout(()=>{ hideWsSnack(true); },ms);
}
function closeWsPreview(){
  S.wsPreviewToken++;
  if(S.wsPreviewObjUrl){
    try{ URL.revokeObjectURL(S.wsPreviewObjUrl); }catch{}
    S.wsPreviewObjUrl='';
  }
  if(!U.wsPreviewModal) return;
  U.wsPreviewModal.classList.remove('show');
  U.wsPreviewModal.setAttribute('aria-hidden','true');
  document.body.classList.remove('ws-preview-open');
  if(U.wsPreviewImg) U.wsPreviewImg.removeAttribute('src');
}

async function wsBuildPreviewSource(entry){
  const rec = await DBI.get(entry.fileId);
  if(!rec || !rec.data) return {src:entry.thumb||'', objectUrl:false};

  if(entry.fileType==='image' || rec.kind==='image'){
    const blob = new Blob([toAB(rec.data)],{type:rec.mime||'image/jpeg'});
    return {src:URL.createObjectURL(blob), objectUrl:true};
  }

  const bytes = toAB(rec.data);
  const cvs = document.createElement('canvas');
  let loadingTask=null;
  let pdf=null;
  try{
    loadingTask = pdfjsLib.getDocument(pdfLoadParams(bytes));
    pdf = await loadingTask.promise;
    const page = await pdf.getPage((Number(entry.pageIndex)||0)+1);
    const rot = normRot((page.rotate||0) + (Number(entry.rotation)||0));
    const v1 = page.getViewport({scale:1,rotation:rot});
    const longSide = Math.max(v1.width,v1.height);
    const scale = clamp(1900/Math.max(longSide,1),1,3.2);
    const vp = page.getViewport({scale,rotation:rot});
    assertCanvasBudget(vp.width,vp.height,'拡大プレビュー');

    const ctx = cvs.getContext('2d',{alpha:false,willReadFrequently:false});
    cvs.width = Math.max(1,Math.floor(vp.width));
    cvs.height = Math.max(1,Math.floor(vp.height));
    await page.render({canvasContext:ctx,viewport:vp,background:'#fff'}).promise;
    if(typeof page.cleanup==='function') try{ page.cleanup(); }catch{}
    return {src:cvs.toDataURL('image/jpeg',0.94), objectUrl:false};
  }finally{
    cvs.width=0;
    cvs.height=0;
    if(pdf && typeof pdf.destroy==='function') try{ await pdf.destroy(); }catch{}
    else if(loadingTask && typeof loadingTask.destroy==='function') try{ await loadingTask.destroy(); }catch{}
  }
}

async function openWsPreview(entry){
  if(!entry||!U.wsPreviewModal||!U.wsPreviewImg) return;
  const token = ++S.wsPreviewToken;

  if(S.wsPreviewObjUrl){
    try{ URL.revokeObjectURL(S.wsPreviewObjUrl); }catch{}
    S.wsPreviewObjUrl='';
  }

  const pLabel = entry.fileType==='pdf' ? ('P'+(Number(entry.pageIndex||0)+1)) : 'IMG';
  if(U.wsPreviewTitle) U.wsPreviewTitle.textContent = String(entry.fileName||'')+'  '+pLabel+'（読込中…）';
  U.wsPreviewImg.removeAttribute('src');
  U.wsPreviewModal.classList.add('show');
  U.wsPreviewModal.setAttribute('aria-hidden','false');
  document.body.classList.add('ws-preview-open');

  try{
    const built = await wsBuildPreviewSource(entry);
    if(token!==S.wsPreviewToken){
      if(built.objectUrl){ try{ URL.revokeObjectURL(built.src); }catch{} }
      return;
    }
    if(built.objectUrl) S.wsPreviewObjUrl = built.src;
    U.wsPreviewImg.src = built.src || entry.thumb || '';
    if(U.wsPreviewTitle) U.wsPreviewTitle.textContent = String(entry.fileName||'')+'  '+pLabel;
  }catch{
    if(token!==S.wsPreviewToken) return;
    U.wsPreviewImg.src = entry.thumb || '';
    if(U.wsPreviewTitle) U.wsPreviewTitle.textContent = String(entry.fileName||'')+'  '+pLabel+'（簡易表示）';
  }
}

async function ensureJSZip(){
  if(typeof JSZip!=='undefined') return JSZip;
  const urls=[
    {url:'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',integrity:'sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG'},
    {url:'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',integrity:'sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG'},
    {url:'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js',integrity:'sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG'}
  ];
  await loadExternalScript('jszip',urls,()=>typeof JSZip!=='undefined');
  if(typeof JSZip!=='undefined') return JSZip;
  throw new Error('ZIPライブラリを読み込めませんでした。ネットワーク環境を確認してください。');
}
const DBI=new WorkspaceDb();
const WK=new PdfWorkerClient();

const {
  renderStampSelect,
  loadStamp,
  renderStPoint,
  renderStampList,
  renderStampOverlay,
  renderStampPage,
  jumpStampPage,
  addTextStamp,
  addMaskStamp,
  applySt
}=createStampTools({DBI, WK});

async function refreshMeta(){
  S.meta=await DBI.allMeta();
  renderFiles();
  renderStampSelect();
  renderDiag();
}

async function fromRecord(meta,data){
  const out=[];
  if(meta.kind==='image'){
    const objUrl=URL.createObjectURL(new Blob([data],{type:meta.mime||'image/jpeg'}));
    S.thumbUrls.add(objUrl);
    out.push({id:uid(),fileId:meta.id,fileName:meta.name,fileType:'image',pageIndex:0,rotation:0,selected:false,thumb:objUrl,obj:objUrl});
    return out;
  }

  const pdf=await pdfjsLib.getDocument(pdfLoadParams(data)).promise;
  try{
    if(pdf.numPages>LIMITS.maxWorkspacePages){
      throw new Error('PDFは'+LIMITS.maxWorkspacePages+'ページ以内に分割して追加してください');
    }
    for(let i=1;i<=pdf.numPages;i++){
      const p=await pdf.getPage(i);
      const v=p.getViewport({scale:MAX_THUMB});
      assertCanvasBudget(v.width,v.height,'サムネイル');
      const c=document.createElement('canvas');
      const x=c.getContext('2d');
      c.width=Math.max(1,Math.floor(v.width)); c.height=Math.max(1,Math.floor(v.height));
      await p.render({canvasContext:x,viewport:v,background:'white'}).promise;
      out.push({
        id:uid(),fileId:meta.id,fileName:meta.name,fileType:'pdf',pageIndex:i-1,
        rotation:0,selected:false,thumb:c.toDataURL('image/jpeg',0.74),obj:null
      });
      if(typeof p.cleanup==='function') try{ p.cleanup(); }catch{}
      c.width=0; c.height=0;
      msg(U.wsMsg,meta.name+' サムネイル '+i+'/'+pdf.numPages);
    }
  }finally{
    try{await pdf.destroy();}catch{}
  }
  return out;
}

function revoke(entries){
  for(const e of entries){
    if(e.obj){
      try{URL.revokeObjectURL(e.obj);}catch{}
      S.thumbUrls.delete(e.obj);
    }
  }
}

async function rebuild(){
  msg(U.wsMsg,'IndexedDBから再構築中...');
  revoke(S.entries);
  S.entries=[];
  renderWs();
  for(const m of S.meta){
    try{
      const r=await DBI.get(m.id);
      if(!r||!r.data)continue;
      const arr=await fromRecord(m,r.data);
      if(S.entries.length+arr.length>LIMITS.maxWorkspacePages){
        revoke(arr);
        throw new Error('ワークスペースは合計'+LIMITS.maxWorkspacePages+'ページ以内です');
      }
      S.entries.push(...arr);
    }catch(e){
      console.error(e);
      msg(U.wsMsg,'再構築失敗: '+m.name);
    }
  }
  resetWsHistory();
  msg(U.wsMsg,'再構築完了');
  renderAll();
}

function wsSelectRange(toIdx,mode='add'){
  const maxIdx=Math.max(0,S.entries.length-1);
  const idx = clamp(Number(toIdx)||0,0,maxIdx);
  const anchor = (Number.isInteger(S.selectionAnchorIndex) && S.selectionAnchorIndex>=0 && S.selectionAnchorIndex<=maxIdx)
    ? S.selectionAnchorIndex
    : (S.wsLastSelIdx>=0 ? clamp(S.wsLastSelIdx,0,maxIdx) : idx);
  const a = Math.min(anchor,idx);
  const b = Math.max(anchor,idx);
  const remove = mode==='remove';
  for(let i=a;i<=b;i++) S.entries[i].selected = remove ? false : true;
  S.selectionAnchorIndex = idx;
  S.wsLastSelIdx = idx;
  return {start:a,end:b,mode:remove?'remove':'add'};
}

function wsAdjustAnchorForMove(from,to){
  const ai = Number(S.selectionAnchorIndex);
  if(!Number.isInteger(ai) || ai<0) return;
  if(from===to) return;
  if(ai===from){
    S.selectionAnchorIndex=to;
  }else if(from<ai && to>=ai){
    S.selectionAnchorIndex=ai-1;
  }else if(from>ai && to<=ai){
    S.selectionAnchorIndex=ai+1;
  }
  S.wsLastSelIdx = S.selectionAnchorIndex;
}

function wsSyncAnchorAfterReorder(prevEntries,nextEntries){
  const ai = Number(S.selectionAnchorIndex);
  if(!Number.isInteger(ai) || ai<0) return;
  const anchorEntry = prevEntries?.[ai];
  if(!anchorEntry){ S.selectionAnchorIndex=-1; S.wsLastSelIdx=-1; return; }
  const newIdx = nextEntries.findIndex(x=>x.id===anchorEntry.id);
  if(newIdx<0){ S.selectionAnchorIndex=-1; S.wsLastSelIdx=-1; return; }
  S.selectionAnchorIndex=newIdx;
  S.wsLastSelIdx=newIdx;
}

function wsShowRangeStatus(range){
  if(!range) return;
  const txt='P'+(range.start+1)+'-P'+(range.end+1)+' を'+(range.mode==='remove'?'解除':'選択');
  msg(U.wsMsg,txt);
  if(S.wsMsgTimer) clearTimeout(S.wsMsgTimer);
  S.wsMsgTimer=setTimeout(()=>{
    if(U.wsMsg.textContent===txt) msg(U.wsMsg,'');
  },1400);
}

function wsCloseEntryMenu(){
  const m=U.wsEntryMenu;
  if(!m) return;
  m.hidden=true;
  m.setAttribute('aria-hidden','true');
  m.removeAttribute('data-entry-id');
  m.style.left='';
  m.style.top='';
  S.wsEntryMenuOpenId='';
  document.querySelectorAll('.entry .qa-more[aria-expanded="true"]').forEach(btn=>btn.setAttribute('aria-expanded','false'));
}

function wsOpenEntryMenu(entry,anchorEl,point){
  const m=U.wsEntryMenu;
  if(!m || !entry || !entry.id) return;

  if(!m.hidden && S.wsEntryMenuOpenId===entry.id){
    wsCloseEntryMenu();
    return;
  }

  wsCloseEntryMenu();
  m.dataset.entryId=entry.id;
  m.hidden=false;
  m.setAttribute('aria-hidden','false');
  if(anchorEl?.setAttribute) anchorEl.setAttribute('aria-expanded','true');

  const rect = anchorEl?.getBoundingClientRect ? anchorEl.getBoundingClientRect() : null;
  const vw = window.innerWidth || document.documentElement.clientWidth || 1200;
  const vh = window.innerHeight || document.documentElement.clientHeight || 800;
  const pad = 8;

  let x = Number.isFinite(point?.x) ? point.x : (rect ? rect.right + 6 : pad);
  let y = Number.isFinite(point?.y) ? point.y : (rect ? rect.bottom + 6 : pad);

  const mw = m.offsetWidth || 184;
  const mh = m.offsetHeight || 176;

  if(x + mw > vw - pad){
    x = rect ? (rect.left - mw - 6) : (vw - mw - pad);
  }
  if(x < pad) x = pad;

  if(y + mh > vh - pad){
    y = rect ? (rect.top - mh - 6) : (vh - mh - pad);
  }
  if(y < pad) y = pad;

  m.style.left=Math.round(x)+'px';
  m.style.top=Math.round(y)+'px';
  S.wsEntryMenuOpenId=entry.id;
}

function wsApplyEntryAction(entryId,a){
  const idx=S.entries.findIndex(x=>x.id===entryId);
  if(idx<0) return false;
  const e=S.entries[idx];

  if(a==='zoom'){
    openWsPreview(e);
    return true;
  }

  const changed=wsMutate('entry_action',()=>{
    if(a==='up'&&idx>0){
      [S.entries[idx-1],S.entries[idx]]=[S.entries[idx],S.entries[idx-1]];
      wsAdjustAnchorForMove(idx,idx-1);
    }
    else if(a==='dn'&&idx<S.entries.length-1){
      [S.entries[idx+1],S.entries[idx]]=[S.entries[idx],S.entries[idx+1]];
      wsAdjustAnchorForMove(idx,idx+1);
    }
    else if(a==='top'&&idx>0){
      const prevEntries=S.entries.slice();
      const [mv]=S.entries.splice(idx,1);
      S.entries.unshift(mv);
      wsSyncAnchorAfterReorder(prevEntries,S.entries);
    }
    else if(a==='bottom'&&idx<S.entries.length-1){
      const prevEntries=S.entries.slice();
      const [mv]=S.entries.splice(idx,1);
      S.entries.push(mv);
      wsSyncAnchorAfterReorder(prevEntries,S.entries);
    }
    else if(a==='rot'){
      e.rotation=normRot((Number(e.rotation)||0)+90);
    }
    else if(a==='del'){
      const prevEntries=S.entries.slice();
      S.entries=S.entries.filter(x=>x.id!==e.id);
      wsSyncAnchorAfterReorder(prevEntries,S.entries);
    }
  });

  if(changed){
    if(a==='rot') showWsSnack('ページを回転しました',{undo:true});
    else if(a==='del') showWsSnack('ページを削除しました',{undo:true});
    else if(a==='top') showWsSnack('ページを先頭へ移動しました',{undo:true});
    else if(a==='bottom') showWsSnack('ページを末尾へ移動しました',{undo:true});
    else if(a==='up' || a==='dn') showWsSnack('ページ順を変更しました',{undo:true});
    renderAll();
  }else{
    updateHistoryButtons();
  }
  return changed;
}
function cloneEntryForPool(e){
  if(!e||!e.id) return null;
  return {
    id:e.id,
    fileId:e.fileId,
    fileName:e.fileName,
    fileType:e.fileType,
    pageIndex:e.pageIndex,
    rotation:normRot(Number(e.rotation)||0),
    selected:!!e.selected,
    thumb:e.thumb,
    obj:e.obj||null
  };
}

function rememberEntriesInPool(entries){
  for(const e of (entries||[])){
    const c=cloneEntryForPool(e);
    if(c) S.entryPool.set(c.id,c);
  }
}

function isSameWsSnapshot(a,b){
  if(!a||!b) return false;
  if(a.selectionAnchorIndex!==b.selectionAnchorIndex) return false;
  if(a.wsLastSelIdx!==b.wsLastSelIdx) return false;
  if(!Array.isArray(a.entries)||!Array.isArray(b.entries)) return false;
  if(a.entries.length!==b.entries.length) return false;
  for(let i=0;i<a.entries.length;i++){
    const x=a.entries[i],y=b.entries[i];
    if(x.id!==y.id) return false;
    if(!!x.selected!==!!y.selected) return false;
    if(normRot(Number(x.rotation)||0)!==normRot(Number(y.rotation)||0)) return false;
  }
  return true;
}

function createWsSnapshot(){
  rememberEntriesInPool(S.entries);
  return {
    entries:S.entries.map(e=>({id:e.id,selected:!!e.selected,rotation:normRot(Number(e.rotation)||0)})),
    selectionAnchorIndex:Number.isInteger(S.selectionAnchorIndex)?S.selectionAnchorIndex:-1,
    wsLastSelIdx:Number.isInteger(S.wsLastSelIdx)?S.wsLastSelIdx:-1
  };
}

function pushHistoryState(snapshot,actionType='op'){
  if(S.history.lock) return false;
  if(!snapshot||!Array.isArray(snapshot.entries)) return false;
  const last=S.history.undo.length?S.history.undo[S.history.undo.length-1].snap:null;
  if(last && isSameWsSnapshot(last,snapshot)) return false;
  S.history.undo.push({type:actionType,snap:snapshot,ts:Date.now()});
  if(S.history.undo.length>S.history.max){
    S.history.undo.splice(0,S.history.undo.length-S.history.max);
  }
  S.history.redo.length=0;
  updateHistoryButtons();
  return true;
}

function wsMutate(actionType,mutator){
  if(typeof mutator!=='function') return false;
  const before=createWsSnapshot();
  mutator();
  const after=createWsSnapshot();
  if(isSameWsSnapshot(before,after)) return false;
  pushHistoryState(before,actionType);
  return true;
}

function applyWsSnapshot(snapshot){
  if(!snapshot||!Array.isArray(snapshot.entries)) return false;
  const curMap=new Map(S.entries.map(e=>[e.id,e]));
  const next=[];
  for(const item of snapshot.entries){
    if(!item||!item.id) continue;
    const src=curMap.get(item.id)||S.entryPool.get(item.id);
    if(!src) continue;
    const e={...src};
    e.selected=!!item.selected;
    e.rotation=normRot(Number(item.rotation)||0);
    next.push(e);
  }
  S.entries=next;

  const max=S.entries.length-1;
  const normalizeIdx=(v)=>{
    if(max<0) return -1;
    const n=Number(v);
    if(!Number.isInteger(n)) return -1;
    return clamp(n,0,max);
  };
  S.selectionAnchorIndex=normalizeIdx(snapshot.selectionAnchorIndex);
  S.wsLastSelIdx=normalizeIdx(snapshot.wsLastSelIdx);
  rememberEntriesInPool(S.entries);
  renderAll();
  return true;
}

function updateHistoryButtons(){
  if(U.wsUndo){
    U.wsUndo.disabled = !!S.history.lock || S.history.undo.length===0;
    U.wsUndo.title = S.history.lock ? '処理中は元に戻せません' : '元に戻す (Ctrl+Z)';
  }
  if(U.wsRedo){
    U.wsRedo.disabled = !!S.history.lock || S.history.redo.length===0;
    U.wsRedo.title = S.history.lock ? '処理中はやり直せません' : 'やり直し (Ctrl+Y)';
  }
}

function resetWsHistory(keepPool=false){
  if(!keepPool) S.entryPool.clear();
  rememberEntriesInPool(S.entries);
  S.history.undo.length=0;
  S.history.redo.length=0;
  S.history.lock=false;
  updateHistoryButtons();
}

function undoWs(){
  if(S.history.lock||!S.history.undo.length){ updateHistoryButtons(); return; }
  const cur=createWsSnapshot();
  const step=S.history.undo.pop();
  S.history.redo.push({type:step.type,snap:cur,ts:Date.now()});
  if(S.history.redo.length>S.history.max){
    S.history.redo.splice(0,S.history.redo.length-S.history.max);
  }
  applyWsSnapshot(step.snap);
  msg(U.wsMsg,'元に戻しました');
  updateHistoryButtons();
}

function redoWs(){
  if(S.history.lock||!S.history.redo.length){ updateHistoryButtons(); return; }
  const cur=createWsSnapshot();
  const step=S.history.redo.pop();
  S.history.undo.push({type:step.type,snap:cur,ts:Date.now()});
  if(S.history.undo.length>S.history.max){
    S.history.undo.splice(0,S.history.undo.length-S.history.max);
  }
  applyWsSnapshot(step.snap);
  msg(U.wsMsg,'やり直しました');
  updateHistoryButtons();
}
function updateSelectionUI(){
  renderWs();
}

function updateWsExportButtons(){
  const hasAny = S.entries.length>0;
  const selected = S.entries.filter(e=>e.selected);
  const hasSel = selected.length>0;
  const allSelectedPdf = hasSel && selected.every(e=>e.fileType==='pdf');
  U.wsExpAll.disabled=!hasAny;
  U.wsExpSel.disabled=!hasSel;
  if(U.wsExpImgAll) U.wsExpImgAll.disabled=!hasAny;
  if(U.wsExpImgSel) U.wsExpImgSel.disabled=!hasSel;
  if(U.wsSplit) U.wsSplit.disabled=!allSelectedPdf;
  if(U.wsMerge) U.wsMerge.disabled=!(allSelectedPdf && selected.length>=2);
}

function setWsExportBusy(busy){
  S.history.lock=!!busy;
  if(busy){
    U.wsExpAll.disabled=true;
    U.wsExpSel.disabled=true;
    if(U.wsExpImgAll) U.wsExpImgAll.disabled=true;
    if(U.wsExpImgSel) U.wsExpImgSel.disabled=true;
    if(U.wsSplit) U.wsSplit.disabled=true;
    if(U.wsMerge) U.wsMerge.disabled=true;
    if(U.rsRun) U.rsRun.disabled=true;
    if(U.rsPrevRefresh) U.rsPrevRefresh.disabled=true;
    updateHistoryButtons();
    return;
  }
  updateWsExportButtons();
  renderRasterSelectionInfo();
  if(U.rsPrevRefresh) U.rsPrevRefresh.disabled=false;
  if(U.panels?.rs?.classList.contains('active')) scheduleRasterPreview(120);
  updateHistoryButtons();
}

function renderWs(){
  U.wsGrid.replaceChildren();
  wsCloseEntryMenu();
  if(!S.entries.length){
    S.selectionAnchorIndex=-1;
    S.wsLastSelIdx=-1;
    U.wsGrid.appendChild(emptyNode('ページがありません'));
    updateWsExportButtons();
    renderRasterSelectionInfo();
    if(U.panels?.rs?.classList.contains('active')) clearRasterPreviewCanvas('プレビュー対象がありません（ページを選択してください）');
    updateHistoryButtons();
    return;
  }

  const maxIdx=S.entries.length-1;
  if(S.selectionAnchorIndex>maxIdx) S.selectionAnchorIndex=maxIdx;
  if(S.wsLastSelIdx>maxIdx) S.wsLastSelIdx=maxIdx;

  const clearWsDragVisuals = ()=>{
    U.wsGrid.classList.remove('dragging');
    U.wsGrid.querySelectorAll('.entry').forEach(el=>{
      el.classList.remove('drag-over','drag-origin');
      el.removeAttribute('data-drag-badge');
    });
  };
  const resetWsDragState = ()=>{
    S.wsDragFrom=-1;
    S.wsDragIds=[];
    clearWsDragVisuals();
  };

  S.entries.forEach((e,idx)=>{
    const d=document.createElement('div');
    d.className='entry'+(e.selected?' sel':'');
    d.draggable=true;
    d.dataset.idx=String(idx);

    const pl=e.fileType==='pdf'?'P'+(e.pageIndex+1):'IMG';
    const topRow=document.createElement('div');
    topRow.className='row row-top';
    const pageLabel=document.createElement('span');
    pageLabel.textContent=pl;
    const quick=document.createElement('div');
    quick.className='quick-actions';
    quick.setAttribute('aria-label','クイック操作');
    [
      ['zoom','qa-btn','拡大','⤢'],
      ['rot','qa-btn','回転','↻'],
      ['del','qa-btn delete','削除','✕'],
      ['more','qa-btn qa-more','操作メニュー','…']
    ].forEach(([a,cls,title,text])=>{
      const b=document.createElement('button');
      b.dataset.a=a;
      b.className=cls;
      b.title=title;
      b.textContent=text;
      if(a==='more'){
        b.setAttribute('aria-haspopup','menu');
        b.setAttribute('aria-expanded','false');
      }
      quick.appendChild(b);
    });
    topRow.append(pageLabel,quick);

    const img=document.createElement('img');
    img.alt='thumb';

    const infoRow=document.createElement('div');
    infoRow.className='row';
    const nameSpan=document.createElement('span');
    nameSpan.className='name';
    nameSpan.title=String(e.fileName||'');
    nameSpan.textContent=String(e.fileName||'');
    const rotSpan=document.createElement('span');
    rotSpan.textContent='↻'+(e.rotation||0);
    infoRow.append(nameSpan,rotSpan);

    const actions=document.createElement('div');
    actions.className='actions';
    [
      ['up','↑'],
      ['dn','↓'],
      ['rot','↻'],
      ['del','✕']
    ].forEach(([a,text])=>{
      const b=document.createElement('button');
      b.dataset.a=a;
      b.textContent=text;
      actions.appendChild(b);
    });
    d.append(topRow,img,infoRow,actions);

    img.src=e.thumb;
    img.style.transform='rotate('+normRot(e.rotation||0)+'deg)';
    img.addEventListener('dblclick',(ev)=>{
      ev.preventDefault();
      ev.stopPropagation();
      if(S.wsImgClickTimer){
        clearTimeout(S.wsImgClickTimer);
        S.wsImgClickTimer=0;
      }
      openWsPreview(e);
    });

    d.addEventListener('mousedown',(ev)=>{
      const b=ev.target.closest('button');
      if(b) return;
      if(ev.button!==0) return;
      S.wsCtrlMouseDown=!!ev.ctrlKey;
    });

    let wsTouchHoldTimer=0;
    let wsTouchHoldPoint=null;
    const clearWsTouchHold=()=>{
      if(wsTouchHoldTimer){ clearTimeout(wsTouchHoldTimer); wsTouchHoldTimer=0; }
      wsTouchHoldPoint=null;
    };
    d.addEventListener('pointerdown',(ev)=>{
      if(ev.pointerType!=='touch') return;
      if(ev.target.closest('button')) return;
      wsTouchHoldPoint={x:ev.clientX,y:ev.clientY};
      if(wsTouchHoldTimer) clearTimeout(wsTouchHoldTimer);
      wsTouchHoldTimer=setTimeout(()=>{
        wsTouchHoldTimer=0;
        S.wsLongPressUntil=Date.now()+360;
        wsOpenEntryMenu(e,null,wsTouchHoldPoint);
      },460);
    });
    d.addEventListener('pointermove',(ev)=>{
      if(!wsTouchHoldTimer || !wsTouchHoldPoint) return;
      if(Math.abs(ev.clientX-wsTouchHoldPoint.x)>10 || Math.abs(ev.clientY-wsTouchHoldPoint.y)>10){
        clearWsTouchHold();
      }
    });
    d.addEventListener('pointerup',clearWsTouchHold);
    d.addEventListener('pointercancel',clearWsTouchHold);
    d.addEventListener('pointerleave',clearWsTouchHold);

    d.addEventListener('dragstart',(ev)=>{
      clearWsDragVisuals();
      S.wsDragFrom=idx;
      const selectedIds = S.entries.filter(x=>x.selected).map(x=>x.id);
      if(e.selected && selectedIds.length){
        S.wsDragIds=selectedIds.slice();
      }else{
        S.wsDragIds=[e.id];
      }
      if(S.wsDragIds.length>1){
        d.classList.add('drag-origin');
        d.setAttribute('data-drag-badge',S.wsDragIds.length+'ページ移動中');
      }else{
        d.classList.remove('drag-origin');
        d.removeAttribute('data-drag-badge');
      }
      U.wsGrid.classList.add('dragging');
      try{
        ev.dataTransfer.effectAllowed='move';
        ev.dataTransfer.setData('text/plain',String(idx));
      }catch{}
    });
    d.addEventListener('dragover',(ev)=>{
      ev.preventDefault();
      const draggedSet = new Set(Array.isArray(S.wsDragIds)?S.wsDragIds:[]);
      const targetId = S.entries[idx]?.id;
      if(draggedSet.size>1 && targetId && draggedSet.has(targetId)){
        d.classList.remove('drag-over');
        return;
      }
      d.classList.add('drag-over');
    });
    d.addEventListener('dragleave',()=>{ d.classList.remove('drag-over'); });
    d.addEventListener('drop',(ev)=>{
      ev.preventDefault();
      U.wsGrid.querySelectorAll('.entry').forEach(el=>el.classList.remove('drag-over'));

      const targetId = S.entries[idx]?.id;
      const draggedIds = (Array.isArray(S.wsDragIds) && S.wsDragIds.length)
        ? S.wsDragIds.slice()
        : ((S.wsDragFrom>=0 && S.wsDragFrom<S.entries.length) ? [S.entries[S.wsDragFrom].id] : []);
      if(!draggedIds.length){ resetWsDragState(); return; }

      if(draggedIds.length===1){
        const from=S.wsDragFrom;
        const to=idx;
        if(from<0 || from===to || from>=S.entries.length){ resetWsDragState(); return; }
        const changed=wsMutate('drag_move_single',()=>{
          const prevEntries=S.entries.slice();
          const [mv]=S.entries.splice(from,1);
          S.entries.splice(to,0,mv);
          wsSyncAnchorAfterReorder(prevEntries,S.entries);
        });
        resetWsDragState();
        if(changed){
          msg(U.wsMsg,'1ページを P'+(to+1)+' へ移動');
          showWsSnack('ページ順を移動しました',{undo:true});
          renderWs();
        }
        return;
      }

      const draggedSet = new Set(draggedIds);
      if(targetId && draggedSet.has(targetId)){
        msg(U.wsMsg,'選択範囲内へのドロップは移動しません');
        resetWsDragState();
        return;
      }

      const changed=wsMutate('drag_move_multi',()=>{
        const prevEntries=S.entries.slice();
        const movingEntries = S.entries.filter(x=>draggedSet.has(x.id));
        if(!movingEntries.length) return;
        const remaining = S.entries.filter(x=>!draggedSet.has(x.id));

        let insertIndex = remaining.findIndex(x=>x.id===targetId);
        if(insertIndex<0) insertIndex = remaining.length;

        S.entries = [
          ...remaining.slice(0,insertIndex),
          ...movingEntries,
          ...remaining.slice(insertIndex)
        ];

        const keepSel=new Set(draggedIds);
        S.entries.forEach(x=>{ x.selected = keepSel.has(x.id); });
        wsSyncAnchorAfterReorder(prevEntries,S.entries);
      });
      resetWsDragState();

      if(changed){
        const targetPosAfter = targetId ? S.entries.findIndex(x=>x.id===targetId) : -1;
        if(targetPosAfter>=0) msg(U.wsMsg,draggedIds.length+'ページを P'+(targetPosAfter+1)+' の前へ移動');
        else msg(U.wsMsg,draggedIds.length+'ページを末尾へ移動');
        showWsSnack(draggedIds.length+'ページを移動しました',{undo:true});
        renderWs();
      }
    });
    d.addEventListener('dragend',()=>{ resetWsDragState(); });

    d.addEventListener('click',(ev)=>{
      const b=ev.target.closest('button');
      if(!b){
        const applySelect = ()=>{
          const isCtrlLeft = (ev.button===0) && (ev.ctrlKey || S.wsCtrlMouseDown);
          const isShiftLeft = (ev.button===0) && ev.shiftKey;
          const isRangeLeft = isShiftLeft || isCtrlLeft;
          if(isRangeLeft){
            const targetSelected = !!e.selected;
            let range=null;
            wsMutate('range_select',()=>{ range = wsSelectRange(idx,targetSelected?'remove':'add'); });
            wsShowRangeStatus(range);
          }else{
            wsMutate('toggle_select',()=>{
              e.selected=!e.selected;
              S.selectionAnchorIndex=idx;
              S.wsLastSelIdx=idx;
            });
          }
          S.wsCtrlMouseDown=false;
          updateSelectionUI();
          updateHistoryButtons();
        };

        const isImgTarget = ev.target===img;
        const hasRangeMod = ev.shiftKey || ev.ctrlKey || S.wsCtrlMouseDown;
        if(isImgTarget && ev.button===0 && !hasRangeMod){
          if(S.wsImgClickTimer){ clearTimeout(S.wsImgClickTimer); S.wsImgClickTimer=0; }
          S.wsImgClickTimer=setTimeout(()=>{
            S.wsImgClickTimer=0;
            if(Date.now()<S.wsLongPressUntil){ S.wsCtrlMouseDown=false; return; }
        applySelect();
          },220);
          return;
        }

        if(Date.now()<S.wsLongPressUntil){ S.wsCtrlMouseDown=false; return; }
        applySelect();
        return;
      }

      S.wsCtrlMouseDown=false;
      const a=b.dataset.a;
      if(a==='more'){
        wsOpenEntryMenu(e,b);
        return;
      }
      wsCloseEntryMenu();
      wsApplyEntryAction(e.id,a);
    });

    U.wsGrid.appendChild(d);
  });

  updateWsExportButtons();
  renderRasterSelectionInfo();
  if(U.rsPrevRefresh) U.rsPrevRefresh.disabled=false;
  if(U.panels?.rs?.classList.contains('active')) scheduleRasterPreview(120);
  updateHistoryButtons();
}

function renderFiles(){
  U.fList.replaceChildren();
  for(const m of S.meta){
    const li=document.createElement('li');
    const actions=document.createElement('div');
    actions.className='f-actions';
    const focus=document.createElement('button');
    focus.dataset.a='focus';
    focus.textContent='展開';
    const del=document.createElement('button');
    del.dataset.a='del';
    del.className='delete';
    del.textContent='削除';
    actions.append(focus,del);

    const body=document.createElement('div');
    const name=document.createElement('div');
    name.className='fname';
    name.title=String(m.name||'');
    name.textContent=String(m.name||'');
    const sub=document.createElement('div');
    sub.className='fsub';
    sub.textContent=String(m.kind||'').toUpperCase()+' / '+fmt(m.size);
    body.append(name,sub);

    focus.addEventListener('click',()=>{ S.entries.forEach(e=>e.selected=e.fileId===m.id); renderWs(); });
    del.addEventListener('click',()=>void delFileEverywhere(m.id));
    li.append(actions,body);
    U.fList.appendChild(li);
  }
}

function renderDiag(){
  const tot=S.meta.reduce((n,f)=>n+(Number(f.size)||0),0);
  U.dgFiles.textContent=String(S.meta.length);
  U.dgEntries.textContent=String(S.entries.length);
  U.dgSize.textContent=fmt(tot);
}

function renderAll(){ renderWs(); renderFiles(); renderStampSelect(); renderStampList(); renderDiag(); }

async function delFileEverywhere(fid){
  const rm=S.entries.filter(e=>e.fileId===fid);
  revoke(rm);
  S.entries=S.entries.filter(e=>e.fileId!==fid);
  delete S.stampsByFile[fid];
  for(const [eid,entry] of [...S.entryPool.entries()]){
    if(entry.fileId===fid){
      if(entry.obj){ try{ URL.revokeObjectURL(entry.obj); }catch{} S.thumbUrls.delete(entry.obj); }
      S.entryPool.delete(eid);
    }
  }

  if(S.stFileId===fid){
    S.stFileId=null;
    S.stBytes=null;
    if(S.stDoc) try{await S.stDoc.destroy();}catch{}
    S.stDoc=null;
    U.stCanvas.width=0; U.stCanvas.height=0;
    U.stPage.textContent='- / -';
  }

  await DBI.del(fid);
  await refreshMeta();
  renderAll();
}

async function cleanOrphans(){
  const alive=new Set(S.entries.map(e=>e.fileId));
  for(const m of S.meta){
    if(!alive.has(m.id)){
      delete S.stampsByFile[m.id];
      for(const [eid,entry] of [...S.entryPool.entries()]){
        if(entry.fileId===m.id){
          if(entry.obj){ try{ URL.revokeObjectURL(entry.obj); }catch{} S.thumbUrls.delete(entry.obj); }
          S.entryPool.delete(eid);
        }
      }
      await DBI.del(m.id);
    }
  }
  await refreshMeta();
}

async function resolveFilesForEntries(entries){
  const ids=[...new Set(entries.map(e=>e.fileId))];
  const files=[];
  const transfers=[];
  const missingIds=[];

  for(const fid of ids){
    const r=await DBI.get(fid);
    if(!r||!r.data){
      missingIds.push(fid);
      continue;
    }
    const ab=toAB(r.data);
    files.push({id:fid,mime:r.mime,kind:r.kind,data:ab});
    transfers.push(ab);
  }

  if(missingIds.length){
    const missSet=new Set(missingIds);
    const orphanEntries=S.entries.filter(e=>missSet.has(e.fileId));
    revoke(orphanEntries);
    S.entries=S.entries.filter(e=>!missSet.has(e.fileId));
    S.wsLastSelIdx=-1;
    await refreshMeta();
    renderAll();
    throw new Error('一部ページの元ファイルがIndexedDBから見つからないため、処理を中断しました。再読込後に再実行してください。');
  }

  return {files,transfers};
}

async function replaceSelectionWithGeneratedPdf(selectedRows,outBytes,suffix){
  if(!selectedRows.length) return;
  const sorted=selectedRows.slice().sort((a,b)=>a.idx-b.idx);
  const firstIdx=sorted[0].idx;
  const selectedEntryIds=new Set(sorted.map(x=>x.e.id));
  const removed=S.entries.filter(e=>selectedEntryIds.has(e.id));
  const sourceBase=base(sorted[0].e.fileName||'workspace');
  const outAb=toAB(outBytes);
  const fid=uid();
  const fname=sourceBase+'_'+suffix+'.pdf';

  await DBI.put({
    id:fid,
    name:fname,
    mime:'application/pdf',
    kind:'pdf',
    size:outAb.byteLength,
    createdAt:Date.now(),
    data:outAb.slice(0)
  });

  const meta={id:fid,name:fname,mime:'application/pdf',kind:'pdf',size:outAb.byteLength,createdAt:Date.now()};
  const inserted=await fromRecord(meta,outAb.slice(0));
  inserted.forEach(e=>{ e.selected=true; });

  revoke(removed);
  S.entries=S.entries.filter(e=>!selectedEntryIds.has(e.id));
  S.entries.splice(firstIdx,0,...inserted);
  S.wsLastSelIdx=firstIdx;

  await cleanOrphans();
  renderAll();
}

async function runWsSpread(mode){
  const selectedRows=S.entries.map((e,idx)=>({e,idx})).filter(x=>x.e.selected).sort((a,b)=>a.idx-b.idx);
  if(!selectedRows.length){ msg(U.wsMsg,'対象ページを選択してください'); return; }
  if(mode==='merge' && selectedRows.length<2){ msg(U.wsMsg,'見開き結合は2ページ以上選択してください'); return; }
  if(selectedRows.some(x=>x.e.fileType!=='pdf')){ msg(U.wsMsg,'見開き分割/結合はPDFページのみ対応です'); return; }

  setWsExportBusy(true);
  prog(U.wsProg,U.wsFill,true,0);
  msg(U.wsMsg,mode==='split'?'見開き分割を開始...':'見開き結合を開始...');

  try{
    const selectedEntries=selectedRows.map(x=>x.e);
    const {files,transfers}=await resolveFilesForEntries(selectedEntries);
    const payload={
      mode,
      direction:(U.wsSpreadDir?.value==='left-to-right'?'left-to-right':'right-to-left'),
      cover:(U.wsMergeCover?.value==='pair'?'pair':'standalone'),
      entries:selectedEntries.map(e=>({fileId:e.fileId,fileType:e.fileType,pageIndex:e.pageIndex,rotation:e.rotation||0})),
      files
    };

    const out=await WK.call('spread',payload,{
      transfer:transfers,
      onP:(pc,m)=>{ prog(U.wsProg,U.wsFill,true,pc); msg(U.wsMsg,'処理中 '+pc+'% '+(m||'')); }
    });

    await replaceSelectionWithGeneratedPdf(selectedRows,out,mode==='split'?'split':'spread');
    msg(U.wsMsg,mode==='split'?'見開き分割が完了しました':'見開き結合が完了しました');
  }catch(e){
    console.error(e);
    msg(U.wsMsg,'エラー: '+(e?.message||e));
  }finally{
    prog(U.wsProg,U.wsFill,false,0);
    setWsExportBusy(false);
  }
}

function classifyUploadFile(file){
  const type=String(file?.type||'').toLowerCase();
  const name=String(file?.name||'').toLowerCase();
  if(type==='application/pdf' || name.endsWith('.pdf')) return {mime:'application/pdf',kind:'pdf'};
  if(type==='image/jpeg' || /\.jpe?g$/.test(name)) return {mime:'image/jpeg',kind:'image'};
  if(type==='image/png' || name.endsWith('.png')) return {mime:'image/png',kind:'image'};
  return null;
}

const standaloneTools=createStandaloneTools({classifyUploadFile});

async function validateUploadData(file,classified,data){
  if(file.size>LIMITS.maxFileBytes){
    throw new Error('1ファイルは'+Math.round(LIMITS.maxFileBytes/1048576)+'MB以内にしてください');
  }
  if(classified.kind==='pdf'){
    const loadingTask=pdfjsLib.getDocument(pdfLoadParams(data));
    let doc=null;
    try{
      doc=await loadingTask.promise;
      if(doc.numPages>LIMITS.maxWorkspacePages){
        throw new Error('PDFは'+LIMITS.maxWorkspacePages+'ページ以内に分割して追加してください');
      }
      return doc.numPages;
    }finally{
      if(doc && typeof doc.destroy==='function') try{ await doc.destroy(); }catch{}
      else if(typeof loadingTask.destroy==='function') try{ await loadingTask.destroy(); }catch{}
    }
  }
  if(typeof createImageBitmap==='function'){
    const bitmap=await createImageBitmap(new Blob([data],{type:classified.mime}));
    try{ assertCanvasBudget(bitmap.width,bitmap.height,'画像'); }
    finally{ try{ bitmap.close(); }catch{} }
  }
  return 1;
}

async function upload(list){
  const candidates=Array.from(list||[]).map(file=>({file,classified:classifyUploadFile(file)})).filter(x=>x.classified);
  if(!candidates.length){ msg(U.wsMsg,'PDF / JPG / PNG を選択してください'); return; }
  if(candidates.length>LIMITS.maxUploadFiles){
    msg(U.wsMsg,'一度に追加できるのは'+LIMITS.maxUploadFiles+'ファイルまでです。分けて追加してください。');
    return;
  }

  let workspaceBytes=S.meta.reduce((n,m)=>n+(Number(m.size)||0),0);
  let workspacePages=S.entries.length;
  let saved=0;
  const failures=[];
  msg(U.wsMsg,'検証して保存中...');

  for(const {file,classified} of candidates){
    try{
      if(workspaceBytes+file.size>LIMITS.maxWorkspaceBytes){
        throw new Error('保存合計は'+Math.round(LIMITS.maxWorkspaceBytes/1048576)+'MB以内にしてください');
      }
      if(navigator.storage?.estimate){
        const estimate=await navigator.storage.estimate();
        if(estimate.quota && (Number(estimate.usage)||0)+file.size>estimate.quota*0.9){
          throw new Error('ブラウザの保存容量が不足しています。不要な保存ファイルを削除してください');
        }
      }
      const data=await file.arrayBuffer();
      const pageCount=await validateUploadData(file,classified,data);
      if(workspacePages+pageCount>LIMITS.maxWorkspacePages){
        throw new Error('ワークスペースは合計'+LIMITS.maxWorkspacePages+'ページ以内にしてください');
      }
      await DBI.put({
        id:uid(),name:file.name,mime:classified.mime,kind:classified.kind,size:file.size,
        createdAt:Date.now(),data
      });
      workspaceBytes+=file.size;
      workspacePages+=pageCount;
      saved++;
    }catch(e){
      console.error(e);
      failures.push(file.name+': '+(e?.message||e));
    }
  }

  await refreshMeta();
  if(saved) await rebuild();
  if(failures.length){
    msg(U.wsMsg,'読み込み '+saved+'件 / 失敗 '+failures.length+'件: '+failures[0]);
  }else{
    msg(U.wsMsg,'読み込み完了（'+saved+'件）');
  }
}

function getMarginScale(){
  const n=Number(U.opMarScaleInput.value);
  return clamp(Number.isFinite(n)?n:100,30,200)/100;
}

function getPageNumberEnd(){
  const n=parseInt(U.opPnPrintEnd.value,10);
  if(Number.isFinite(n)&&n>0) return n;
  return 0;
}

async function buildWsPdfBuffer(target,onProgress){
  const {files,transfers}=await resolveFilesForEntries(target);
  const payload={
    entries:target.map(e=>({fileId:e.fileId,fileType:e.fileType,pageIndex:e.pageIndex,rotation:e.rotation||0})),
    files,
    options:{
      marginEnabled:(U.opMar.checked || Math.abs(getMarginScale()-1)>0.0001),
      marginScale:getMarginScale(),
      pageNumbers:U.opPn.checked,
      pageNumberPrintStart:Math.max(1,parseInt(U.opPnPrintStart.value,10)||1),
      pageNumberPrintEnd:getPageNumberEnd(),
      pageNumberSeed:Math.max(1,parseInt(U.opPnSeed.value,10)||1),
      pageNumberPosition:U.opPnPos.value,
      pageNumberFont:U.opPnFont.value,
      pageNumberSize:clamp(Number(U.opPnSize.value)||12,6,240),
      pageNumberOffsetX:Number(U.opPnOffX.value)||0,
      pageNumberOffsetY:Number(U.opPnOffY.value)||0
    }
  };

  return await WK.call('ws',payload,{
    transfer:transfers,
    onP:(pc,m)=>{ if(typeof onProgress==='function') onProgress(pc,m); }
  });
}

const {
  getRasterSelectedRows,
  getRasterOptions,
  renderRasterSelectionInfo,
  applyRasterPixelFilters,
  clearRasterPreviewCanvas,
  scheduleRasterPreview,
  renderRasterPreview,
  runRasterOptimizeSelected
}=createRasterTools({
  buildWsPdfBuffer,
  replaceSelectionWithGeneratedPdf,
  setWsExportBusy
});

async function exportWs(selectedOnly){
  const target=selectedOnly?S.entries.filter(e=>e.selected):S.entries.slice();
  if(!target.length){ msg(U.wsMsg,'出力対象ページがありません'); return; }

  setWsExportBusy(true);
  prog(U.wsProg,U.wsFill,true,0);
  msg(U.wsMsg,'IndexedDB読込中...');

  try{
    const out=await buildWsPdfBuffer(target,(pc,m)=>{ prog(U.wsProg,U.wsFill,true,pc); msg(U.wsMsg,'処理中 '+pc+'% '+(m||'')); });
    dl(new Blob([out],{type:'application/pdf'}),base(target[0]?.fileName||'workspace')+(selectedOnly?'_selected':'_merged')+'.pdf');
    msg(U.wsMsg,'保存完了');
  }catch(e){
    console.error(e);
    msg(U.wsMsg,'エラー: '+(e?.message||e));
  }finally{
    prog(U.wsProg,U.wsFill,false,0);
    setWsExportBusy(false);
  }
}

async function exportWsImages(selectedOnly){
  const target=selectedOnly?S.entries.filter(e=>e.selected):S.entries.slice();
  if(!target.length){ msg(U.wsMsg,'出力対象ページがありません'); return; }

  setWsExportBusy(true);
  prog(U.wsProg,U.wsFill,true,0);
  msg(U.wsMsg,'IndexedDB読込中...');

  let pdfDoc=null;
  try{
    const out=await buildWsPdfBuffer(target,(pc,m)=>{ const p=Math.round(pc*0.55); prog(U.wsProg,U.wsFill,true,p); msg(U.wsMsg,'PDF生成中 '+pc+'% '+(m||'')); });

    msg(U.wsMsg,'画像化準備中...');
    pdfDoc=await pdfjsLib.getDocument(pdfLoadParams(out)).promise;
    const total=pdfDoc.numPages;
    if(total<1) throw new Error('画像化対象ページがありません');

    const baseName=base(target[0]?.fileName||'workspace')+(selectedOnly?'_selected':'_merged');

    if(total===1){
      const p=await pdfDoc.getPage(1);
      const v=p.getViewport({scale:2.0});
      assertCanvasBudget(v.width,v.height,'画像保存');
      const cvs=document.createElement('canvas');
      const ctx=cvs.getContext('2d',{willReadFrequently:true});
      cvs.width=v.width;
      cvs.height=v.height;
      await p.render({canvasContext:ctx,viewport:v,background:'white'}).promise;
      const blob=await canvasToBlobSafe(cvs,'image/png');
      dl(blob,baseName+'_p001.png');
      msg(U.wsMsg,'画像保存完了');
      return;
    }

    let zip=null;
    try{
      const ZipCtor=await ensureJSZip();
      zip=new ZipCtor();
    }catch(e){
      console.warn(e);
      msg(U.wsMsg,'ZIPライブラリ未読込のため、各ページ画像を個別保存します...');
    }

    for(let i=1;i<=total;i++){
      msg(U.wsMsg,i+'/'+total+' ページを画像化中...');
      const p=await pdfDoc.getPage(i);
      const v=p.getViewport({scale:2.0});
      assertCanvasBudget(v.width,v.height,'画像保存');
      const cvs=document.createElement('canvas');
      const ctx=cvs.getContext('2d',{willReadFrequently:true});
      cvs.width=v.width;
      cvs.height=v.height;
      await p.render({canvasContext:ctx,viewport:v,background:'white'}).promise;
      const blob=await canvasToBlobSafe(cvs,'image/png');
      const fn=baseName+'_'+String(i).padStart(3,'0')+'.png';
      if(zip) zip.file(fn,blob); else dl(blob,fn);
      prog(U.wsProg,U.wsFill,true,55+Math.round((i/total)*35));
      cvs.width=1;
      cvs.height=1;
    }

    if(zip){
      msg(U.wsMsg,'ZIP作成中...');
      const zipBlob=await zip.generateAsync({type:'blob'},meta=>{
        prog(U.wsProg,U.wsFill,true,90+Math.round((meta.percent||0)*0.1));
      });
      dl(zipBlob,baseName+'_images.zip');
      msg(U.wsMsg,'画像ZIP保存完了');
    }else{
      msg(U.wsMsg,'画像個別保存完了');
    }
  }catch(e){
    console.error(e);
    msg(U.wsMsg,'エラー: '+(e?.message||e));
  }finally{
    try{ if(pdfDoc&&pdfDoc.cleanup) pdfDoc.cleanup(); }catch{}
    try{ if(pdfDoc&&pdfDoc.destroy) await pdfDoc.destroy(); }catch{}
    prog(U.wsProg,U.wsFill,false,0);
    setWsExportBusy(false);
  }
}

async function clearDb(){
  if(!confirm('IndexedDB内の保存ファイルを全削除します。よろしいですか？'))return;
  msg(U.dgMsg,'削除中...');

  try{
    revoke(S.entries);
    S.entries=[];
    S.stampsByFile={};

    if(S.stDoc) try{await S.stDoc.destroy();}catch{}
    S.stDoc=null;
    S.stFileId=null;
    S.stBytes=null;
    U.stCanvas.width=0; U.stCanvas.height=0;
    U.stPage.textContent='- / -';

    await DBI.clear();
    await refreshMeta();
    resetWsHistory();
    renderAll();

    msg(U.dgMsg,'削除完了');
    msg(U.wsMsg,'');
    msg(U.stMsg,'');
  }catch(e){
    console.error(e);
    msg(U.dgMsg,'エラー: '+(e?.message||e));
  }
}

function syncMarginFromSelect(){
  if(U.opMarScale.value!=='custom') U.opMarScaleInput.value=U.opMarScale.value;
}

function switchMainTab(mode,opt={}){
  const k=(mode==='c-ocr'||mode==='c-src'||mode==='c-qr')?mode:'ws';
  S.mainTab=k;

  U.tabs.forEach(btn=>btn.classList.toggle('active',btn.dataset.tab===k));

  U.panels.ws.classList.toggle('active',k==='ws');
  U.panels.cOcr.classList.toggle('active',k==='c-ocr');
  U.panels.cSrc.classList.toggle('active',k==='c-src');
  U.panels.cQr.classList.toggle('active',k==='c-qr');

  if(k!=='ws'){
    setInternalPanel('none',{scroll:false});
  }else{
    setInternalPanel(S.wsInternalMode||'none',{scroll:false,keepMode:true});
  }

  if(opt.scroll===false) return;
  const target = k==='ws' ? U.panels.ws : (k==='c-ocr' ? U.panels.cOcr : (k==='c-src' ? U.panels.cSrc : U.panels.cQr));
  target?.scrollIntoView({behavior:'smooth',block:'start'});
}

function setInternalPanel(mode,opt={}){
  const m=(mode==='st'||mode==='rs'||mode==='dg')?mode:'none';
  if(!opt.keepMode) S.wsInternalMode=m;

  const on=(S.mainTab==='ws');
  const stOn = on && m==='st';
  const rsOn = on && m==='rs';
  const dgOn = on && m==='dg';

  U.panels.st.classList.toggle('active',stOn);
  U.panels.rs.classList.toggle('active',rsOn);
  U.panels.dg.classList.toggle('active',dgOn);

  if(opt.scroll===false) return;
  if(stOn) U.panels.st.scrollIntoView({behavior:'smooth',block:'start'});
  if(rsOn) U.panels.rs.scrollIntoView({behavior:'smooth',block:'start'});
  if(dgOn) U.panels.dg.scrollIntoView({behavior:'smooth',block:'start'});
}

function returnToWorkspace(){
  switchMainTab('ws',{scroll:false});
  setInternalPanel('none',{scroll:false});
  U.panels.ws.scrollIntoView({behavior:'smooth',block:'start'});
}

function syncMarginFromInput(){
  const v=Math.round(clamp(Number(U.opMarScaleInput.value)||100,30,200));
  U.opMarScaleInput.value=String(v);
  const presets=['80','90','100','110','120'];
  U.opMarScale.value=presets.includes(String(v))?String(v):'custom';
}

function setWsAdvancedToolbar(open,opt={}){
  const persist = opt.persist!==false;
  const adv = U.wsToolbarAdvanced;
  const tgl = U.wsAdvToggle;
  if(!adv || !tgl) return;

  if(!isWsToolbarMobile()){
    adv.hidden = false;
    tgl.setAttribute('aria-expanded','true');
    tgl.textContent = '詳細';
    tgl.title = '詳細ツール';
    if(persist){
      try{ localStorage.setItem(WS_ADV_KEY,'1'); }catch{}
    }
    return;
  }

  const isOpen = !!open;
  adv.hidden = !isOpen;
  tgl.setAttribute('aria-expanded',String(isOpen));
  tgl.textContent = isOpen ? '詳細を隠す' : '詳細を表示';
  tgl.title = isOpen ? '詳細ツールを隠す' : '詳細ツールを表示';
  if(persist){
    try{ localStorage.setItem(WS_ADV_KEY,isOpen?'1':'0'); }catch{}
  }
}

function restoreWsAdvancedToolbar(){
  if(!isWsToolbarMobile()){
    setWsAdvancedToolbar(true,{persist:false});
    return;
  }
  let open = false;
  try{
    const v = localStorage.getItem(WS_ADV_KEY);
    if(v==='1') open = true;
    else if(v==='0') open = false;
    else open = false;
  }catch{}
  setWsAdvancedToolbar(open,{persist:false});
}
function openAppManual(){
  if(!U.manualModal) return;
  U.manualModal.classList.add('show');
  U.manualModal.setAttribute('aria-hidden','false');
  document.body.classList.add('manual-open');
}
function closeAppManual(){
  if(!U.manualModal) return;
  U.manualModal.classList.remove('show');
  U.manualModal.setAttribute('aria-hidden','true');
  document.body.classList.remove('manual-open');
}

function bind(){
  U.tabs.forEach(t=>t.addEventListener('click',()=>switchMainTab(t.dataset.tab||'ws',{scroll:false})));

  U.drop.addEventListener('click',()=>U.inFile.click());
  U.drop.addEventListener('dragover',e=>{e.preventDefault();U.drop.classList.add('drag');});
  U.drop.addEventListener('dragleave',()=>U.drop.classList.remove('drag'));
  U.drop.addEventListener('drop',e=>{e.preventDefault();U.drop.classList.remove('drag');void upload(e.dataTransfer.files);});
  U.inFile.addEventListener('change',e=>{void upload(e.target.files);e.target.value='';});

  standaloneTools.bind();
  U.manualOpen?.addEventListener('click',()=>openAppManual());
  U.manualClose?.addEventListener('click',()=>closeAppManual());
  U.manualModal?.addEventListener('click',(e)=>{
    if(e.target===U.manualModal || e.target?.dataset?.a==='close') closeAppManual();
  });

  U.wsUndo?.addEventListener('click',()=>undoWs());
  U.wsRedo?.addEventListener('click',()=>redoWs());
  U.wsSnackUndo?.addEventListener('click',()=>{ undoWs(); hideWsSnack(true); });
  U.wsPreviewClose?.addEventListener('click',()=>closeWsPreview());
  U.wsPreviewModal?.addEventListener('click',(e)=>{
    if(e.target===U.wsPreviewModal || e.target?.dataset?.a==='close') closeWsPreview();
  });
  U.wsAdvToggle?.addEventListener('click',()=>{
    const willOpen = !!U.wsToolbarAdvanced?.hidden;
    setWsAdvancedToolbar(willOpen);
  });
  U.wsEntryMenu?.addEventListener('click',(ev)=>{
    const btn=ev.target.closest('button[data-a]');
    if(!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    const entryId=U.wsEntryMenu.dataset.entryId||'';
    const a=btn.dataset.a||'';
    wsCloseEntryMenu();
    if(!entryId || !a) return;
    wsApplyEntryAction(entryId,a);
  });
  document.addEventListener('pointerdown',(ev)=>{
    const menu=U.wsEntryMenu;
    if(!menu || menu.hidden) return;
    if(ev.target.closest('#ws-entry-menu')) return;
    if(ev.target.closest('.qa-more')) return;
    wsCloseEntryMenu();
  },true);
  window.addEventListener('resize',()=>wsCloseEntryMenu());
  const wsMq = window.matchMedia('(max-width:980px)');
  const onWsMqChange = ()=>restoreWsAdvancedToolbar();
  if(wsMq.addEventListener) wsMq.addEventListener('change',onWsMqChange);
  else if(wsMq.addListener) wsMq.addListener(onWsMqChange);

  document.addEventListener('keydown',(e)=>{
    if(e.key==='Escape' && U.manualModal?.classList.contains('show')){
      e.preventDefault();
      closeAppManual();
      return;
    }
    if(e.key==='Escape' && U.wsEntryMenu && !U.wsEntryMenu.hidden){
      e.preventDefault();
      wsCloseEntryMenu();
      return;
    }
    if(e.key==='Escape' && U.wsPreviewModal?.classList.contains('show')){
      e.preventDefault();
      closeWsPreview();
      return;
    }
    if(S.mainTab!=='ws') return;
    const ae=document.activeElement;
    if(ae && (ae.tagName==='INPUT' || ae.tagName==='TEXTAREA' || ae.tagName==='SELECT' || ae.isContentEditable)) return;

    const k=String(e.key||'').toLowerCase();
    const previewOpen = !!U.wsPreviewModal?.classList.contains('show');

    if(k==='delete' || k==='backspace'){
      if(previewOpen) return;
      if(!S.entries.some(x=>x.selected)) return;
      e.preventDefault();
      U.wsDelSel?.click();
      return;
    }

    const ctrlOrMeta = e.ctrlKey || e.metaKey;
    if(!ctrlOrMeta) return;

    if(k==='a'){
      if(!S.entries.length) return;
      e.preventDefault();
      U.wsSelAll?.click();
      return;
    }

    if(k==='z' && !e.shiftKey){
      e.preventDefault();
      undoWs();
      return;
    }
    if(k==='y' || (k==='z' && e.shiftKey)){
      e.preventDefault();
      redoWs();
    }
  });

  U.wsSelAll.addEventListener('click',()=>{
    const changed=wsMutate('select_all',()=>{
      S.entries.forEach(e=>e.selected=true);
      S.selectionAnchorIndex=S.entries.length?0:-1;
      S.wsLastSelIdx=S.selectionAnchorIndex;
    });
    if(changed) updateSelectionUI();
    else updateHistoryButtons();
  });

  U.wsSelNone.addEventListener('click',()=>{
    const changed=wsMutate('select_none',()=>{
      S.entries.forEach(e=>e.selected=false);
      S.selectionAnchorIndex=-1;
      S.wsLastSelIdx=-1;
    });
    if(changed) updateSelectionUI();
    else updateHistoryButtons();
  });

  U.wsRotSel.addEventListener('click',()=>{
    const count=S.entries.filter(e=>e.selected).length;
    if(!count) return;
    const changed=wsMutate('rotate_selected',()=>{
      S.entries.filter(e=>e.selected).forEach(e=>{ e.rotation=normRot((Number(e.rotation)||0)+90); });
    });
    if(changed){
      showWsSnack(count+'ページを回転しました',{undo:true});
      renderWs();
    }else updateHistoryButtons();
  });

  U.wsDelSel.addEventListener('click',()=>{
    const count=S.entries.filter(e=>e.selected).length;
    if(!count) return;
    const changed=wsMutate('delete_selected',()=>{
      const prevEntries=S.entries.slice();
      S.entries=S.entries.filter(e=>!e.selected);
      wsSyncAnchorAfterReorder(prevEntries,S.entries);
    });
    if(changed){
      showWsSnack(count+'ページを削除しました',{undo:true});
      renderAll();
    }else updateHistoryButtons();
  });

  U.wsExpAll.addEventListener('click',()=>void exportWs(false));
  U.wsExpSel.addEventListener('click',()=>void exportWs(true));
  U.wsExpImgAll?.addEventListener('click',()=>void exportWsImages(false));
  U.wsExpImgSel?.addEventListener('click',()=>void exportWsImages(true));
  U.wsSplit?.addEventListener('click',()=>void runWsSpread('split'));
  U.wsMerge?.addEventListener('click',()=>void runWsSpread('merge'));

  U.wsToolSt?.addEventListener('click',()=>{
    switchMainTab('ws',{scroll:false});
    const open = !U.panels.st.classList.contains('active');
    setInternalPanel(open ? 'st' : 'none');
  });
  U.wsToolRs?.addEventListener('click',()=>{
    switchMainTab('ws',{scroll:false});
    const open = !U.panels.rs.classList.contains('active');
    setInternalPanel(open ? 'rs' : 'none');
    if(open){
      renderRasterSelectionInfo();
      void renderRasterPreview();
    }else{
      clearRasterPreviewCanvas('');
    }
  });
  U.wsToolDg?.addEventListener('click',()=>{
    switchMainTab('ws',{scroll:false});
    const open = !U.panels.dg.classList.contains('active');
    setInternalPanel(open ? 'dg' : 'none');
  });
  U.wsToolClose?.addEventListener('click',()=>returnToWorkspace());
  U.stBackWs?.addEventListener('click',()=>returnToWorkspace());
  U.rsBackWs?.addEventListener('click',()=>returnToWorkspace());
  U.dgBackWs?.addEventListener('click',()=>returnToWorkspace());

  U.rsRun?.addEventListener('click',()=>void runRasterOptimizeSelected());
  U.rsPrevRefresh?.addEventListener('click',()=>void renderRasterPreview());
  [U.rsCompress,U.rsScale,U.rsQuality,U.rsGray,U.rsWhiten,U.rsWhite,U.rsBlack].forEach(el=>{
    if(!el) return;
    el.addEventListener('change',()=>scheduleRasterPreview(180));
    if(el.tagName==='INPUT' && (el.type==='number' || el.type==='range')){
      el.addEventListener('input',()=>scheduleRasterPreview(180));
    }
  });

  U.opMarScale.addEventListener('change',syncMarginFromSelect);
  U.opMarScaleInput.addEventListener('change',syncMarginFromInput);

  U.stLoad.addEventListener('click',()=>void loadStamp());
  U.stPrev.addEventListener('click',()=>{ if(!S.stDoc)return; S.stPage=Math.max(1,S.stPage-1); void renderStampPage(); });
  U.stNext.addEventListener('click',()=>{ if(!S.stDoc)return; S.stPage=Math.min(S.stDoc.numPages,S.stPage+1); void renderStampPage(); });
  U.stPageGo?.addEventListener('click',()=>jumpStampPage());
  U.stPageInput?.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); jumpStampPage(); }});

  U.stOverlay.addEventListener('click',e=>{
    if(e.target!==U.stOverlay) return;
    const r=U.stOverlay.getBoundingClientRect();
    const x=e.clientX-r.left;
    const y=e.clientY-r.top;
    S.stPt={x:clamp(x/U.stCanvas.width,0,1),y:clamp(y/U.stCanvas.height,0,1)};
    renderStPoint();
    renderStampOverlay();
  });

  U.stAddText.addEventListener('click',()=>{
    if(!S.stFileId)return;
    const t=U.stText.value.trim();
    if(!t){msg(U.stMsg,'テキストを入力してください');return;}
    addTextStamp(t,U.stColor.value,Number(U.stSize.value)||24,Number(U.stOp.value)||1);
  });

  document.querySelectorAll('.preset-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      if(!S.stFileId){msg(U.stMsg,'先にPDFを読み込んでください');return;}
      const text=btn.dataset.text||'社外秘';
      const color=btn.dataset.color||'#d00000';
      addTextStamp(text,color,Math.max(8,Number(U.stSize.value)||24),Number(U.stOp.value)||1);
    });
  });

  U.stAddMask.addEventListener('click',()=>{
    if(!S.stFileId){msg(U.stMsg,'先にPDFを読み込んでください');return;}
    addMaskStamp();
  });

  U.stClear.addEventListener('click',()=>{
    if(!S.stFileId)return;
    S.stampsByFile[S.stFileId]=[];
    renderStampList();
    renderStampOverlay();
  });
  U.stApply.addEventListener('click',()=>void applySt());

  U.dgRebuild.addEventListener('click',()=>void rebuild());
  U.dgClear.addEventListener('click',()=>void clearDb());

  window.addEventListener('beforeunload',()=>{ try{revoke(S.entries);}catch{} });
}

async function init(){
  bind();
  restoreWsAdvancedToolbar();
  syncMarginFromInput();
  standaloneTools.resetInitialState();
  switchMainTab('ws',{scroll:false});
  setInternalPanel('none',{scroll:false});
  await refreshMeta();
  if(S.meta.length) await rebuild();
  renderAll();
  resetWsHistory(true);
  renderStPoint();
}

init().catch(e=>{ console.error(e); alert('初期化失敗: '+(e?.message||e)); });
})();
