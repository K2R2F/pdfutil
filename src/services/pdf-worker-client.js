import { clamp } from '../core/utils.js';

export class PdfWorkerClient{
  constructor(){
    this.seq=0;
    this.pending=new Map();
    this.defaultTimeout=600000;
    this.w=null;
    this.startPromise=null;
    this.start().catch(()=>{});
  }

  start(){
    if(this.w) return Promise.resolve(this.w);
    if(this.startPromise) return this.startPromise;
    this.startPromise=this.mk().then(worker=>{
      this.w=worker;
      worker.onmessage=(e)=>this.on(e.data);
      worker.onerror=(e)=>this.failWorker(e?.message||'worker error');
      worker.onmessageerror=()=>this.failWorker('worker message error');
      return worker;
    }).finally(()=>{ this.startPromise=null; });
    return this.startPromise;
  }

  async verifiedScript(url,expected){
    const response=await fetch(url,{mode:'cors',cache:'force-cache'});
    if(!response.ok) throw new Error('内部PDF処理ライブラリを取得できません: '+response.status);
    const bytes=await response.arrayBuffer();
    const digest=await crypto.subtle.digest('SHA-384',bytes);
    const actual=btoa(String.fromCharCode(...new Uint8Array(digest)));
    if(actual!==expected) throw new Error('内部PDF処理ライブラリの整合性を確認できません');
    return bytes;
  }

