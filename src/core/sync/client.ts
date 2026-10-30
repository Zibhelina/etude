import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { Etude } from "../engine.ts";
import { bootstrap, drain, install, localEvent, receive, rows, type Change } from "./log.ts";
import { createVault, decryptBlob, decryptEvent, encryptBlob, encryptEvent, fromB64, sha256Hex, toB64, unwrapWithPassword, unwrapWithRecovery } from "./crypto.ts";
import { CloudTransport, FolderTransport, type Transport } from "./transport.ts";
import { project } from "./project.ts";
import { accountFor, AccountError, signInCode } from "../account.ts";

/** Most ciphertext characters sent in one push. */
const PUSH_BATCH_BYTES=6*1024*1024;

/** Bytes a blob gains when encrypted: version, nonce and tag. */
const BLOB_OVERHEAD=1+12+16;

export type SyncProgress = {
  /** download: events and media from other devices; check: hashing local media (done and total count files); upload: new media and events; apply: rebuilding the collection. */
  step:"download"|"check"|"upload"|"apply";
  done:number;
  /** Null when the size isn't known ahead. */
  total:number|null;
  /** Bytes per second over the last few seconds. */
  rate:number;
};

/** Blob transfers run this many at a time: each is a round trip, and most media files are small. */
const BLOB_CONCURRENCY=8;
/** Runs fn over items a few at a time. The first failure rejects, and the other runners stop after their current item. */
async function pool<T>(items:T[],limit:number,fn:(item:T)=>Promise<void>) {
  let next=0,failed=false;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(!failed&&next<items.length){const item=items[next++];try{await fn(item);}catch(e){failed=true;throw e;}}}));
}

/** A media path is relative, stays inside the media folder and has no control characters or backslashes. Spaces and accents are fine. */
const safeMediaPath=(file:string)=>!/[\x00-\x1f\x7f\\]/.test(file)&&!file.split("/").some(p=>p===""||p==="."||p==="..");

