import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import type { VaultKeys } from "./crypto.ts";

export type WireEvent = {id:string;ciphertext:string};
export interface Transport {
  keys(): Promise<{keys:VaultKeys;etag:string}|null>;
  putKeys(keys:VaultKeys,etag?:string): Promise<void>;
  push(events:WireEvent[]): Promise<void>;
  pull(cursor:string): Promise<{events:WireEvent[];cursor:string;more:boolean}>;
  putBlob(name:string,bytes:Uint8Array): Promise<void>;
  getBlob(name:string): Promise<Uint8Array>;
  /** Bytes stored on the server, when it says. */
  usage?(): Promise<number|null>;
}
const VALID = /^[\w:.-]{1,128}$/;
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
      const file=join(dir,e.id+".json");
      if (existsSync(file)) continue;
      const temp=file+".tmp";
      writeFileSync(temp,JSON.stringify(e),{mode:0o600});
      renameSync(temp,file);
    }
  }
  async pull(_cursor:string) {
    const events:WireEvent[]=[];
    const root=join(this.folder,"events");
    if (existsSync(root)) for (const dev of readdirSync(root)) if (VALID.test(dev)) for (const file of readdirSync(join(root,dev))) if (file.endsWith(".json") && VALID.test(file.slice(0,-5))) events.push(JSON.parse(readFileSync(join(root,dev,file),"utf8")));
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
    const res=await fetch(this.server+path,{...opts,headers,signal:AbortSignal.timeout(60_000)});
    if (!res.ok) {
      const body:any=await res.json().catch(()=>null);
      const error=new Error(body?.error?.message ?? `Sync server returned ${res.status}`);
      (error as any).code=body?.error?.code;
      throw error;
    }
    return res;
  }
  async json(path:string,body:unknown) { return (await this.request(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})).json(); }
  async keys() {
    try { const r=await this.request("/v1/vault/keys");return {keys:await r.json() as VaultKeys,etag:r.headers.get("etag")!}; }
    catch(e) { if ((e as any).code === "no_keys") return null;throw e; }
  }
  async putKeys(keys:VaultKeys,etag?:string) { await this.request("/v1/vault/keys",{method:"PUT",headers:{"Content-Type":"application/json",...(etag?{"If-Match":etag}:{})},body:JSON.stringify(keys)}); }
  async push(events:WireEvent[]) { if (events.length) await this.json("/v1/sync/events",{events}); }
  async pull(cursor:string) { const r:any=await (await this.request(`/v1/sync/events?after=${Number(cursor)||0}&limit=500`)).json();return {...r,cursor:String(r.cursor)}; }
  async putBlob(name:string,bytes:Uint8Array) { await this.request("/v1/blobs/"+name,{method:"PUT",body:new Uint8Array(bytes)}); }
  async getBlob(name:string) { return new Uint8Array(await (await this.request("/v1/blobs/"+name)).arrayBuffer()); }
  async usage() { try { const r:any=await (await this.request("/v1/vault")).json();return r.usedBytes||null; } catch { return null; } }
}
