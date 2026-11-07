import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Etude } from "../engine.ts";
import { bootstrap, drain, install, localEvent, receive, rowFor, rows, type Change } from "./log.ts";
import { createVault, decryptBlob, decryptEvent, decryptSnapshotPart, encryptBlob, encryptEvent, encryptSnapshotPart, fromB64, generateVaultKey, protectVault, randomBytes, sha256Hex, syncKeys, toB64, unwrapWithPassword, unwrapWithRecovery, type SyncKeys } from "./crypto.ts";
import { CloudTransport, FolderTransport, type Transport } from "./transport.ts";
import { projectChanges, projectionPending } from "./project.ts";
import { finishSnapshot, mergeSnapshotPart, PART_REGISTERS, snapshotParts } from "./snapshot.ts";
import { accountFor, secondStepBody, secondStepFrom, signInCode, type PendingSecondStep } from "../account.ts";

/** Most ciphertext characters sent in one push. */
const PUSH_BATCH_BYTES=6*1024*1024;

/** Bytes a blob gains when encrypted: version, nonce and tag. */
const BLOB_OVERHEAD=1+12+16;

export type SyncProgress = {
  /**
   * The collection: snapshot (a device's first sync, when the vault has one: its parts), download (events and type assets),
   * upload (type assets and events), apply (writing the changes into the collection).
   * The media, after it: check (hashing local files; done and total count files), download, upload (files, then their events).
   */
  step:"snapshot"|"download"|"check"|"upload"|"apply";
  done:number;
  /** Null when the size isn't known ahead. */
  total:number|null;
  /** Bytes per second over the last few seconds. */
  rate:number;
};

/** Events the vault's log grows by before a desktop device makes a new snapshot. ETUDE_SYNC_SNAPSHOT_EVERY changes it. */
const snapshotEvery=()=>Number(globalThis.process?.env?.ETUDE_SYNC_SNAPSHOT_EVERY)||20_000;
/** Registers per snapshot part (ETUDE_SYNC_SNAPSHOT_PART changes it). */
const partRegisters=()=>Number(globalThis.process?.env?.ETUDE_SYNC_SNAPSHOT_PART)||PART_REGISTERS;

/** A media folder whose files and subfolders didn't change is looked at again after this long anyway, for files rewritten in place. */
const MEDIA_RESCAN_MS=10*60_000;
/** Hashes whose bytes are kept in sync_blobs: type assets, which the projection reads. */
const STORED="SELECT hash FROM sync_blobs WHERE bytes IS NOT NULL";

/**
 * Blob transfers run this many at a time: most media files are small, so each costs about a round trip.
 * etude-cloud takes 100 requests a second per device; at ~250 ms each, 16 stay under it.
 */
const BLOB_CONCURRENCY=16;
/** Runs fn over items a few at a time. The first failure rejects, and the other runners stop after their current item. */
async function pool<T>(items:T[],limit:number,fn:(item:T)=>Promise<void>) {
  let next=0,failed=false;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(!failed&&next<items.length){const item=items[next++];try{await fn(item);}catch(e){failed=true;throw e;}}}));
}

/** A media path is relative, stays inside the media folder and has no control characters or backslashes. Spaces and accents are fine. */
const safeMediaPath=(file:string)=>!/[\x00-\x1f\x7f\\]/.test(file)&&!file.split("/").some(p=>p===""||p==="."||p==="..");

/** A downloaded file is written under this prefix beside its place and then renamed, so a write cut short never has the real name. */
const PARTIAL=".etude-partial-";
/** A partial file this old was left by a write that never finished. */
const PARTIAL_STALE_MS=10*60_000;
export function writeAtomic(path:string,bytes:Uint8Array,write:(path:string,bytes:Uint8Array)=>void=writeFileSync) {
  const temp=join(dirname(path),PARTIAL+Math.random().toString(36).slice(2));
  try {write(temp,bytes);renameSync(temp,path);}
  catch(e) {rmSync(temp,{force:true});throw e;}
}

/** One phase's progress, with its rate over the last few seconds. */
class Meter {
  progress:SyncProgress|null=null;
  private samples:[number,number][]=[];
  step(step:SyncProgress["step"],total:number|null=null):SyncProgress {this.progress={step,done:0,total,rate:0};this.samples=[[Date.now(),0]];return this.progress;}
  moved(n:number) {const p=this.progress;if(!p)return;p.done+=n;const now=Date.now();this.samples.push([now,p.done]);while(this.samples.length>2&&now-this.samples[1][0]>5000)this.samples.shift();}
  view():SyncProgress|null {const p=this.progress,first=this.samples[0];if(!p||!first)return null;const ms=Date.now()-first[0];return {...p,rate:ms>0?Math.round((p.done-first[1])*1000/ms):0};}
}
const toHex=(b:Uint8Array)=>[...b].map(x=>x.toString(16).padStart(2,"0")).join("");
/** Errors an automatic sync keeps quiet: the device is offline, or the server can't be reached. */
const offline=(e:unknown)=>e instanceof TypeError || /fetch failed|network|offline|timeout/i.test((e as Error)?.message??"");
/** Thrown inside the media task when it was asked to stop. */
class Stopped extends Error { constructor() { super("media sync stopped"); } }