type Config = { kind:"cloud"|"folder";server?:string;folder?:string;email?:string;enabled:boolean;hasKeys?:boolean;lastSync?:string };
type Secrets = { token?:string;vk?:string };
const clients=new WeakMap<Etude,SyncClient>();
export function syncFor(e:Etude) { let s=clients.get(e);if(!s) {s=new SyncClient(e);clients.set(e,s);}return s; }
export class SyncClient {
  readonly e:Etude;
  busy=false;
  error:string|null=null;
  private progress:SyncProgress|null=null;
  private samples:[number,number][]=[];
  private active:Promise<any>|null=null;
  constructor(e:Etude) { this.e=e; }
  private initialized() { return !!this.e.db.get("SELECT 1 FROM sqlite_master WHERE name='sync_control'"); }
  private meta<T>(key:string,fallback:T):T { const r=this.initialized()?this.e.db.get("SELECT value FROM sync_meta WHERE key=?",key):null;return r?JSON.parse(r.value):fallback; }
  private set(key:string,value:unknown) {this.e.db.run("INSERT INTO sync_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",key,JSON.stringify(value));}
  private config() {return this.meta<Config|null>("config",null);}
  private secretFile() { const dev=this.e.db.get("SELECT device FROM sync_control WHERE id=1")!.device;return join(this.e.home,"sync",dev+".json"); }
  private secrets():Secrets {if(!this.initialized())return {};const f=this.secretFile();return existsSync(f)?JSON.parse(readFileSync(f,"utf8")):{};}
  private saveSecrets(s:Secrets) {const f=this.secretFile();mkdirSync(dirname(f),{recursive:true,mode:0o700});writeFileSync(f+".tmp",JSON.stringify(s),{mode:0o600});chmodSync(f+".tmp",0o600);renameSync(f+".tmp",f);}
  /** This device's token: Sync's own sign-in, or the Etude account's when it is signed in to the same server. */
  private token() {const c=this.config();return this.secrets().token ?? (c?.kind==="cloud" ? accountFor(this.e).tokenFor(c.server) : undefined);}
  private shared() {return !this.secrets().token && !!this.token();}
  /** Starts a progress step, or resumes one that another step interrupted. */
  private step(step:SyncProgress|SyncProgress["step"],total:number|null=null):SyncProgress {this.progress=typeof step==="string"?{step,done:0,total,rate:0}:step;this.samples=[[Date.now(),this.progress.done]];return this.progress;}
  private moved(n:number) {const p=this.progress;if(!p)return;p.done+=n;const now=Date.now();this.samples.push([now,p.done]);while(this.samples.length>2&&now-this.samples[1][0]>5000)this.samples.shift();}
  private rate() {const p=this.progress,first=this.samples[0];if(!p||!first)return 0;const ms=Date.now()-first[0];return ms>0?Math.round((p.done-first[1])*1000/ms):0;}
  /** Bytes the unsent events take on the wire: base64 of the encrypted body. */
  private unsentBytes() {return this.e.db.get("SELECT coalesce(sum(coalesce(length(ciphertext),(length(CAST(body AS BLOB))+29+2)/3*4)),0) n FROM sync_events WHERE sent=0")!.n as number;}
  status() {const cfg=this.config();const sec=this.secrets();return {configured:!!cfg?.enabled,kind:cfg?.kind??null,server:cfg?.server,folder:cfg?.folder,email:cfg?.email ?? (this.shared()?accountFor(this.e).email():undefined),signedIn:!!this.token(),account:this.shared(),unlocked:!!sec.vk,hasKeys:cfg?.kind==="folder" ? existsSync(join(cfg.folder!,"keys.json")) : !!cfg?.hasKeys,lastSync:cfg?.lastSync??null,busy:this.busy,error:this.error,progress:this.progress&&this.busy?{...this.progress,rate:this.rate()}:null,pending:this.initialized()?this.e.db.get("SELECT (SELECT count(*) FROM sync_outbox)+(SELECT count(*) FROM sync_events WHERE sent=0) AS n")!.n:0};}
  setup(input:{server?:string;folder?:string}) {
    if(this.busy)throw new Error("wait for sync to finish");
    if (!!input.server === !!input.folder) throw new Error("choose a server or a folder");
    if(input.server) {const u=new URL(input.server);if(u.protocol!=="https:" && !(u.protocol==="http:" && ["localhost","127.0.0.1","[::1]"].includes(u.hostname)))throw new Error("Sync requires HTTPS outside localhost");if(u.username||u.password||u.search||u.hash)throw new Error("invalid server URL");}
    if(input.folder && !process.versions?.node)throw new Error("folder sync needs the desktop app");
    install(this.e.db);
    const old=this.config();
    const cfg:Config={kind:input.folder?"folder":"cloud",...(input.folder?{folder:resolve(input.folder)}:{server:input.server!.replace(/\/$/,"")}),enabled:true};
    if(old && (old.folder!==cfg.folder || old.server!==cfg.server))throw new Error("this collection is bound to another sync destination; use a separate collection");
    this.set("config",{...old,...cfg});bootstrap(this.e.db);drain(this.e.db);
    return this.status();
  }
  private transport():Transport {const c=this.config();if(!c?.enabled)throw new Error("set up Sync first");if(c.kind==="folder")return new FolderTransport(c.folder!,this.e.db.get("SELECT device FROM sync_control WHERE id=1")!.device);const token=this.token();if(!token)throw new Error("sign in first");return new CloudTransport(c.server!,token);}
  /** After setup with the account's token: learn whether the vault already has keys. */
  async probe() {const c=this.config();if(c?.kind!=="cloud"||!this.token())return this.status();try{const k=await this.transport().keys();this.set("config",{...this.config(),hasKeys:!!k});this.error=null;}catch(e){this.error=(e as Error).message;}return this.status();}
  async signin(email:string) {const c=this.config();if(c?.kind!=="cloud")throw new Error("choose a Sync server first");await new CloudTransport(c.server!,"").json("/v1/auth/email/start",{email});this.set("config",{...c,email});return this.status();}
  /** Redeems the email's 6-digit code (with the address from `signin`) or the link's long token. */
  async verify(input:string) {const c=this.config();if(c?.kind!=="cloud")throw new Error("choose a Sync server first");const code=signInCode(input);if(code&&!c.email)throw new Error("ask for a code first: the code goes with the email address it was sent to");const r:any=await new CloudTransport(c.server!,"").json("/v1/auth/email/verify",{...(code?{email:c.email,code}:{token:input.trim()}),deviceName:process.versions?.node?"Etude desktop":"Etude browser"}).catch((e:any)=>{throw e?.code?new AccountError(e.message,401,e.code):e;});this.saveSecrets({token:r.token});accountFor(this.e).adopt(c.server!,r.token,r.account);this.set("config",{...c,email:r.account.email});return this.probe();}
  async unlock(input:{password?:string;recovery?:string}) {
    const transport=this.transport();const found=await transport.keys();
    let vk:Uint8Array;let recoveryKey:string|undefined;
    if(found) {
      if(input.recovery && found.keys.recovery) vk=await unwrapWithRecovery(found.keys.recovery,input.recovery);
      else if(input.password && found.keys.password) vk=await unwrapWithPassword(found.keys.password,input.password);
      else throw new Error("enter the Sync password or recovery key");
    } else {
      if(!input.password || input.password.length<8)throw new Error("use at least 8 characters for the Sync password");
      const created=await createVault(input.password);await transport.putKeys(created.keys);vk=created.vk;recoveryKey=created.recoveryKey;
    }
    const fingerprint=await sha256Hex(vk);const old=this.meta<string|null>("vault",null);
    if(old && old!==fingerprint)throw new Error("this collection belongs to another vault; restore into a separate collection");
    this.set("vault",fingerprint);this.saveSecrets({...this.secrets(),vk:toB64(vk)});this.set("config",{...this.config(),hasKeys:true});
    return {status:this.status(),...(recoveryKey?{recoveryKey}:{})};
  }
  async off() {if(this.active)await this.active.catch(()=>{});const c=this.config();if(c?.kind==="cloud" && this.secrets().token && accountFor(this.e).token()!==this.secrets().token) { try { await (this.transport() as CloudTransport).json("/v1/auth/logout",{}); } catch { this.error="Signed out locally. This device could not be revoked on the server while offline."; } } if(c)this.set("config",{...c,enabled:false});if(this.initialized())rmSync(this.secretFile(),{force:true});return this.status();}
  now() {if(this.active)return this.active;this.busy=true;this.active=this.run().then(()=>(this.error=null,this.progress=null,{...this.status(),busy:false})).catch(e=>{this.error=e.message;throw e;}).finally(()=>{this.busy=false;this.active=null;this.progress=null;});return this.active;}
  async auto() {if(!this.status().configured||!this.status().unlocked)return;try{await this.now();}catch(e){if(e instanceof TypeError || /fetch failed|network|offline|timeout/i.test((e as Error).message))this.error=null;}}
  private async run() {
    const vk=this.secrets().vk;if(!vk)throw new Error("unlock Sync first");const key=fromB64(vk);const t=this.transport();const db=this.e.db;
    // Drain writes before the first await. Further local writes are drained again before projection.
    drain(db);
    let cursor=this.meta("cursor","");let more=true;
    // A device that has never pulled downloads about the whole vault.
    const down=this.step("download",cursor===""?await t.usage?.()??null:null);
    while(more) {
      const page=await t.pull(cursor);this.moved(page.events.reduce((n,e)=>n+e.ciphertext.length,0));
      // A folder hands back every event each time: only new ones are decrypted, applied, and call for a rebuild.
      const fresh=page.events.filter(event=>!db.get("SELECT 1 FROM sync_events WHERE id=?",event.id));
      if(fresh.length)this.set("unprojected",true);
      for(const event of fresh)receive(db,event.id,await decryptEvent<Change>(key,event.id,event.ciphertext));
      cursor=page.cursor;more=page.more;this.set("cursor",cursor);
    }
    // Hash the media on disk first, so a file another device already uploaded is neither downloaded nor uploaded again.
    const files:[string,string][]=[];
    const list=(dir:string,prefix="") => {if(!existsSync(dir))return;for(const name of readdirSync(dir)){const p=join(dir,name),relative=prefix+name;if(statSync(p).isDirectory())list(p,relative+"/");else if(safeMediaPath(relative))files.push([p,relative]);}};
    list(this.e.mediaDir);
    this.step("check",files.length);
    const onDisk=new Map<string,string>(),local=new Map<string,string>();
    // Hashes are kept with each file's size and modification time, so only new or changed files are read again.
    db.sql.exec("CREATE TABLE IF NOT EXISTS sync_media_hashes (file TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime REAL NOT NULL, hash TEXT NOT NULL)");
    const known=new Map(db.all<{file:string;size:number;mtime:number;hash:string}>("SELECT file,size,mtime,hash FROM sync_media_hashes").map(r=>[r.file,r]));
    const fresh:[string,number,number,string][]=[];
    for(const [p,relative] of files) {
      const st=statSync(p),k=known.get(relative);
      let hash=k&&k.size===st.size&&k.mtime===st.mtimeMs?k.hash:"";
      if(!hash){hash=await sha256Hex(new Uint8Array(readFileSync(p)));fresh.push([relative,st.size,st.mtimeMs,hash]);}
      onDisk.set(relative,hash);local.set(hash,p);this.moved(1);
    }
    db.tx(()=>{for(const f of fresh)db.run("INSERT INTO sync_media_hashes VALUES(?,?,?,?) ON CONFLICT(file) DO UPDATE SET size=excluded.size,mtime=excluded.mtime,hash=excluded.hash",...f);for(const file of known.keys())if(!onDisk.has(file))db.run("DELETE FROM sync_media_hashes WHERE file=?",file);});
    this.step(down);
    // Read the registers once: a collection can hold tens of thousands of media files.
    const blobs=rows(db,"blob"),media=rows(db,"media");
    const assets=db.all("SELECT hash,bytes FROM type_assets").filter(a=>!db.get("SELECT 1 FROM sync_blobs WHERE hash=?",a.hash)),assetHashes=new Set(assets.map(a=>a.hash));
    // The version of each media file this device last had in step with the registers. A file that still matches it
    // wasn't edited here, so a newer version from another device replaces it; one that doesn't is uploaded below.
    db.sql.exec("CREATE TABLE IF NOT EXISTS sync_media_seen (file TEXT PRIMARY KEY, hash TEXT NOT NULL)");
    const seen=new Map<string,string>(db.all("SELECT file,hash FROM sync_media_seen").map(r=>[r.file,r.hash]));
    const edited=(file:string)=>onDisk.has(file)&&onDisk.get(file)!==media.get(file)?.hash&&onDisk.get(file)!==seen.get(file);
    // Media files to fetch, by blob, written as soon as their blob arrives.
    const root=resolve(this.e.mediaDir),wanted=new Map<string,string[]>();
    for(const [file,r] of media) if(safeMediaPath(file)&&resolve(root,file).startsWith(root+sep)&&onDisk.get(file)!==r.hash&&!edited(file))wanted.set(r.hash,[...wanted.get(r.hash)??[],file]);
    const write=(file:string,hash:string,bytes:Uint8Array)=>{const path=join(this.e.mediaDir,file);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,bytes);onDisk.set(file,hash);};
    const missing=[...blobs].filter(([hash])=>!assetHashes.has(hash)&&!db.get("SELECT 1 FROM sync_blobs WHERE hash=?",hash));
    await pool(missing,BLOB_CONCURRENCY,async([hash,r])=>{
      let bytes:Uint8Array;
      if(local.has(hash))bytes=new Uint8Array(readFileSync(local.get(hash)!));
      else {const ciphertext=await t.getBlob(r.name);this.moved(ciphertext.length);bytes=await decryptBlob(key,ciphertext,r.name);if(await sha256Hex(bytes)!==hash)throw new Error("plaintext blob hash mismatch");}
      db.run("INSERT INTO sync_blobs VALUES(?,?,?)",hash,r.name,bytes);
      for(const file of wanted.get(hash)??[])write(file,hash,bytes);
    });
    const changed=files.filter(([,relative])=>edited(relative));
    const sizes=new Map<string,number>();
    for(const a of assets) if(!blobs.has(a.hash))sizes.set(a.hash,a.bytes.length+BLOB_OVERHEAD);
    for(const [p,relative] of changed) {const hash=onDisk.get(relative)!;if(!blobs.has(hash))sizes.set(hash,statSync(p).size+BLOB_OVERHEAD);}
    const up=this.step("upload",[...sizes.values()].reduce((a,b)=>a+b,0)+this.unsentBytes());
    const addBlob=async(bytes:Uint8Array) => {
      const hash=await sha256Hex(bytes);let name=blobs.get(hash)?.name;
      if(!name) {const b=await encryptBlob(key,bytes);await t.putBlob(b.hash,b.ciphertext);this.moved(b.ciphertext.length);name=b.hash;localEvent(db,"blob",hash,{"/name":name});blobs.set(hash,{name});}
      db.run("INSERT INTO sync_blobs VALUES(?,?,?) ON CONFLICT(hash) DO UPDATE SET name=excluded.name,bytes=excluded.bytes",hash,name,bytes);
      return hash;
    };
    // One upload per distinct file content, a few at a time.
    const firstPath=new Map<string,string>();for(const [p,relative] of changed)if(!firstPath.has(onDisk.get(relative)!))firstPath.set(onDisk.get(relative)!,p);
    await pool([...assets.map(a=>()=>new Uint8Array(a.bytes)),...[...firstPath.values()].map(p=>()=>new Uint8Array(readFileSync(p)))],BLOB_CONCURRENCY,async(read)=>void await addBlob(read()));
    for(const [,relative] of changed)localEvent(db,"media",relative,{"/hash":onDisk.get(relative)});
    drain(db);
    for(const [file,r] of rows(db,"media")) {if(!safeMediaPath(file)||!resolve(root,file).startsWith(root+sep))continue;if(onDisk.get(file)===r.hash)continue;const b=db.get("SELECT bytes FROM sync_blobs WHERE hash=?",r.hash);if(!b)throw new Error("missing media blob");write(file,r.hash,b.bytes);}
    db.tx(()=>{for(const [file,r] of rows(db,"media"))if(onDisk.get(file)===r.hash && seen.get(file)!==r.hash)db.run("INSERT INTO sync_media_seen VALUES(?,?) ON CONFLICT(file) DO UPDATE SET hash=excluded.hash",file,r.hash);});
    // The media pass added events; count what is left exactly.
    up.total=up.done+this.unsentBytes();
    for(;;) {
      const batch=db.all("SELECT * FROM sync_events WHERE sent=0 ORDER BY id LIMIT 200");if(!batch.length)break;
      // etude-cloud refuses push bodies over 8 MiB, so a batch also stops at ~6 MiB of ciphertext.
      const events=[];const sent:any[]=[];let bytes=0;
      for(const r of batch) {const ciphertext=r.ciphertext??await encryptEvent(key,r.id,JSON.parse(r.body));if(!r.ciphertext)db.run("UPDATE sync_events SET ciphertext=? WHERE id=?",ciphertext,r.id);if(events.length&&bytes+ciphertext.length>PUSH_BATCH_BYTES)break;events.push({id:r.id,ciphertext});sent.push(r);bytes+=ciphertext.length;}
      await t.push(events);this.moved(bytes);db.tx(()=>{for(const r of sent)db.run("UPDATE sync_events SET sent=1 WHERE id=?",r.id);});
    }
    // Rebuilding the rows from the registers rewrites the whole collection and holds the thread (tens
    // of seconds on a big one), so it runs only when changes from another device arrived, now or in a
    // run that stopped before rebuilding. Local changes are already in the rows.
    if(this.meta("unprojected",false)) {
      // Let a status request see this step before the rebuild holds the thread.
      this.step("apply");await new Promise(r=>setTimeout(r,0));
      // No await while rebuilding. SQL triggers are muted only for this transaction.
      drain(db);project(this.e);this.set("unprojected",false);
    } else drain(db);
    this.set("config",{...this.config(),lastSync:new Date().toISOString()});return this.status();
  }
}