  async mk(){
    const [pdfLibSource,fontkitSource]=await Promise.all([
      this.verifiedScript('https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js','weMABwrltA6jWR8DDe9Jp5blk+tZQh7ugpCsF3JwSA53WZM9/14PjS5LAJNHNjAI'),
      this.verifiedScript('https://unpkg.com/@pdf-lib/fontkit@0.0.4/dist/fontkit.umd.min.js','9fpcLcBAZkqk+tKJTXAJP07DQZjk71P7bFnOntCqIJiQBn3c3SouYLr2NUZcK83A')
    ]);
    const src=`
const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;
const FONT_URLS = [
  'https://cdn.jsdelivr.net/npm/typeface-mplus-1p@0.1.63/fonts/mplus-1p-regular.ttf'
];
let FONT_BUF = null;

const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));
const normRot = (d)=>{ const n=((Number(d)||0)%360+360)%360; return n-(n%90); };
const toAB = (v)=>{
  if(v instanceof ArrayBuffer) return v;
  if(ArrayBuffer.isView(v)) return v.buffer.slice(v.byteOffset,v.byteOffset+v.byteLength);
  throw new Error('bad binary');
};
const hexToRgb01 = (h)=>{
  const s=String(h||'').replace('#','');
  if(!/^[0-9a-fA-F]{6}$/.test(s)) return [0,0,0];
  return [parseInt(s.slice(0,2),16)/255,parseInt(s.slice(2,4),16)/255,parseInt(s.slice(4,6),16)/255];
};

async function ensureCustomFont(doc, strict){
  if(typeof fontkit!=='undefined' && doc.registerFontkit) doc.registerFontkit(fontkit);
  if(!FONT_BUF){
    for(const url of FONT_URLS){
      try{
        const r=await fetch(url);
        if(!r.ok) continue;
        FONT_BUF=await r.arrayBuffer();
        break;
      }catch{}
    }
  }
  if(FONT_BUF) return await doc.embedFont(FONT_BUF,{subset:true});
  if(strict) throw new Error('japanese font download failed');
  return await doc.embedFont(StandardFonts.Helvetica);
}

async function pickStandardFont(doc,name){
  if(name==='times') return await doc.embedFont(StandardFonts.TimesRoman);
  if(name==='courier') return await doc.embedFont(StandardFonts.Courier);
  return await doc.embedFont(StandardFonts.Helvetica);
}

async function safeEmbedPage(outDoc, srcDoc, srcBytes, pageIndex){
  const count = srcDoc.getPageCount?.() ?? 0;
  if(!count) throw new Error('source has no pages');
  const idx = Math.max(0, Math.min(count-1, Number(pageIndex)||0));

  let temp = -1;
  try{
    const [copied] = await outDoc.copyPages(srcDoc,[idx]);
    outDoc.addPage(copied);
    temp = outDoc.getPageCount()-1;
    return await outDoc.embedPage(outDoc.getPage(temp));
  }finally{
    if(temp>=0 && temp<outDoc.getPageCount()){
      try{ outDoc.removePage(temp); }catch{}
    }
  }
}

function report(req,pc,msg){ postMessage({type:'p',req,pc,msg}); }

async function opWS(req,pay){
  const entries = Array.isArray(pay.entries)?pay.entries:[];
  const files = Array.isArray(pay.files)?pay.files:[];
  const opt = pay.options || {};
  if(!entries.length) throw new Error('no entries');

  const out = await PDFDocument.create();
  const pdfCache = new Map();
  const fileMap = new Map();
  for(const f of files) fileMap.set(f.id,{id:f.id,mime:f.mime,kind:f.kind,data:toAB(f.data)});

  const marginEnabled = !!opt.marginEnabled;
  const marginScale = clamp(Number(opt.marginScale)||1,0.3,2.0);

  const pnEnabled = !!opt.pageNumbers;
  const pnPrintStart = Math.max(1, Number(opt.pageNumberPrintStart)||1);
  const pnPrintEndRaw = Number(opt.pageNumberPrintEnd)||0;
  const pnPrintEnd = pnPrintEndRaw>0 ? pnPrintEndRaw : Number.POSITIVE_INFINITY;
  const pnPos = opt.pageNumberPosition || 'bottom-center';
  const pnFontName = opt.pageNumberFont || 'helvetica';
  const pnSize = clamp(Number(opt.pageNumberSize)||12,6,240);
  const pnOffX = Number(opt.pageNumberOffsetX)||0;
  const pnOffY = Number(opt.pageNumberOffsetY)||0;
  const pnFont = pnEnabled ? await pickStandardFont(out,pnFontName) : null;
  let pnCurrent = Math.max(1, Number(opt.pageNumberSeed)||1);

  function getPlacement(srcW,srcH,rot,scale){
    const r = normRot(rot);
    const outW = (r===90||r===270)?srcH:srcW;
    const outH = (r===90||r===270)?srcW:srcH;
    const s = Number.isFinite(scale)?scale:1;
    const dw = srcW*s;
    const dh = srcH*s;
    const boxW = (r===90||r===270)?dh:dw;
    const boxH = (r===90||r===270)?dw:dh;
    const bx = (outW-boxW)/2;
    const by = (outH-boxH)/2;

    let x = bx;
    let y = by;
    if(r===90){ x = bx + dh; y = by; }
    else if(r===180){ x = bx + dw; y = by + dh; }
    else if(r===270){ x = bx; y = by + dw; }

    return {outW,outH,x,y,width:dw,height:dh,rot:r};
  }

  let exportedCount = 0;
  for(let i=0;i<entries.length;i++){
    const entry = entries[i];
    const file = fileMap.get(entry.fileId);
    if(!file) throw new Error('missing source file for entry '+(i+1)+' (fileId='+(entry.fileId||'')+')');

    const userRot = normRot(Number(entry.rotation)||0);
    const drawRotUser = normRot(360 - userRot);
    const drawScale = marginEnabled ? marginScale : 1;
    let page;

    if(entry.fileType==='image' || String(file.mime||'').toLowerCase().startsWith('image/')){
      const mime = String(file.mime||'').toLowerCase();
      const img = mime.includes('png') ? await out.embedPng(file.data) : await out.embedJpg(file.data);
      const pl = getPlacement(img.width,img.height,drawRotUser,drawScale);
      page = out.addPage([pl.outW,pl.outH]);
      const optImg = {x:pl.x,y:pl.y,width:pl.width,height:pl.height};
      if(pl.rot!==0) optImg.rotate = degrees(pl.rot);
      page.drawImage(img,optImg);
    }else{
      if(!pdfCache.has(file.id)) pdfCache.set(file.id, await PDFDocument.load(file.data,{ignoreEncryption:true}));
      const src = pdfCache.get(file.id);
      const rawIdx = Number(entry.pageIndex);
      if(!Number.isInteger(rawIdx)) throw new Error('invalid page index for entry '+(i+1));
      const pageCount = src.getPageCount();
      if(rawIdx < 0 || rawIdx >= pageCount) throw new Error('page index out of range for entry '+(i+1)+' ('+rawIdx+'/'+pageCount+')');
      const srcIdx = rawIdx;
      const srcPage = src.getPage(srcIdx);
      const baseRot = normRot(srcPage.getRotation()?.angle || 0);
      const drawRotPdf = normRot(360 - userRot - baseRot);
      const emb = await safeEmbedPage(out,src,file.data,srcIdx);
      const pl = getPlacement(emb.width,emb.height,drawRotPdf,drawScale);
      page = out.addPage([pl.outW,pl.outH]);
      const optPg = {x:pl.x,y:pl.y,width:pl.width,height:pl.height};
      if(pl.rot!==0) optPg.rotate = degrees(pl.rot);
      page.drawPage(emb,optPg);
    }

    const outputPageNo = i + 1;
    if(pnEnabled && outputPageNo>=pnPrintStart && outputPageNo<=pnPrintEnd){
      const txt = String(pnCurrent++);
      const tw = pnFont.widthOfTextAtSize(txt,pnSize);
      const sz = page.getSize();
      const width = sz.width;
      const height = sz.height;

      let x = width/2 - tw/2;
      let y = 20;
      if(pnPos==='bottom-left'){ x = 28; y = 20; }
      else if(pnPos==='bottom-right'){ x = width - tw - 28; y = 20; }
      else if(pnPos==='top-left'){ x = 28; y = height - pnSize - 20; }
      else if(pnPos==='top-center'){ x = width/2 - tw/2; y = height - pnSize - 20; }
      else if(pnPos==='top-right'){ x = width - tw - 28; y = height - pnSize - 20; }

      page.drawText(txt,{x:x+pnOffX,y:y+pnOffY,size:pnSize,font:pnFont,color:rgb(0,0,0)});
    }

    exportedCount++;
    report(req,Math.round(((i+1)/entries.length)*100),(i+1)+'/'+entries.length);
  }

  if(exportedCount !== entries.length){
    throw new Error('page export count mismatch: '+exportedCount+'/'+entries.length);
  }

  const bytes = await out.save();
  const outAb = bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
  postMessage({type:'r',req,ok:true,data:outAb},[outAb]);
}

async function opST(req,pay){
  const pdfData = toAB(pay.pdfData);
  const stamps = Array.isArray(pay.stamps)?pay.stamps:[];

  const doc = await PDFDocument.load(pdfData,{ignoreEncryption:true});
  const needsTextFont=stamps.some(s=>s?.kind!=='mask' && String(s?.text||''));
  const customFont = needsTextFont ? await ensureCustomFont(doc,false) : null;

  for(let i=0;i<stamps.length;i++){
    const s = stamps[i];
    const pn = Math.max(1, Number(s.page)||1);
    if(pn>doc.getPageCount()) continue;

    const page = doc.getPage(pn-1);
    const size = page.getSize();
    const width = size.width;
    const height = size.height;

    if(s.kind==='mask'){
      const exact=s.pdfRect||{};
      const hasExact=[exact.x,exact.y,exact.width,exact.height].every(Number.isFinite) && exact.width>0 && exact.height>0;
      const wr = clamp(Number(s.widthRatio)||0.2,0.01,1);
      const hr = clamp(Number(s.heightRatio)||0.08,0.01,1);
      const x = hasExact ? Number(exact.x) : clamp(Number(s.xRatio)||0,0,1) * width;
      const rw = hasExact ? Number(exact.width) : wr * width;
      const rh = hasExact ? Number(exact.height) : hr * height;
      const yTop = clamp(Number(s.yRatio)||0,0,1) * height;
      const y = hasExact ? Number(exact.y) : height - yTop - rh;
      const [r,g,b] = hexToRgb01(s.color||'#ffffff');
      page.drawRectangle({
        x,
        y,
        width:rw,
        height:rh,
        color:rgb(r,g,b),
        opacity:clamp(Number(s.opacity)||1,0.05,1)
      });
    }else{
      const text = String(s.text||'');
      if(!text){
        report(req,Math.round(((i+1)/Math.max(1,stamps.length))*100),(i+1)+'/'+stamps.length);
        continue;
      }
      const fontSize = clamp(Number(s.size)||20,6,240);
      const opacity = clamp(Number(s.opacity)||1,0.05,1);
      const [r,g,b] = hexToRgb01(s.color||'#d00000');
      const x = clamp(Number(s.xRatio)||0,0,1) * width;
      const yTop = clamp(Number(s.yRatio)||0,0,1) * height;
      const y = height - yTop - fontSize;
      const rot = normRot(Number(s.rotation)||0);
      const drawOpt = {x,y,size:fontSize,font:customFont,color:rgb(r,g,b),opacity};
      if(rot!==0) drawOpt.rotate = degrees(rot);
      page.drawText(text,drawOpt);
    }

    report(req,Math.round(((i+1)/Math.max(1,stamps.length))*100),(i+1)+'/'+stamps.length);
  }

  const bytes = await doc.save();
  const outAb = bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
  postMessage({type:'r',req,ok:true,data:outAb},[outAb]);
}

async function opSP(req,pay){
  const spreadMetaPrefix = 'TSUKUE_TOOLBOX_SPREAD_V1:';
  const mode = String(pay.mode||'');
  const direction = pay.direction==='left-to-right' ? 'left-to-right' : 'right-to-left';
  const cover = pay.cover==='pair' ? 'pair' : 'standalone';
  const entries = Array.isArray(pay.entries)?pay.entries:[];
  const files = Array.isArray(pay.files)?pay.files:[];
  if(!entries.length) throw new Error('no entries');

  const out = await PDFDocument.create();
  const fileMap = new Map();
  const pdfCache = new Map();
  const spreadHintCache = new Map();
  for(const f of files) fileMap.set(f.id,{id:f.id,mime:f.mime,kind:f.kind,data:toAB(f.data)});

  function readSpreadHints(fileId,doc){
    if(spreadHintCache.has(fileId)) return spreadHintCache.get(fileId);
    let hints=null;
    try{
      const subject=String(doc.getSubject?.()||'');
      if(subject.startsWith(spreadMetaPrefix)){
        const parsed=JSON.parse(subject.slice(spreadMetaPrefix.length));
        if(parsed?.v===1 && Array.isArray(parsed.pages) && parsed.pages.length===doc.getPageCount()) hints=parsed.pages;
      }
    }catch{}
    spreadHintCache.set(fileId,hints);
    return hints;
  }

  function calcPlacement(srcW,srcH,rot){
    const r = normRot(rot);
    const outW = (r===90||r===270)?srcH:srcW;
    const outH = (r===90||r===270)?srcW:srcH;
    let x = 0;
    let y = 0;
    if(r===90){ x = srcH; }
    else if(r===180){ x = srcW; y = srcH; }
    else if(r===270){ y = srcW; }
    return {outW,outH,x,y,width:srcW,height:srcH,rot:r};
  }

  async function prepareEntry(entry){
    if(entry.fileType!=='pdf') throw new Error('spread supports pdf entries only');
    const file = fileMap.get(entry.fileId);
    if(!file) throw new Error('missing source file for spread');
    if(!pdfCache.has(file.id)) pdfCache.set(file.id, await PDFDocument.load(file.data,{ignoreEncryption:true}));
    const src = pdfCache.get(file.id);
    const rawIdx = Number(entry.pageIndex);
    if(!Number.isInteger(rawIdx)) throw new Error('invalid page index for spread');
    const pageCount = src.getPageCount();
    if(rawIdx < 0 || rawIdx >= pageCount) throw new Error('page index out of range for spread');
    const srcPage = src.getPage(rawIdx);
    const baseRot = normRot(srcPage.getRotation()?.angle || 0);
    const userRot = normRot(Number(entry.rotation)||0);
    const drawRot = normRot(360 - userRot - baseRot);
    const emb = await safeEmbedPage(out,src,file.data,rawIdx);
    const pl = calcPlacement(emb.width,emb.height,drawRot);
    const hints=readSpreadHints(file.id,src);
    return {emb,pl,srcPage,splitHint:hints?.[rawIdx]||null};
  }

  function drawPrepared(targetPage,prepared,offsetX){
    const pl = prepared.pl;
    const opt = {x:offsetX+pl.x,y:pl.y,width:pl.width,height:pl.height};
    if(pl.rot!==0) opt.rotate = degrees(pl.rot);
    targetPage.drawPage(prepared.emb,opt);
  }

  const prepared = [];
  for(let i=0;i<entries.length;i++){
    prepared.push(await prepareEntry(entries[i]));
    report(req,Math.round(((i+1)/entries.length)*35),(i+1)+'/'+entries.length);
  }

  if(mode==='split'){
    for(let i=0;i<prepared.length;i++){
      const cur = prepared[i];
      const hint=cur.splitHint;
      if(hint?.kind==='single'){
        const page=out.addPage([cur.pl.outW,cur.pl.outH]);
        drawPrepared(page,cur,0);
      }else{
        const crop=cur.srcPage.getCropBox?.()||{x:0,y:0,width:cur.pl.outW,height:cur.pl.outH};
        const addRegion=async(spec)=>{
          const region=await out.embedPage(cur.srcPage,{
            left:Number(crop.x||0)+spec.x,
            bottom:Number(crop.y||0),
            right:Number(crop.x||0)+spec.x+spec.width,
            top:Number(crop.y||0)+spec.height
          });
          const page=out.addPage([spec.width,spec.height]);
          page.drawPage(region,{x:0,y:0,width:spec.width,height:spec.height});
        };
        const hintedPair=hint?.kind==='pair' && cur.pl.rot===0 &&
          Number(hint.left?.width)>0 && Number(hint.left?.height)>0 &&
          Number(hint.right?.width)>0 && Number(hint.right?.height)>0 &&
          Math.abs((Number(hint.left.width)+Number(hint.right.width))-cur.pl.outW)<1;
        if(hintedPair){
          const leftSpec={x:0,width:Number(hint.left.width),height:Number(hint.left.height)};
          const rightSpec={x:leftSpec.width,width:Number(hint.right.width),height:Number(hint.right.height)};
          if(direction==='right-to-left'){
            await addRegion(rightSpec);
            await addRegion(leftSpec);
          }else{
            await addRegion(leftSpec);
            await addRegion(rightSpec);
          }
        }else if(cur.pl.rot===0){
          const half=cur.pl.outW/2;
          const leftSpec={x:0,width:half,height:cur.pl.outH};
          const rightSpec={x:half,width:half,height:cur.pl.outH};
          if(direction==='right-to-left'){
            await addRegion(rightSpec);
            await addRegion(leftSpec);
          }else{
            await addRegion(leftSpec);
            await addRegion(rightSpec);
          }
        }else{
          const half = cur.pl.outW/2;
          if(direction==='right-to-left'){
            const rightPage = out.addPage([half,cur.pl.outH]);
            drawPrepared(rightPage,cur,-half);
            const leftPage = out.addPage([half,cur.pl.outH]);
            drawPrepared(leftPage,cur,0);
          }else{
            const leftPage = out.addPage([half,cur.pl.outH]);
            drawPrepared(leftPage,cur,0);
            const rightPage = out.addPage([half,cur.pl.outH]);
            drawPrepared(rightPage,cur,-half);
          }
        }
      }
      report(req,35+Math.round(((i+1)/prepared.length)*55),(i+1)+'/'+prepared.length);
    }
  }else if(mode==='merge'){
    if(prepared.length<2) throw new Error('merge requires at least 2 pages');
    const spreadPages=[];
    let start = 0;
    if(cover==='standalone'){
      const first = prepared[0];
      const page = out.addPage([first.pl.outW,first.pl.outH]);
      drawPrepared(page,first,0);
      spreadPages.push({kind:'single'});
      start = 1;
    }
    let done = 0;
    const total = Math.max(1, prepared.length-start);
    for(let i=start;i<prepared.length;i+=2){
      const a = prepared[i];
      if(i+1<prepared.length){
        const b = prepared[i+1];
        const page = out.addPage([a.pl.outW+b.pl.outW, Math.max(a.pl.outH,b.pl.outH)]);
        if(direction==='right-to-left'){
          drawPrepared(page,b,0);
          drawPrepared(page,a,b.pl.outW);
          spreadPages.push({kind:'pair',left:{width:b.pl.outW,height:b.pl.outH},right:{width:a.pl.outW,height:a.pl.outH}});
        }else{
          drawPrepared(page,a,0);
          drawPrepared(page,b,a.pl.outW);
          spreadPages.push({kind:'pair',left:{width:a.pl.outW,height:a.pl.outH},right:{width:b.pl.outW,height:b.pl.outH}});
        }
      }else{
        const page = out.addPage([a.pl.outW,a.pl.outH]);
        drawPrepared(page,a,0);
        spreadPages.push({kind:'single'});
      }
      done += 2;
      report(req,35+Math.round((Math.min(done,total)/total)*55),Math.min(i+2,prepared.length)+'/'+prepared.length);
    }
    out.setSubject(spreadMetaPrefix+JSON.stringify({v:1,pages:spreadPages}));
  }else{
    throw new Error('unknown spread mode:'+mode);
  }

  const bytes = await out.save();
  const outAb = bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
  postMessage({type:'r',req,ok:true,data:outAb},[outAb]);
}

onmessage = async(ev)=>{
  const data = ev.data || {};
  const req = data.req;
  try{
    if(data.act==='ws'){ await opWS(req, data.pay || {}); return; }
    if(data.act==='st'){ await opST(req, data.pay || {}); return; }
    if(data.act==='spread'){ await opSP(req, data.pay || {}); return; }
    throw new Error('unknown action:'+data.act);
  }catch(e){
    postMessage({type:'r',req,ok:false,error:e?.message||String(e)});
  }
};
`;
    const url=URL.createObjectURL(new Blob([pdfLibSource,'\n',fontkitSource,'\n',src],{type:'application/javascript'}));
    try{
      return new Worker(url);
    }finally{
      try{ URL.revokeObjectURL(url); }catch{}
    }
  }