/** mode: "password" = end-to-end, only this person's devices open the vault key; "server" = the server keeps it (no password).
 * keepsKeys: the server can keep vault keys, so Sync can start without a password. */
type Config = { kind:"cloud"|"folder";server?:string;folder?:string;email?:string;enabled:boolean;hasKeys?:boolean;mode?:"password"|"server"|null;keepsKeys?:boolean;lastSync?:string };
/** pendingSecond: an email sign-in waiting for its second step (two-step sign-in), kept beside the token, short-lived. */
type Secrets = { token?:string;vk?:string;pendingSecond?:PendingSecondStep };
const clients=new WeakMap<Etude,SyncClient>();
export function syncFor(e:Etude) { let s=clients.get(e);if(!s) {s=new SyncClient(e);clients.set(e,s);}return s; }
export class SyncClient {
  readonly e:Etude;
  /** The collection's sync: `busy`, `error` and `progress` in the status. */
  busy=false;
  error:string|null=null;
  private meter=new Meter();
  private active:Promise<any>|null=null;
  constructor(e:Etude) { this.e=e;e.onClose(()=>this.stopMedia()); }
  /** Events pulled from other devices since this process started; the app reloads its page when it grows. */
  private received=0;
  /** The media task, which runs in the background after the collection. One at a time. */
  private mediaTask:Promise<void>|null=null;
  private mediaMeter=new Meter();
  private mediaError:string|null=null;
  /** New media arrived while the task ran: it makes one more pass. */
  private mediaAgain=false;
  private mediaStop:AbortController|null=null;
  /** Media files written from other devices since this process started; open cards ask again for what they lacked. */
  private mediaReceived=0;
  /** Pushes take turns: the collection and the media task each send events. */
  private pushing:Promise<void>=Promise.resolve();
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
  /** Starts a progress step of the collection, or of the media with `m`. */
  private step(step:SyncProgress["step"],total:number|null=null,m=this.meter):SyncProgress {return m.step(step,total);}
  private moved(n:number,m=this.meter) {m.moved(n);}
  /** Bytes the unsent events take on the wire: base64 of the encrypted body. */
  private unsentBytes() {return this.e.db.get("SELECT coalesce(sum(coalesce(length(ciphertext),(length(CAST(body AS BLOB))+29+2)/3*4)),0) n FROM sync_events WHERE sent=0")!.n as number;}
  status() {const cfg=this.config();const sec=this.secrets();return {configured:!!cfg?.enabled,kind:cfg?.kind??null,server:cfg?.server,folder:cfg?.folder,email:cfg?.email ?? (this.shared()?accountFor(this.e).email():undefined),signedIn:!!this.token(),account:this.shared(),unlocked:!!sec.vk,hasKeys:cfg?.kind==="folder" ? existsSync(join(cfg.folder!,"keys.json")) : !!cfg?.hasKeys,mode:cfg?.kind==="folder" ? "password" : cfg?.mode ?? (cfg?.hasKeys ? "password" : null),passwordOptional:cfg?.kind==="cloud" && !!cfg.keepsKeys,lastSync:cfg?.lastSync??null,busy:this.busy,error:this.error,progress:this.busy?this.meter.view():null,received:this.received,
    media:{active:!!this.mediaTask,progress:this.mediaTask?this.mediaMeter.view():null,error:this.mediaError,received:this.mediaReceived},pending:this.initialized()?this.e.db.get("SELECT (SELECT count(*) FROM sync_outbox)+(SELECT count(*) FROM sync_events WHERE sent=0) AS n")!.n:0};}
  setup(input:{server?:string;folder?:string}) {
    if(this.busy)throw new Error("wait for sync to finish");
    if (!!input.server === !!input.folder) throw new Error("choose a server or a folder");
    void this.stopMedia();
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
  async probe() {
    const c=this.config();
    if(c?.kind!=="cloud"||!this.token())return this.status();
    try {
      const t=this.transport() as CloudTransport;
      const v=await (await t.request("/v1/vault")).json() as {hasKeys:boolean;mode?:"password"|"server"|null};
      this.set("config",{...this.config(),hasKeys:v.hasKeys,mode:v.mode ?? (v.hasKeys?"password":null),keepsKeys:await t.keepsKeys()});
      this.error=null;
    } catch(e) {this.error=(e as Error).message;}
    return this.status();
  }
  async signin(email:string) {const c=this.config();if(c?.kind!=="cloud")throw new Error("choose a Sync server first");await new CloudTransport(c.server!,"").json("/v1/auth/email/start",{email});this.set("config",{...c,email});return this.status();}
  /** Redeems the email's 6-digit code (with the address from `signin`) or the link's long token. */
  async verify(input:string) {
    const c=this.config();
    if(c?.kind!=="cloud")throw new Error("choose a Sync server first");
    const code=signInCode(input);
    if(code&&!c.email)throw new Error("ask for a code first: the code goes with the email address it was sent to");
    const previous=this.token();
    let r:any;
    try {
      r=await new CloudTransport(c.server!,previous??"").json("/v1/auth/email/verify",{
        ...(code?{email:c.email,code}:{token:input.trim()}),
        deviceName:process.versions?.node?"Etude desktop":"Etude browser",
      });
    } catch(e) {
      // Two-step sign-in: the email step only got a ticket; secondStep() finishes with the authenticator or a recovery code.
      const second=secondStepFrom(e);if(!second)throw e;
      this.saveSecrets({...this.secrets(),pendingSecond:second});
      return {...this.status(),secondStep:{methods:second.methods}};
    }
    return this.signedInWith(c,previous,r);
  }
  async secondStep(input:{code?:string;recoveryCode?:string}) {
    const c=this.config();
    if(c?.kind!=="cloud")throw new Error("choose a Sync server first");
    const p=this.secrets().pendingSecond;
    if(!p||p.expires<Date.now())throw new Error("sign in by email again: the sign-in waiting for its second step expired");
    const previous=this.token();
    let r:any;
    try { r=await new CloudTransport(c.server!,previous??"").json("/v1/auth/second-factor",secondStepBody(p.ticket,input)); }
    catch(e) { if(["ticket_expired","too_many_attempts"].includes((e as any).code))this.dropPendingSecond();throw e; }
    this.dropPendingSecond();
    return this.signedInWith(c,previous,r);
  }
  private dropPendingSecond() {const {pendingSecond:_,...rest}=this.secrets();this.saveSecrets(rest);}
  private async signedInWith(c:Config,previous:string|null|undefined,r:any) {
    const token=r.reauth?previous:r.token;
    if(!r.reauth)this.saveSecrets({token});
    accountFor(this.e).adopt(c.server!,token,r.account);
    this.set("config",{...c,email:r.account.email});
    return this.probe();
  }
  /**
   * Opens the vault on this device, or makes it on the first one. A vault whose key the server keeps opens with no
   * password. A new vault gets a password (end-to-end, with a recovery key shown once) when one is given; without one,
   * the server keeps its key, where the server can.
   */
  async unlock(input:{password?:string;recovery?:string}) {
    await this.stopMedia();
    const transport=this.transport();const found=await transport.keys();
    let vk:Uint8Array;let recoveryKey:string|undefined;let mode:"password"|"server";
    if(found) {
      if(found.keys.server && transport instanceof CloudTransport) {vk=await transport.serverKey();mode="server";}
      else if(input.recovery && found.keys.recovery) {vk=await unwrapWithRecovery(found.keys.recovery,input.recovery);mode="password";}
      else if(input.password && found.keys.password) {vk=await unwrapWithPassword(found.keys.password,input.password);mode="password";}
      else throw new Error("enter the Sync password or recovery key");
    } else if(input.password) {
      if(input.password.length<8)throw new Error("use at least 8 characters for the Sync password");
      const created=await createVault(input.password);await transport.putKeys(created.keys);vk=created.vk;recoveryKey=created.recoveryKey;mode="password";
    } else {
      if(!(transport instanceof CloudTransport) || !(await transport.keepsKeys()))throw new Error("this server needs a Sync password: use at least 8 characters");
      vk=generateVaultKey();await transport.putServerKey(vk);mode="server";
    }
    const fingerprint=await sha256Hex(vk);const old=this.meta<string|null>("vault",null);
    if(old && old!==fingerprint)throw new Error("this collection belongs to another vault; restore into a separate collection");
    this.set("vault",fingerprint);this.saveSecrets({...this.secrets(),vk:toB64(vk)});this.set("config",{...this.config(),hasKeys:true,mode});
    return {status:this.status(),...(recoveryKey?{recoveryKey}:{})};
  }
  /** The open vault, its transport and its keys as they are now, for changing how the key is kept. */
  private async openVault() {
    const c=this.config();if(c?.kind!=="cloud")throw new Error("only a Sync server vault can change how its key is kept");
    const vk=this.secrets().vk;if(!vk)throw new Error("unlock Sync first");
    const transport=this.transport() as CloudTransport;const found=await transport.keys();
    if(!found)throw new Error("this vault has no keys yet; start Sync first");
    return {vk:fromB64(vk),transport,found};
  }
  /** Adds a Sync password: the vault becomes end-to-end and the server drops its copy of the key, in one write. Show the recovery key once. */
  async protect(password:string) {
    if(!password || password.length<8)throw new Error("use at least 8 characters for the Sync password");
    const {vk,transport,found}=await this.openVault();
    const {keys,recoveryKey}=await protectVault(vk,password);
    await transport.putKeys(keys,found.etag);
    this.set("config",{...this.config(),mode:"password"});
    return {status:this.status(),recoveryKey};
  }
  /** Removes the Sync password: the server keeps the key, so new devices sync after signing in. Not end-to-end any more. */
  async unprotect() {
    const {vk,transport,found}=await this.openVault();
    if(found.keys.server) {this.set("config",{...this.config(),mode:"server"});return {status:this.status()};}
    if(!(await transport.keepsKeys()))throw new Error("this server can't keep vault keys, so Sync here needs a password");
    await transport.putServerKey(vk,found.etag);
    this.set("config",{...this.config(),mode:"server"});
    return {status:this.status()};
  }
  async off() {if(this.active)await this.active.catch(()=>{});await this.stopMedia();const c=this.config();if(c?.kind==="cloud" && this.secrets().token && accountFor(this.e).token()!==this.secrets().token) { try { await (this.transport() as CloudTransport).json("/v1/auth/logout",{}); } catch { this.error="Signed out locally. This device could not be revoked on the server while offline."; } } if(c)this.set("config",{...c,enabled:false});if(this.initialized())rmSync(this.secretFile(),{force:true});return this.status();}
  /**
   * Syncs the collection and resolves when it is in step; the media follows in the background. `waitMedia` also
   * waits for the media (the CLI, a process that ends) and rejects with its error. `quiet`: an automatic sync,
   * whose media keeps network errors quiet.
   */
  now(o:{waitMedia?:boolean;quiet?:boolean}={}):Promise<ReturnType<SyncClient["status"]>> {
    if(o.waitMedia)return this.now({quiet:o.quiet}).then(async()=>{await this.mediaSettled();await this.snapshotting;if(this.mediaError)throw new Error(this.mediaError);return this.status();});
    if(this.active)return this.active;
    this.busy=true;
    this.active=this.run(!!o.quiet).then(()=>(this.error=null,this.meter.progress=null,{...this.status(),busy:false})).catch(e=>{this.error=e.message;throw e;}).finally(()=>{this.busy=false;this.active=null;this.meter.progress=null;});
    return this.active;
  }
  async auto(o:{pendingOnly?:boolean}={}) {const st=this.status();if(!st.configured||!st.unlocked)return;if(o.pendingOnly&&!st.pending)return;try{await this.now({quiet:true});}catch(e){if(offline(e))this.error=null;}}
  /** Resolves once no media task runs, extra passes included. */
  async mediaSettled() {while(this.mediaTask)await this.mediaTask;}
  /** Asks the media task to stop after what it is writing, and waits for it. Its work so far stays. */
  private async stopMedia() {const task=this.mediaTask;if(!task)return;this.mediaStop?.abort();await task;}
  /** Starts the media task, or asks the one running for another pass when new media came in. */
  private startMedia(t:Transport,key:SyncKeys,news:boolean,quiet:boolean) {
    if(this.mediaTask){if(news)this.mediaAgain=true;return;}
    const stop=new AbortController();this.mediaStop=stop;this.mediaAgain=false;this.mediaError=null;
    const passes=async()=>{let force=news;do{this.mediaAgain=false;await this.media(t,key,stop.signal,force);force=true;}while(this.mediaAgain&&!stop.signal.aborted);};
    this.mediaTask=passes().then(()=>{this.mediaError=null;},e=>{
      // The next sync looks at every file again.
      this.scanned=0;
      if(stop.signal.aborted)return;
      this.mediaError=quiet&&offline(e)?null:(e as Error)?.message??String(e);
    }).finally(()=>{this.mediaTask=null;this.mediaStop=null;this.mediaMeter.progress=null;});
  }
  private async run(quiet:boolean) {
    const vk=this.secrets().vk;if(!vk)throw new Error("unlock Sync first");const t=this.transport();const db=this.e.db;
    // Derived once: each event and blob of this run is encrypted or decrypted with these.
    const key=await syncKeys(fromB64(vk));
    // Drain writes before the first await. Further local writes are drained again before projection.
    drain(db);
    let cursor=this.meta("cursor","");let more=true;
    // Whether media or blob events came in: a media task already running then makes another pass.
    let news=false;
    // A device that has never pulled starts from the vault's snapshot, when there is one, and then pulls the events after it.
    if(cursor===""&&t.snapshot){const seq=await this.fromSnapshot(t,key);if(seq!==null){cursor=String(seq);news=true;}}
    // A device that has never pulled downloads about the whole vault.
    this.step("download",cursor===""?await t.usage?.()??null:null);
    // The ids this device has, loaded once and only if a transport asks: a folder lists every file name each time.
    let have:Set<string>|null=null;
    const seen=(id:string)=>(have??=new Set(db.all("SELECT id FROM sync_events").map(r=>r.id as string))).has(id);
    while(more) {
      const page=await t.pull(cursor,seen);this.moved(page.events.reduce((n,e)=>n+e.ciphertext.length,0));
      // Only new events are decrypted and applied: the cloud hands back this device's own too.
      const fresh=page.events.filter(event=>!db.get("SELECT 1 FROM sync_events WHERE id=?",event.id));
      // Decrypting is the asynchronous part. The page then goes in with its cursor in one transaction.
      const plain=await Promise.all(fresh.map(async event=>({id:event.id,event:await decryptEvent<Change>(key,event.id,event.ciphertext)})));
      db.tx(()=>{for(const p of plain)receive(db,p.id,p.event);this.set("cursor",page.cursor);});
      this.received+=fresh.length;cursor=page.cursor;more=page.more;
      if(plain.some(p=>p.event.table==="media"||p.event.table==="blob"))news=true;
    }
    // Type assets are part of the card types the projection writes, so their blobs move now. Media files come after.
    await this.assets(t,key);
    // Local changes go up before any media, so other devices don't wait for files.
    drain(db);
    this.step("upload",this.unsentBytes());
    await this.push(t,key);
    // Only the rows whose registers changed, here or on another device, are rewritten; their keys were
    // recorded with the change, so a run that stopped before this step leaves them for the next.
    drain(db);
    if(projectionPending(this.e)) {
      // Let a status request see this step before the projection holds the thread.
      this.step("apply");await new Promise(r=>setTimeout(r,0));
      // No await while projecting. SQL triggers are muted only for this transaction.
      drain(db);projectChanges(this.e);
    }
    this.set("config",{...this.config(),lastSync:new Date().toISOString()});
    // The collection is in step. The media follows in the background, and on the desktop a new snapshot when one is due.
    this.startMedia(t,key,news,quiet);
    this.startSnapshot(t,key);
    return this.status();
  }
  /**
   * Merges the vault's snapshot into a device that has never pulled and returns the seq it covers, or null when there
   * is none. Parts merged by a run that stopped are skipped. A snapshot that can't be read falls back to the whole log,
   * which gives the same registers: what merged already merges again harmlessly.
   */
  private async fromSnapshot(t:Transport,key:SyncKeys):Promise<number|null> {
    for(let attempt=0;;attempt++) {
      try {return await this.mergeSnapshot(t,key);}
      catch(e) {
        if(offline(e))throw e;
        // A newer snapshot replaced this one while its parts downloaded: take the new one, once.
        if(attempt===0&&(e as any).code==="not_found")continue;
        this.set("snapshot_error",(e as Error)?.message??String(e));
        return null;
      }
    }
  }
  private async mergeSnapshot(t:Transport,key:SyncKeys):Promise<number|null> {
    const db=this.e.db;
    let found;
    // A server without snapshots doesn't have the route.
    try {found=await t.snapshot!();} catch(e) {if((e as any).code==="not_found")return null;throw e;}
    if(!found)return null;
    const p=found.pointer,ref={id:p.id,seq:p.seq};
    const resume=this.meta<{id:string;done:number}|null>("snapshot_progress",null);
    const from=resume?.id===p.id?resume.done:0;
    this.step("snapshot",p.size);
    // The next part downloads while this one merges.
    const load=(i:number)=>{const f=t.getBlob(p.parts[i]).then(ct=>(this.moved(ct.length),decryptSnapshotPart(key,ref,i,ct,p.parts[i])));f.catch(()=>{});return f;};
    let next=from<p.parts.length?load(from):null;
    for(let i=from;i<p.parts.length;i++) {
      const json=await next!;next=i+1<p.parts.length?load(i+1):null;
      db.tx(()=>{
        const part=mergeSnapshotPart(db,json);
        if(part.part!==i||part.last!==(i===p.parts.length-1))throw new Error("the snapshot's parts don't match its pointer");
        this.set("snapshot_progress",{id:p.id,done:i+1});this.received+=part.registers;
      });
    }
    db.tx(()=>{finishSnapshot(db);this.set("cursor",String(p.seq));this.set("snapshot",{seq:p.seq});db.run("DELETE FROM sync_meta WHERE key IN ('snapshot_progress','snapshot_error')");});
    return p.seq;
  }
  /** The snapshot being made, one at a time. */
  private snapshotting:Promise<void>|null=null;
  /** On the desktop: a new snapshot once the log has grown enough since the last one. It runs in the background. */
  private startSnapshot(t:Transport,key:SyncKeys) {
    if(this.snapshotting||!t.putSnapshot||!globalThis.process?.versions?.node)return;
    if(Number(this.meta("cursor","0"))-this.meta("snapshot",{seq:0}).seq<snapshotEvery())return;
    // Kept for diagnosis; the collection may have closed meanwhile.
    this.snapshotting=this.makeSnapshot(t,key).catch(e=>{try{if(!offline(e))this.set("snapshot_error",(e as Error)?.message??String(e));}catch{}}).finally(()=>{this.snapshotting=null;});
  }
  private async makeSnapshot(t:Transport,key:SyncKeys) {
    const db=this.e.db;
    // The media task sends its own events; the snapshot waits for them.
    await this.mediaSettled();
    // Parts an earlier attempt uploaded without getting to point the vault at them.
    for(const name of this.meta<string[]>("snapshot_uploads",[]))await t.deleteBlob?.(name).catch(()=>{});
    this.set("snapshot_uploads",[]);
    let found;
    try {found=await t.snapshot!();}
    // A server without snapshots (the route isn't there): ask again only after as many events again.
    catch(e) {if((e as any).code==="not_found"){this.set("snapshot",{seq:Number(this.meta("cursor","0"))});return;}throw e;}
    const there=found?.pointer.seq??0;this.set("snapshot",{seq:there});
    // Read in one go, with nothing waiting to be sent: the registers then hold exactly the events up to the cursor
    // and this device's own, which are on the server too.
    if(db.get("SELECT (SELECT count(*) FROM sync_outbox)+(SELECT count(*) FROM sync_events WHERE sent=0) AS n")!.n)return;
    const seq=Number(this.meta("cursor","0"));
    if(seq-there<snapshotEvery())return;
    const parts=snapshotParts(db,partRegisters());
    const ref={id:toHex(randomBytes(16)),seq},names:string[]=[];
    try {
      for(let i=0;i<parts.length;i++) {
        const b=await encryptSnapshotPart(key,ref,i,parts[i]);parts[i]="";
        this.set("snapshot_uploads",[...names,b.hash]);await t.putBlob(b.hash,b.ciphertext);names.push(b.hash);
      }
      await t.putSnapshot!({...ref,parts:names},found?.etag);
      this.set("snapshot",{seq});this.set("snapshot_uploads",[]);
      db.run("DELETE FROM sync_meta WHERE key='snapshot_error'");
    } catch(e) {
      // Another device's snapshot got there first, or the upload stopped: these parts are of no use.
      if(offline(e))throw e;
      for(const name of names)await t.deleteBlob?.(name).catch(()=>{});
      this.set("snapshot_uploads",[]);
      if(["etag_mismatch","not_newer"].includes((e as any).code))return;
      throw e;
    }
  }
  /** Sends the events not sent yet, in batches, after any push already under way. */
  private push(t:Transport,key:SyncKeys,m=this.meter) {
    const turn=this.pushing.then(()=>this.pushNow(t,key,m));
    this.pushing=turn.catch(()=>{});
    return turn;
  }
  private async pushNow(t:Transport,key:SyncKeys,m:Meter) {
    const db=this.e.db;
    for(;;) {
      const batch=db.all("SELECT * FROM sync_events WHERE sent=0 ORDER BY id LIMIT 200");if(!batch.length)break;
      // etude-cloud refuses push bodies over 8 MiB, so a batch also stops at ~6 MiB of ciphertext.
      const events=[];const sent:any[]=[];const made:[string,string][]=[];let bytes=0;
      for(const r of batch) {const ciphertext=r.ciphertext??await encryptEvent(key,r.id,JSON.parse(r.body));if(!r.ciphertext)made.push([ciphertext,r.id]);if(events.length&&bytes+ciphertext.length>PUSH_BATCH_BYTES)break;events.push({id:r.id,ciphertext});sent.push(r);bytes+=ciphertext.length;}
      // Kept before sending, so a retry sends the same ciphertext; one transaction for the batch.
      db.tx(()=>{for(const [ciphertext,id] of made)db.run("UPDATE sync_events SET ciphertext=? WHERE id=?",ciphertext,id);});
      await t.push(events);this.moved(bytes,m);db.tx(()=>{for(const r of sent)db.run("UPDATE sync_events SET sent=1 WHERE id=?",r.id);});
    }
  }
  /**
   * Type assets keep their bytes in sync_blobs, where the projection reads them. Downloads those this device
   * lacks and uploads its own new ones, each with its blob event, before the events that name them are sent.
   * One whose blob event hasn't arrived waits: the projection leaves it out until a later sync.
   */
  private async assets(t:Transport,key:SyncKeys) {
    const db=this.e.db;
    const wanted=db.all(`SELECT DISTINCT json_extract(value,'$') hash FROM sync_registers WHERE tbl='type_assets' AND field='/hash' AND key NOT IN (SELECT key FROM sync_deleted WHERE tbl='type_assets') AND json_extract(value,'$') NOT IN (${STORED})`).map(r=>r.hash as string);
    const unsent=db.all(`SELECT DISTINCT hash FROM type_assets WHERE hash NOT IN (${STORED})`).map(r=>r.hash as string);
    const jobs:(()=>Promise<void>)[]=[];
    for(const hash of unsent) jobs.push(async()=>{
      const bytes=new Uint8Array(db.get("SELECT bytes FROM type_assets WHERE hash=? LIMIT 1",hash)!.bytes);
      let name=rowFor(db,"blob",hash)?.name as string|undefined;
      if(!name) {const b=await encryptBlob(key,bytes);await t.putBlob(b.hash,b.ciphertext);this.moved(b.ciphertext.length);name=b.hash;localEvent(db,"blob",hash,{"/name":name});}
      db.run("INSERT INTO sync_blobs VALUES(?,?,?) ON CONFLICT(hash) DO UPDATE SET name=excluded.name,bytes=excluded.bytes",hash,name,bytes);
    });
    for(const hash of wanted) {
      const name=rowFor(db,"blob",hash)?.name as string|undefined;
      if(!name||unsent.includes(hash))continue;
      jobs.push(async()=>{
        const ciphertext=await t.getBlob(name);this.moved(ciphertext.length);const bytes=await decryptBlob(key,ciphertext,name);
        if(await sha256Hex(bytes)!==hash)throw new Error("plaintext blob hash mismatch");
        db.run("INSERT INTO sync_blobs VALUES(?,?,?) ON CONFLICT(hash) DO UPDATE SET name=excluded.name,bytes=excluded.bytes",hash,name,bytes);
      });
    }
    await pool(jobs,BLOB_CONCURRENCY,run=>run());
  }
  /** When this process last looked at every media file. */
  private scanned=0;
  /**
   * Brings media files in step with the registers and sends their events: the media task, in the background
   * after the collection. Skipped when no media event came in or is pending and no media folder had a file
   * added, removed or renamed, unless `force`. A folder's modification time doesn't change when a file in it is
   * rewritten in place, so every file is also looked at on the first sync of a process and at least every few
   * minutes. Stops between files when `stop` is aborted; what it wrote or sent so far stays consistent.
   */
  private async media(t:Transport,key:SyncKeys,stop:AbortSignal,force:boolean) {
    const db=this.e.db,m=this.mediaMeter,dirs=this.meta<Record<string,number>>("media_dirs",{});
    const go=()=>{if(stop.aborted)throw new Stopped();};
    const mtime=(dir:string)=>{try{return statSync(join(this.e.mediaDir,dir)).mtimeMs;}catch{return -1;}};
    // The marks this pass answers for; one a later event adds stays for the next.
    const marked=db.all("SELECT tbl,key,field FROM sync_dirty WHERE tbl IN ('media','blob')");
    const quiet=!force && Date.now()-this.scanned<MEDIA_RESCAN_MS && Object.keys(dirs).length>0 && Object.entries(dirs).every(([dir,mt])=>mtime(dir)===mt) && !marked.length;
    if(quiet)return;
    // Each folder's time is taken before it is read, so a file added meanwhile makes the next sync look again.
    const files:[string,string][]=[],snapshot:Record<string,number>={"":mtime("")};
    const list=(dir:string,prefix="") => {
      if(!existsSync(dir))return;
      snapshot[prefix]=mtime(prefix);
      for(const d of readdirSync(dir,{withFileTypes:true})){
        const p=join(dir,d.name),relative=prefix+d.name;
        // Never a media file: a download in progress, or one a closed app left behind.
        if(d.name.startsWith(PARTIAL)){try{if(Date.now()-statSync(p).mtimeMs>PARTIAL_STALE_MS)rmSync(p,{force:true});}catch{}continue;}
        if(d.isSymbolicLink()?statSync(p).isDirectory():d.isDirectory())list(p,relative+"/");else if(safeMediaPath(relative))files.push([p,relative]);
      }
    };
    list(this.e.mediaDir);
    // Hash the media on disk first, so a file another device already uploaded is neither downloaded nor uploaded again.
    this.step("check",files.length,m);
    const onDisk=new Map<string,string>(),local=new Map<string,string>();
    // Hashes are kept with each file's size and modification time, so only new or changed files are read again.
    db.sql.exec("CREATE TABLE IF NOT EXISTS sync_media_hashes (file TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime REAL NOT NULL, hash TEXT NOT NULL)");
    const known=new Map(db.all<{file:string;size:number;mtime:number;hash:string}>("SELECT file,size,mtime,hash FROM sync_media_hashes").map(r=>[r.file,r]));
    const fresh:[string,number,number,string][]=[],named=new Map<string,string>();
    for(const [p,relative] of files) {
      // Files Etude stores itself are named by their SHA-256; the name is checked below against the registers.
      let hash=/^files\/([0-9a-f]{64})(\.[^/]*)?$/.exec(relative)?.[1]??"";
      if(hash)named.set(relative,p);
      else {
        const st=statSync(p),k=known.get(relative);
        hash=k&&k.size===st.size&&k.mtime===st.mtimeMs?k.hash:"";
        if(!hash){go();hash=await sha256Hex(new Uint8Array(await readFile(p)));fresh.push([relative,st.size,st.mtimeMs,hash]);}
      }
      onDisk.set(relative,hash);local.set(hash,p);this.moved(1,m);
    }
    db.tx(()=>{for(const f of fresh)db.run("INSERT INTO sync_media_hashes VALUES(?,?,?,?) ON CONFLICT(file) DO UPDATE SET size=excluded.size,mtime=excluded.mtime,hash=excluded.hash",...f);for(const file of known.keys())if(!onDisk.has(file)||file.startsWith("files/"))db.run("DELETE FROM sync_media_hashes WHERE file=?",file);});
    // A file named by its hash is trusted until its bytes are used: then they are checked.
    const readLocal=async(hash:string):Promise<Uint8Array|null>=>{const p=local.get(hash);if(!p)return null;const bytes=new Uint8Array(await readFile(p));return await sha256Hex(bytes)===hash?bytes:null;};
    go();this.step("download",null,m);
    // Read the registers once: a collection can hold tens of thousands of media files.
    const blobs=rows(db,"blob"),media=rows(db,"media");
    // The version of each media file this device last had in step with the registers. A file that still matches it
    // wasn't edited here, so a newer version from another device replaces it; one that doesn't is uploaded below.
    db.sql.exec("CREATE TABLE IF NOT EXISTS sync_media_seen (file TEXT PRIMARY KEY, hash TEXT NOT NULL)");
    const seen=new Map<string,string>(db.all("SELECT file,hash FROM sync_media_seen").map(r=>[r.file,r.hash]));
    // A name that matches neither the registers nor the version last in step with them is read: the file is new, or its name is wrong.
    for(const [relative,p] of named) {
      const hash=onDisk.get(relative)!;if(hash===media.get(relative)?.hash||hash===seen.get(relative))continue;
      const real=await sha256Hex(new Uint8Array(await readFile(p)));
      if(real!==hash){onDisk.set(relative,real);if(local.get(hash)===p)local.delete(hash);local.set(real,p);}
    }
    const edited=(file:string)=>onDisk.has(file)&&onDisk.get(file)!==media.get(file)?.hash&&onDisk.get(file)!==seen.get(file);
    // Media files to fetch, by blob, written as soon as their blob arrives.
    const root=resolve(this.e.mediaDir),wanted=new Map<string,string[]>();
    for(const [file,r] of media) if(safeMediaPath(file)&&resolve(root,file).startsWith(root+sep)&&onDisk.get(file)!==r.hash&&!edited(file))wanted.set(r.hash,[...wanted.get(r.hash)??[],file]);
    const write=(file:string,hash:string,bytes:Uint8Array)=>{const path=join(this.e.mediaDir,file);mkdirSync(dirname(path),{recursive:true});writeAtomic(path,bytes);onDisk.set(file,hash);};
    // A file whose blob event hasn't arrived waits for a later sync.
    const fetch=new Map<string,string>();let waiting=false;
    for(const hash of wanted.keys()) {const name=blobs.get(hash)?.name;if(name)fetch.set(hash,name);else waiting=true;}
    await pool([...fetch],BLOB_CONCURRENCY,async([hash,name])=>{
      go();
      let bytes:Uint8Array|null=await readLocal(hash);
      if(!bytes) {const ciphertext=await t.getBlob(name,stop);this.moved(ciphertext.length,m);bytes=await decryptBlob(key,ciphertext,name);if(await sha256Hex(bytes)!==hash)throw new Error("plaintext blob hash mismatch");}
      go();
      const files=wanted.get(hash)??[];
      for(const file of files)write(file,hash,bytes);
      this.mediaReceived+=files.length;
    });
    go();
    const changed=files.filter(([,relative])=>edited(relative));
    const sizes=new Map<string,number>();
    for(const [p,relative] of changed) {const hash=onDisk.get(relative)!;if(!blobs.has(hash))sizes.set(hash,statSync(p).size+BLOB_OVERHEAD);}
    const up=this.step("upload",[...sizes.values()].reduce((a,b)=>a+b,0),m);
    // One upload per distinct file content, a few at a time. A file's event carries the hash of the bytes sent.
    const firstPath=new Map<string,string>();for(const [p,relative] of changed)if(!firstPath.has(onDisk.get(relative)!))firstPath.set(onDisk.get(relative)!,p);
    // This pass's own events are in step as they are made: their marks go with the ones it answers for.
    const sent=new Map<string,string>(),mine:[string,string][]=[];
    await pool([...firstPath],BLOB_CONCURRENCY,async([hash,p])=>{
      go();
      const bytes=new Uint8Array(await readFile(p)),real=await sha256Hex(bytes);
      // The blob goes up before the event that names it.
      if(!blobs.has(real)) {const b=await encryptBlob(key,bytes);await t.putBlob(b.hash,b.ciphertext,stop);this.moved(b.ciphertext.length,m);localEvent(db,"blob",real,{"/name":b.hash});mine.push(["blob",real]);blobs.set(real,{name:b.hash});}
      sent.set(hash,real);
    });
    go();
    db.tx(()=>{for(const [,relative] of changed){const hash=sent.get(onDisk.get(relative)!)!;onDisk.set(relative,hash);localEvent(db,"media",relative,{"/hash":hash});mine.push(["media",relative]);}});
    drain(db);
    db.tx(()=>{
      for(const [file,r] of rows(db,"media"))if(onDisk.get(file)===r.hash && seen.get(file)!==r.hash)db.run("INSERT INTO sync_media_seen VALUES(?,?) ON CONFLICT(file) DO UPDATE SET hash=excluded.hash",file,r.hash);
      // Everything that came in is on disk now, unless a blob's event is still on its way.
      if(!waiting)for(const r of marked)db.run("DELETE FROM sync_dirty WHERE tbl=? AND key=? AND field=?",r.tbl,r.key,r.field);
      for(const [tbl,key] of mine)db.run("DELETE FROM sync_dirty WHERE tbl=? AND key=?",tbl,key);
      this.set("media_dirs",snapshot);
    });
    this.scanned=Date.now();
    // The media and blob events made above.
    up.total=up.done+this.unsentBytes();
    await this.push(t,key,m);
  }
}
