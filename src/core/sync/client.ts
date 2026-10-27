import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Etude } from "../engine.ts";
import { bootstrap, drain, install, localEvent, receive, rows, type Change } from "./log.ts";
import { createVault, decryptBlob, decryptEvent, encryptBlob, encryptEvent, fromB64, sha256Hex, toB64, unwrapWithPassword, unwrapWithRecovery } from "./crypto.ts";
import { CloudTransport, FolderTransport, type Transport } from "./transport.ts";
import { project } from "./project.ts";

type Config = { kind:"cloud"|"folder";server?:string;folder?:string;email?:string;enabled:boolean;hasKeys?:boolean;lastSync?:string };
type Secrets = { token?:string;vk?:string };
const clients=new WeakMap<Etude,SyncClient>();
export function syncFor(e:Etude) { let s=clients.get(e);if(!s) {s=new SyncClient(e);clients.set(e,s);}return s; }
export class SyncClient {
  readonly e:Etude;
  busy=false;
  error:string|null=null;
  private active:Promise<any>|null=null;
  constructor(e:Etude) { this.e=e; }
  private initialized() { return !!this.e.db.get("SELECT 1 FROM sqlite_master WHERE name='sync_control'"); }
  private meta<T>(key:string,fallback:T):T { const r=this.initialized()?this.e.db.get("SELECT value FROM sync_meta WHERE key=?",key):null;return r?JSON.parse(r.value):fallback; }
  private set(key:string,value:unknown) {this.e.db.run("INSERT INTO sync_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",key,JSON.stringify(value));}
  private config() {return this.meta<Config|null>("config",null);}
  private secretFile() { const dev=this.e.db.get("SELECT device FROM sync_control WHERE id=1")!.device;return join(this.e.home,"sync",dev+".json"); }
  private secrets():Secrets {if(!this.initialized())return {};const f=this.secretFile();return existsSync(f)?JSON.parse(readFileSync(f,"utf8")):{};}
  private saveSecrets(s:Secrets) {const f=this.secretFile();mkdirSync(dirname(f),{recursive:true,mode:0o700});writeFileSync(f+".tmp",JSON.stringify(s),{mode:0o600});chmodSync(f+".tmp",0o600);renameSync(f+".tmp",f);}
  status() {const cfg=this.config();const sec=this.secrets();return {configured:!!cfg?.enabled,kind:cfg?.kind??null,server:cfg?.server,folder:cfg?.folder,email:cfg?.email,signedIn:!!sec.token,unlocked:!!sec.vk,hasKeys:cfg?.kind==="folder" ? existsSync(join(cfg.folder!,"keys.json")) : !!cfg?.hasKeys,lastSync:cfg?.lastSync??null,busy:this.busy,error:this.error,pending:this.initialized()?this.e.db.get("SELECT (SELECT count(*) FROM sync_outbox)+(SELECT count(*) FROM sync_events WHERE sent=0) AS n")!.n:0};}
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
  private transport():Transport {const c=this.config();if(!c?.enabled)throw new Error("set up Sync first");if(c.kind==="folder")return new FolderTransport(c.folder!,this.e.db.get("SELECT device FROM sync_control WHERE id=1")!.device);const s=this.secrets();if(!s.token)throw new Error("sign in first");return new CloudTransport(c.server!,s.token);}
  async signin(email:string) {const c=this.config();if(c?.kind!=="cloud")throw new Error("choose a Sync server first");await new CloudTransport(c.server!,"").json("/v1/auth/email/start",{email});this.set("config",{...c,email});return this.status();}
  async verify(code:string) {const c=this.config();if(c?.kind!=="cloud")throw new Error("choose a Sync server first");const r:any=await new CloudTransport(c.server!,"").json("/v1/auth/email/verify",{token:code.trim(),deviceName:process.versions?.node?"Etude desktop":"Etude browser"});this.saveSecrets({token:r.token});const k=await this.transport().keys();this.set("config",{...c,email:r.account.email,hasKeys:!!k});return this.status();}
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
  async off() {if(this.active)await this.active.catch(()=>{});const c=this.config();if(c?.kind==="cloud" && this.secrets().token) { try { await (this.transport() as CloudTransport).json("/v1/auth/logout",{}); } catch { this.error="Signed out locally. This device could not be revoked on the server while offline."; } } if(c)this.set("config",{...c,enabled:false});if(this.initialized())rmSync(this.secretFile(),{force:true});return this.status();}
  now() {if(this.active)return this.active;this.busy=true;this.error=null;this.active=this.run().then(()=>({...this.status(),busy:false})).catch(e=>{this.error=e.message;throw e;}).finally(()=>{this.busy=false;this.active=null;});return this.active;}
  async auto() {if(!this.status().configured||!this.status().unlocked)return;try{await this.now();}catch(e){if(e instanceof TypeError || /fetch failed|network|offline|timeout/i.test((e as Error).message))this.error=null;}}
  private async run() {
    const vk=this.secrets().vk;if(!vk)throw new Error("unlock Sync first");const key=fromB64(vk);const t=this.transport();const db=this.e.db;
    // Drain writes before the first await. Further local writes are drained again before projection.
    drain(db);
    let cursor=this.meta("cursor","");let more=true;
    while(more) {const page=await t.pull(cursor);for(const event of page.events)receive(db,event.id,await decryptEvent<Change>(key,event.id,event.ciphertext));cursor=page.cursor;more=page.more;this.set("cursor",cursor);}
    // Pull mappings first so another device's encrypted copy can be reused.
    const addBlob=async(bytes:Uint8Array) => {
      const hash=await sha256Hex(bytes);let name=rows(db,"blob").get(hash)?.name;
      if(!name) {const b=await encryptBlob(key,bytes);await t.putBlob(b.hash,b.ciphertext);name=b.hash;localEvent(db,"blob",hash,{"/name":name});}
      db.run("INSERT INTO sync_blobs VALUES(?,?,?) ON CONFLICT(hash) DO UPDATE SET name=excluded.name,bytes=excluded.bytes",hash,name,bytes);
      return hash;
    };
    for(const asset of db.all("SELECT hash,bytes FROM type_assets")) if(!db.get("SELECT 1 FROM sync_blobs WHERE hash=?",asset.hash))await addBlob(new Uint8Array(asset.bytes));
    const walk=async(dir:string,prefix="") => {if(!existsSync(dir))return;for(const name of readdirSync(dir)){const p=join(dir,name),relative=prefix+name;if(statSync(p).isDirectory())await walk(p,relative+"/");else{const bytes=new Uint8Array(readFileSync(p));const hash=await sha256Hex(bytes);if(rows(db,"media").get(relative)?.hash!==hash){await addBlob(bytes);localEvent(db,"media",relative,{"/hash":hash});}}}};
    await walk(this.e.mediaDir);
    drain(db);
    const mappings=rows(db,"blob");
    for(const [hash,r] of mappings) if(!db.get("SELECT 1 FROM sync_blobs WHERE hash=?",hash)) {const bytes=await decryptBlob(key,await t.getBlob(r.name),r.name);if(await sha256Hex(bytes)!==hash)throw new Error("plaintext blob hash mismatch");db.run("INSERT INTO sync_blobs VALUES(?,?,?)",hash,r.name,bytes);}
    for(const [file,r] of rows(db,"media")) {if(!/^[\w./-]+$/.test(file)||file.split("/").some(p=>p===".."||p===""))throw new Error("invalid media path");const b=db.get("SELECT bytes FROM sync_blobs WHERE hash=?",r.hash);if(!b)throw new Error("missing media blob");const path=join(this.e.mediaDir,file);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,b.bytes);}
    for(;;) {
      const batch=db.all("SELECT * FROM sync_events WHERE sent=0 ORDER BY id LIMIT 200");if(!batch.length)break;
      const events=[];
      for(const r of batch) {const ciphertext=r.ciphertext??await encryptEvent(key,r.id,JSON.parse(r.body));if(!r.ciphertext)db.run("UPDATE sync_events SET ciphertext=? WHERE id=?",ciphertext,r.id);events.push({id:r.id,ciphertext});}
      await t.push(events);db.tx(()=>{for(const r of batch)db.run("UPDATE sync_events SET sent=1 WHERE id=?",r.id);});
    }
    // No await while rebuilding. SQL triggers are muted only for this transaction.
    drain(db);project(this.e);
    this.set("config",{...this.config(),lastSync:new Date().toISOString()});return this.status();
  }
}