  clearPending(req){
    const q=this.pending.get(req);
    if(q?.timer) clearTimeout(q.timer);
    this.pending.delete(req);
    return q;
  }

  rejectAll(err){
    for(const [req,q] of this.pending.entries()){
      if(q?.timer) clearTimeout(q.timer);
      try{ q.rej(err); }catch{}
      this.pending.delete(req);
    }
  }

  failWorker(message){
    const err=new Error('内部PDF処理Workerが停止しました。もう一度実行してください。'+(message?(' 詳細: '+message):''));
    this.rejectAll(err);
    try{ this.w?.terminate(); }catch{}
    this.w=null;
  }

  on(m){
    if(!m||typeof m!=='object')return;
    if(m.type==='p'){
      const q=this.pending.get(m.req);
      if(q){
        if(q.timer) clearTimeout(q.timer);
        q.timer=setTimeout(q.onTimeout,q.timeoutMs);
        if(typeof q.onP==='function') q.onP(m.pc||0,m.msg||'');
      }
      return;
    }
    if(m.type==='r'){
      const q=this.clearPending(m.req);
      if(!q)return;
      m.ok?q.res(m.data):q.rej(new Error(m.error||'worker failed'));
    }
  }

  async call(act,pay,opt={}){
    const req='r_'+(++this.seq);
    const worker=this.w || await this.start();
    return new Promise((res,rej)=>{
      const ms=clamp(Number(opt.timeout)||this.defaultTimeout,10000,600000);
      const onTimeout=()=>{
        if(this.pending.has(req)) this.failWorker('処理がタイムアウトしました。ページ数を減らして再実行してください。');
      };
      const timer=setTimeout(onTimeout,ms);
      this.pending.set(req,{res,rej,onP:opt.onP||null,timer,onTimeout,timeoutMs:ms});
      try{
        worker.postMessage({req,act,pay},opt.transfer||[]);
      }catch(e){
        this.clearPending(req);
        rej(e);
      }
    });
  }
}
