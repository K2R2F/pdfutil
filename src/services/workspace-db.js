export class WorkspaceDb{
  constructor(){this.p=null;}
  open(){
    if(this.p)return this.p;
    this.p=new Promise((res,rej)=>{
      const r=indexedDB.open('pdf_ws_v3',1);
      r.onupgradeneeded=()=>{
        const db=r.result;
        if(!db.objectStoreNames.contains('files')){
          const s=db.createObjectStore('files',{keyPath:'id'});
          s.createIndex('byCreated','createdAt');
        }
      };
      r.onsuccess=()=>res(r.result);
      r.onerror=()=>rej(r.error);
    });
    return this.p;
  }
  async tx(mode,run){
    const db=await this.open();
    return new Promise((res,rej)=>{
      const t=db.transaction('files',mode),s=t.objectStore('files');
      let out;
      try{out=run(s);}catch(e){rej(e);return;}
      t.oncomplete=()=>res(out); t.onerror=()=>rej(t.error); t.onabort=()=>rej(t.error);
    });
  }
  async put(f){
    await this.tx('readwrite',s=>s.put({
      id:f.id,name:f.name,mime:f.mime,kind:f.kind,size:f.size,
      createdAt:f.createdAt||Date.now(),
      data:f.data instanceof ArrayBuffer?f.data.slice(0):f.data
    }));
  }
  async get(fid){
    const db=await this.open();
    return new Promise((res,rej)=>{
      const r=db.transaction('files','readonly').objectStore('files').get(fid);
      r.onsuccess=()=>res(r.result||null); r.onerror=()=>rej(r.error);
    });
  }
  async allMeta(){
    const db=await this.open();
    return new Promise((res,rej)=>{
      const r=db.transaction('files','readonly').objectStore('files').getAll();
      r.onsuccess=()=>{
        const a=(r.result||[]).map(x=>({id:x.id,name:x.name,mime:x.mime,kind:x.kind,size:x.size,createdAt:x.createdAt}));
        a.sort((x,y)=>x.createdAt-y.createdAt); res(a);
      };
      r.onerror=()=>rej(r.error);
    });
  }
  async del(fid){await this.tx('readwrite',s=>s.delete(fid));}
  async clear(){await this.tx('readwrite',s=>s.clear());}
}
