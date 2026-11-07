import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import type { VaultKeys } from "./crypto.ts";
import { AccountError } from "../account.ts";

export type WireEvent = {id:string;ciphertext:string};
const toB64Url=(b:Uint8Array)=>btoa(String.fromCharCode(...b)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const fromB64Url=(s:string)=>Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")),(c)=>c.charCodeAt(0));

export interface Transport {
  keys(): Promise<{keys:VaultKeys;etag:string}|null>;
  putKeys(keys:VaultKeys,etag?:string): Promise<void>;
  push(events:WireEvent[]): Promise<void>;
  /** `seen` tells which event ids this device already has, for a transport that can skip them before reading them. */
  pull(cursor:string,seen?:(id:string)=>boolean): Promise<{events:WireEvent[];cursor:string;more:boolean}>;
  /** `signal` stops a transfer that is no longer wanted. */
  putBlob(name:string,bytes:Uint8Array,signal?:AbortSignal): Promise<void>;
  getBlob(name:string,signal?:AbortSignal): Promise<Uint8Array>;
  /** Bytes stored on the server, when it says. */
  usage?(): Promise<number|null>;
  /** The vault's latest snapshot and its ETag, or null when it has none. Only a server keeps snapshots. */
  snapshot?(): Promise<{pointer:SnapshotPointer;etag:string}|null>;
  /** Points the vault at a new snapshot whose parts are uploaded already; `etag` is the one read, none for the first. Returns the new ETag. */
  putSnapshot?(s:{id:string;seq:number;parts:string[]},etag?:string): Promise<string>;
  deleteBlob?(name:string): Promise<void>;
}
/** etude-cloud's pointer to a snapshot: the seq it covers and its parts (blob names), in order. */
export type SnapshotPointer = {v:1;id:string;seq:number;parts:string[];size:number};
const VALID = /^[\w:.-]{1,128}$/;
/** An event's file name: its id with "~" for ":", which Windows doesn't allow in file names. */
const eventFile = (id: string) => id.replaceAll(":", "~") + ".json";
/** Tries per request while the server answers 429 Too Many Requests. */
const RATE_LIMIT_ATTEMPTS = 30;
export class FolderTransport implements Transport {
  readonly folder:string;
  readonly device:string;
  constructor(folder:string,device:string) { this.folder=folder;this.device=device;mkdirSync(folder,{recursive:true}); }
  async keys() {
    const file=join(this.folder,"keys.json");
    return existsSync(file) ? {keys:JSON.parse(readFileSync(file,"utf8")),etag:"1"} : null;
  }
  async putKeys(keys:VaultKeys,etag?:string) {
    if (etag) throw new Error("folder password rotation is not available");
    writeFileSync(join(this.folder,"keys.json"),JSON.stringify(keys),{flag:"wx",mode:0o600});
  }
  async push(events:WireEvent[]) {
    const dir=join(this.folder,"events",this.device);
    mkdirSync(dir,{recursive:true});
    for (const e of events) {
      if (!VALID.test(e.id)) throw new Error("invalid event id");
      const file=join(dir,eventFile(e.id));
      if (existsSync(file) || (process.platform!=="win32" && existsSync(join(dir,e.id+".json")))) continue;
      const temp=file+".tmp";
      writeFileSync(temp,JSON.stringify(e),{mode:0o600});
      renameSync(temp,file);
    }
  }
  /**
   * Lists every device's event files and reads only those `seen` doesn't know. Files can arrive in any
   * order (a sync program copies them as it likes), so each pull lists all names rather than resuming.
   */
  async pull(_cursor:string,seen:(id:string)=>boolean=()=>false) {
    const events:WireEvent[]=[];
    const root=join(this.folder,"events");
    if (existsSync(root)) for (const dev of readdirSync(root)) if (VALID.test(dev)) for (const file of readdirSync(join(root,dev))) {
      const id=file.slice(0,-5).replaceAll("~",":");
      if (file.endsWith(".json") && VALID.test(id) && !seen(id)) events.push(JSON.parse(readFileSync(join(root,dev,file),"utf8")));
    }
    return {events,cursor:"",more:false};
  }
  async putBlob(name:string,bytes:Uint8Array) {
    const file=this.blob(name);
    mkdirSync(dirname(file),{recursive:true});
    if (existsSync(file)) return;
    writeFileSync(file+".tmp",bytes);
    renameSync(file+".tmp",file);
  }
  private blob(name:string) { if (!/^[a-f0-9]{64}$/.test(name)) throw new Error("invalid blob name"); return join(this.folder,"blobs",name); }
  async getBlob(name:string) { return new Uint8Array(readFileSync(this.blob(name))); }
}
export class CloudTransport implements Transport {
  readonly server:string;
  readonly token:string;
  constructor(server:string,token:string) { this.server=server;this.token=token; }
  async request(path:string,opts:RequestInit={}) {
    const headers=new Headers(opts.headers);
    if (this.token) headers.set("Authorization",`Bearer ${this.token}`);
    let res:Response;
    for (let attempt=1;;attempt++) {
      opts.signal?.throwIfAborted();
      const timeout=AbortSignal.timeout(60_000);
      res=await fetch(this.server+path,{...opts,headers,signal:opts.signal&&AbortSignal.any?AbortSignal.any([opts.signal,timeout]):timeout});
      if (res.status!==429 || attempt>=RATE_LIMIT_ATTEMPTS) break;
      // The server limits requests per client address; wait as long as it says, with jitter so parallel transfers spread out.
      await res.body?.cancel();
      const wait=Math.min(60,Number(res.headers.get("retry-after"))||1);
      await new Promise(r=>setTimeout(r,wait*1000+Math.random()*1000));
    }
    if (!res.ok) {
      const body:any=await res.json().catch(()=>null);
      throw new AccountError(body?.error?.message ?? `Sync server returned ${res.status}`,res.status,body?.error?.code??"error",body?.error??{});
    }
    return res;
  }
  async json(path:string,body:unknown) { return (await this.request(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})).json(); }
  async keys() {
    try { const r=await this.request("/v1/vault/keys");return {keys:await r.json() as VaultKeys,etag:r.headers.get("etag")!}; }
    catch(e) { if ((e as any).code === "no_keys") return null;throw e; }
  }
  async putKeys(keys:VaultKeys,etag?:string) { await this.request("/v1/vault/keys",{method:"PUT",headers:{"Content-Type":"application/json",...(etag?{"If-Match":etag}:{})},body:JSON.stringify(keys)}); }
  /** Sync without a password: the server keeps the vault key and hands it to a device that signed in recently. */
  async serverKey() { const r:any=await (await this.request("/v1/vault/server-key")).json();return fromB64Url(r.vk); }
  async putServerKey(vk:Uint8Array,etag?:string) { await this.request("/v1/vault/server-key",{method:"PUT",headers:{"Content-Type":"application/json",...(etag?{"If-Match":etag}:{})},body:JSON.stringify({vk:toB64Url(vk)})}); }
  /** Whether this server can keep vault keys (`/v1/server` → sync.withoutPassword). */
  async keepsKeys() { try { const r:any=await (await fetch(this.server+"/v1/server",{signal:AbortSignal.timeout(15_000)})).json();return !!r?.sync?.withoutPassword; } catch { return false; } }
  async push(events:WireEvent[]) { if (events.length) await this.json("/v1/sync/events",{events}); }
  /** The server's largest page; it also stops a page at 8 MiB of ciphertext. */
  async pull(cursor:string) { const r:any=await (await this.request(`/v1/sync/events?after=${Number(cursor)||0}&limit=1000`)).json();return {...r,cursor:String(r.cursor)}; }
  async putBlob(name:string,bytes:Uint8Array,signal?:AbortSignal) { await this.request("/v1/blobs/"+name,{method:"PUT",body:new Uint8Array(bytes),signal}); }
  async getBlob(name:string,signal?:AbortSignal) { return new Uint8Array(await (await this.request("/v1/blobs/"+name,{signal})).arrayBuffer()); }
  async usage() { try { const r:any=await (await this.request("/v1/vault")).json();return r.usedBytes||null; } catch { return null; } }
  async snapshot() {
    try { const r=await this.request("/v1/vault/snapshot");return {pointer:await r.json() as SnapshotPointer,etag:r.headers.get("etag")!}; }
    catch(e) { if ((e as any).code === "no_snapshot") return null;throw e; }
  }
  async putSnapshot(s:{id:string;seq:number;parts:string[]},etag?:string) { const r=await this.request("/v1/vault/snapshot",{method:"PUT",headers:{"Content-Type":"application/json",...(etag?{"If-Match":etag}:{})},body:JSON.stringify(s)});return r.headers.get("etag")!; }
  async deleteBlob(name:string) { await this.request("/v1/blobs/"+name,{method:"DELETE"}); }
}
