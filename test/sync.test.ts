import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { syncFor, writeAtomic } from "../src/core/sync/client.ts";
import { compare, tick, rows, drain, receive, type Change } from "../src/core/sync/log.ts";
import { project } from "../src/core/sync/project.ts";
import { generateVaultKey, encryptBlob, decryptBlob, encryptEvent, decryptEvent, fromB64, syncKeys } from "../src/core/sync/crypto.ts";

const temp=()=>mkdtempSync(join((process.env.TMPDIR ?? tmpdir()),"sync-test-"));
const password="a test Sync password";
const put=(e:Etude,id:string,front="question",back="answer")=>e.upsertItem({id,deck:"Test",type:"basic",fields:{front,back},tags:["test"]});
function canonical(e:Etude) {
  const tables=["presets","decks","types","schedulers","type_folders","type_placement","items","cards","attempts","reviews","tag_meta","settings","type_assets"];
  const result:any={};
  for(const t of tables)result[t]=[...rows(e.db,t)].sort(([a],[b])=>a.localeCompare(b));
  result.state=e.db.all("SELECT item_id,face,state,due,stability,difficulty,reps,lapses,last_review,sched_state FROM cards ORDER BY item_id,face");
  return JSON.parse(JSON.stringify(result));
}
/** The relational view by stable identities (sync ids, item ids, card keys), not local integer handles. */
function relational(e:Etude) {
  const db=e.db,handle=(t:string)=>new Map<number,string>(db.all(`SELECT id,sync_id FROM ${t}`).map(r=>[r.id,r.sync_id]));
  const decks=handle("decks"),cards=handle("cards"),attempts=handle("attempts"),reviews=handle("reviews");
  const bySync=(list:any[])=>list.sort((a,b)=>a.sync_id.localeCompare(b.sync_id));
  const before=(text:string)=>{const b=JSON.parse(text);if("id" in b)b.id=cards.get(b.id);return b;};
  return JSON.parse(JSON.stringify({
    presets:db.all("SELECT * FROM presets ORDER BY id"),
    types:db.all("SELECT * FROM types ORDER BY id"),
    schedulers:db.all("SELECT * FROM schedulers ORDER BY id"),
    type_folders:db.all("SELECT * FROM type_folders ORDER BY path"),
    type_placement:db.all("SELECT * FROM type_placement ORDER BY type_id"),
    tag_meta:db.all("SELECT * FROM tag_meta ORDER BY tag"),
    decks:bySync(db.all("SELECT * FROM decks").map(({id,...r})=>r)),
    items:db.all("SELECT * FROM items ORDER BY id").map(r=>({...r,deck_id:decks.get(r.deck_id)})),
    item_tags:db.all("SELECT * FROM item_tags ORDER BY item_id,tag"),
    cards:bySync(db.all("SELECT * FROM cards").map(({id,...r})=>r)),
    attempts:bySync(db.all("SELECT * FROM attempts").map(({id,...r})=>({...r,card_id:cards.get(r.card_id),review_id:reviews.get(r.review_id)??null}))),
    reviews:bySync(db.all("SELECT * FROM reviews").map(({id,...r})=>({...r,card_id:cards.get(r.card_id),attempt_id:attempts.get(r.attempt_id)??null,card_before:before(r.card_before)}))),
    settings:e.settings(),
    type_assets:db.all("SELECT type_id,name,hash,size,hex(bytes) bytes FROM type_assets ORDER BY type_id,name"),
  }));
}
let copies=0;
/** What a full rebuild makes of the same registers, on a copy of the collection. */
async function rebuilt(e:Etude,dir:string) {
  const file=join(dir,`copy-${copies++}.db`);
  if(e.db.sql.serialize)writeFileSync(file,e.db.sql.serialize());else e.db.run("VACUUM INTO ?",file);
  const copy=await Etude.open(file,{home:join(dir,"copy-home")});
  try{project(copy);return relational(copy);}finally{copy.close();for(const f of [file,file+"-wal",file+"-shm"])rmSync(f,{force:true});}
}
test("HLC handles clock rollback, remote counters and device ties",()=>{
  assert.deepEqual(tick([100,3,"a"],undefined,90),[100,4,"a"]);
  assert.deepEqual(tick([100,3,"a"],[100,8,"b"],90),[100,9,"a"]);
  assert.deepEqual(tick([100,3,"a"],[200,8,"b"],150),[200,9,"a"]);
  assert.ok(compare([100,1,"b"],[100,1,"a"])>0);
});
test("ciphertext binds event ids and checks blob integrity",async()=>{
  const key=generateVaultKey();const ct=await encryptEvent(key,"a",{text:"private"});
  assert.deepEqual(await decryptEvent(key,"a",ct),{text:"private"});await assert.rejects(decryptEvent(key,"b",ct));
  const blob=await encryptBlob(key,new TextEncoder().encode("picture"));assert.equal(new TextDecoder().decode(await decryptBlob(key,blob.ciphertext,blob.hash)),"picture");
  blob.ciphertext[14]^=1;await assert.rejects(decryptBlob(key,blob.ciphertext,blob.hash));
});
test("keys derived once read and write the same ciphertext as the vault key, including an older client's",async()=>{
  const vk=Uint8Array.from({length:32},(_,i)=>i+1),keys=await syncKeys(vk);
  // Made by the version before keys were derived once per sync.
  const event="AeU+O3lGxlK87gD/aCSl3JW0hAdCzW5Hv48ryve5r2CVjm9VYl0H5G2Zi4Nm1omvZselraK0Y7GFzG48g3Wv8kE28azNGrD3jbZ4B3d4XhoMT+mYEF6r4tPvO958z3yOzYmpjZ44tj7TTVfZuxxtJlaj+hZBCQIS3hwkrgYmTjaSxEpXm9lKrxiHSYA=";
  const blob=fromB64("AVxkAIHQvCtzXrg2IL4aXM6569lFYiZAdCvKsm16PaMG6MHciv0q");
  const expected={v:1,table:"items",key:"fixed",stamp:[1800000000000,0,"dev"],fields:{"/fields/front":"older client"}};
  for(const k of [vk,keys]) {
    assert.deepEqual(await decryptEvent(k,"dev:1800000000000:0",event),expected);
    assert.equal(new TextDecoder().decode(await decryptBlob(k,blob)),"older blob");
    await assert.rejects(decryptEvent(k,"dev:1800000000000:1",event));
  }
  const fresh=await encryptEvent(keys,"x",{a:1});assert.deepEqual(await decryptEvent(vk,"x",fresh),{a:1});
  assert.equal(fromB64(fresh).length,fromB64(await encryptEvent(vk,"x",{a:1})).length);
  const b=await encryptBlob(keys,new TextEncoder().encode("new"));assert.equal(new TextDecoder().decode(await decryptBlob(vk,b.ciphertext,b.hash)),"new");
});
test("a review leaves the card out of the outbox; a suspension doesn't; the old card trigger is replaced",async()=>{
  const dir=temp();const file=join(dir,"a.db");let e=await Etude.open(file,{home:join(dir,"home")});
  try {
    syncFor(e).setup({folder:join(dir,"shared")});put(e,"one");drain(e.db);
    const card=e.db.get("SELECT id FROM cards WHERE item_id='one'")!.id,queued=()=>e.db.get("SELECT count(*) n FROM sync_outbox WHERE tbl='cards'")!.n;
    e.rate(card,3);assert.equal(queued(),0);
    e.setSuspended([card],true);assert.equal(queued(),1);
    // A collection set up by an earlier version has a trigger that fires on any card update.
    e.db.sql.exec("DROP TRIGGER sync_cards_update;CREATE TRIGGER sync_cards_update AFTER UPDATE ON cards BEGIN SELECT 1; END;");
    e.close();e=await Etude.open(file,{home:join(dir,"home")});
    assert.match(e.db.get("SELECT sql FROM sqlite_master WHERE name='sync_cards_update'")!.sql,/AFTER UPDATE OF item_id/);
    drain(e.db);e.rate(card,3);assert.equal(queued(),0);
  }finally{e.close();rmSync(dir,{recursive:true,force:true});}
});
test("LWW fields, permanent entity tombstones, idempotence and no echo",async()=>{
  const dir=temp();const e=await Etude.open(join(dir,"a.db"),{home:join(dir,"home")});
  try {
    syncFor(e).setup({folder:join(dir,"shared")});
    const event:Change={v:1,table:"items",key:"missing",stamp:[100,0,"a"],fields:{"/fields/front":"first"}};
    assert.equal(receive(e.db,"remote-1",event),true);assert.equal(receive(e.db,"remote-1",event),false);
    receive(e.db,"remote-2",{...event,stamp:[99,0,"z"],fields:{"/fields/front":"old","/fields/back":"second"}});
    assert.deepEqual(rows(e.db,"items").get("missing"),{fields:{back:"second",front:"first"}});
    receive(e.db,"remote-3",{...event,deleted:true});receive(e.db,"remote-4",{...event,stamp:[1000,0,"b"]});
    assert.equal(rows(e.db,"items").has("missing"),false);drain(e.db);
    assert.equal(e.db.get("SELECT count(*) n FROM sync_events WHERE sent=0")!.n,0);
  }finally{e.close();rmSync(dir,{recursive:true,force:true});}
});
test("media names with spaces and accents sync; unsafe paths from another device are skipped",async()=>{
  const dir=temp();// Separate folders, so each device has its own media folder.
  for(const d of ["a","b"])mkdirSync(join(dir,d));
  const a=await Etude.open(join(dir,"a","a.db"),{home:join(dir,"ha")}),b=await Etude.open(join(dir,"b","b.db"),{home:join(dir,"hb")});
  try {
    const folder=join(dir,"shared");for(const e of [a,b]){syncFor(e).setup({folder});await syncFor(e).unlock({password});}
    mkdirSync(join(a.mediaDir,"anki"),{recursive:true});writeFileSync(join(a.mediaDir,"anki","Thüringen Wappen.png"),"flag");
    await syncFor(a).now({waitMedia:true});
    // A compromised device (it holds the vault key) names a file outside the media folder.
    receive(b.db,"evil-1",{v:1,table:"media",key:"../escaped.png",stamp:[Date.now(),0,"zz"],fields:{"/hash":"0".repeat(64)}});
    await syncFor(b).now({waitMedia:true});
    assert.equal(readFileSync(join(b.mediaDir,"anki","Thüringen Wappen.png"),"utf8"),"flag");
    assert.equal(existsSync(join(b.mediaDir,"..","escaped.png")),false);
    assert.equal(syncFor(b).status().error,null);
    // A file changed on this device is uploaded, not overwritten by the copy it had before.
    writeFileSync(join(b.mediaDir,"anki","Thüringen Wappen.png"),"new flag");
    await syncFor(b).now({waitMedia:true});await syncFor(a).now({waitMedia:true});
    assert.equal(readFileSync(join(b.mediaDir,"anki","Thüringen Wappen.png"),"utf8"),"new flag");
    assert.equal(readFileSync(join(a.mediaDir,"anki","Thüringen Wappen.png"),"utf8"),"new flag");
  }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});
test("a downloaded media file is whole or absent; a partial file left behind is never uploaded and goes once stale",async()=>{
  const dir=temp();for(const d of ["a","b","w"])mkdirSync(join(dir,d));
  const a=await Etude.open(join(dir,"a","a.db"),{home:join(dir,"ha")}),b=await Etude.open(join(dir,"b","b.db"),{home:join(dir,"hb")});
  try {
    // A write cut short (the app closed): the real name never holds half a file.
    const target=join(dir,"w","clip.mp3");
    assert.throws(()=>writeAtomic(target,new TextEncoder().encode("whole sound"),(p,bytes)=>{writeFileSync(p,bytes.subarray(0,5));throw new Error("closed");}),/closed/);
    assert.deepEqual(readdirSync(join(dir,"w")),[]);
    writeAtomic(target,new TextEncoder().encode("whole sound"));
    assert.equal(readFileSync(target,"utf8"),"whole sound");assert.deepEqual(readdirSync(join(dir,"w")),["clip.mp3"]);
    // One a closed app left in a media folder looks like nothing to sync, and goes once it's stale.
    const folder=join(dir,"shared");for(const e of [a,b]){syncFor(e).setup({folder});await syncFor(e).unlock({password});}
    mkdirSync(join(a.mediaDir,"anki"),{recursive:true});
    const fresh=join(a.mediaDir,"anki",".etude-partial-new"),stale=join(a.mediaDir,".etude-partial-old");
    writeFileSync(fresh,"half");writeFileSync(stale,"half");const old=new Date(Date.now()-3600_000);utimesSync(stale,old,old);
    writeFileSync(join(a.mediaDir,"anki","real.mp3"),"sound");
    await syncFor(a).now({waitMedia:true});await syncFor(b).now({waitMedia:true});
    assert.deepEqual([...rows(a.db,"media").keys()],["anki/real.mp3"]);
    assert.deepEqual(readdirSync(join(b.mediaDir,"anki")),["real.mp3"]);
    assert.ok(existsSync(fresh),"a partial file being written isn't touched");assert.ok(!existsSync(stale));
  }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});
test("sync reports its steps, and the upload total matches the bytes sent",async()=>{
  const dir=temp();// Separate folders, so each device has its own media folder.
  for(const d of ["a","b"])mkdirSync(join(dir,d));
  const a=await Etude.open(join(dir,"a","a.db"),{home:join(dir,"ha")}),b=await Etude.open(join(dir,"b","b.db"),{home:join(dir,"hb")});
  try {
    const folder=join(dir,"shared");for(const e of [a,b]){syncFor(e).setup({folder});await syncFor(e).unlock({password});}
    put(a,"one");mkdirSync(join(a.mediaDir,"anki"),{recursive:true});
    for(let i=0;i<3;i++)writeFileSync(join(a.mediaDir,"anki",`clip ${i}.mp3`),"sound ".repeat(1000+i));
    const record=(e:Etude)=>{const s=syncFor(e) as any,seen:any[]=[],step=s.step.bind(s);s.step=(...args:any[])=>{const p=step(...args);if(!seen.includes(p))seen.push(p);return p;};return seen;};
    const sa=record(a);await syncFor(a).now({waitMedia:true});
    // The collection first (the first sync builds the relational view once), then the media.
    assert.deepEqual(sa.map(p=>p.step),["download","types","upload","apply","check","download","upload"]);
    const uploads=sa.filter(p=>p.step==="upload");for(const up of uploads)assert.equal(up.done,up.total);
    assert.ok(uploads[1].done>3000,"the media upload");
    assert.deepEqual(sa.find(p=>p.step==="check"),{step:"check",done:3,total:3,rate:0});
    assert.equal(syncFor(a).status().progress,null);
    const sb=record(b);await syncFor(b).now({waitMedia:true});
    const sum=(list:any[],step:string)=>list.filter(p=>p.step===step).reduce((n,p)=>n+p.done,0);
    assert.ok(sum(sb,"download")>sum(sa,"upload")*0.9,"b downloads what a sent");
    assert.equal(sum(sb,"upload"),0);
    // b received a's changes and rebuilt; a second sync with nothing new doesn't rebuild again.
    assert.ok(sb.some(p=>p.step==="apply"));
    const again=record(b);await syncFor(b).now({waitMedia:true});
    assert.ok(!again.some(p=>p.step==="apply"));
  }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});
test("media: a sync with nothing new skips the files; new files, remote changes and the periodic look don't",async()=>{
  const dir=temp();for(const d of ["a","b"])mkdirSync(join(dir,d));
  const a=await Etude.open(join(dir,"a","a.db"),{home:join(dir,"ha")}),b=await Etude.open(join(dir,"b","b.db"),{home:join(dir,"hb")});
  try {
    const folder=join(dir,"shared");for(const e of [a,b]){syncFor(e).setup({folder});await syncFor(e).unlock({password});}
    const checked=async(e:Etude)=>{const s=syncFor(e) as any,step=s.step.bind(s);let seen=false;s.step=(...args:any[])=>{if(args[0]==="check")seen=true;return step(...args);};try{await s.now({waitMedia:true});}finally{s.step=step;}return seen;};
    const stored=a.storeMedia("dot.png",Buffer.from("dot"));mkdirSync(join(a.mediaDir,"anki"),{recursive:true});writeFileSync(join(a.mediaDir,"anki","map.png"),"map");
    assert.equal(await checked(a),true,"the first sync of a process looks at every file");
    // A file Etude stored is named by its hash, so it isn't read to hash it.
    assert.equal(a.db.get("SELECT count(*) n FROM sync_media_hashes WHERE file LIKE 'files/%'")!.n,0);
    assert.equal(await checked(a),false,"nothing changed");
    assert.equal(await checked(b),true);assert.equal(readFileSync(join(b.mediaDir,stored.file),"utf8"),"dot");
    // b's own downloads changed its folders after it looked at them, so it looks once more and then rests.
    await checked(b);assert.equal(await checked(b),false);
    writeFileSync(join(a.mediaDir,"anki","new.png"),"new");
    assert.equal(await checked(a),true,"a file was added");
    assert.equal(await checked(b),true,"another device's media arrived");assert.equal(readFileSync(join(b.mediaDir,"anki","new.png"),"utf8"),"new");
    await checked(b);
    // Rewritten in place, a file doesn't change its folder: it's found at the next full look.
    writeFileSync(join(b.mediaDir,"anki","map.png"),"map, edited");
    assert.equal(await checked(b),false);
    (syncFor(b) as any).scanned-=11*60_000;
    assert.equal(await checked(b),true);await syncFor(a).now({waitMedia:true});
    assert.equal(readFileSync(join(a.mediaDir,"anki","map.png"),"utf8"),"map, edited");
    // A file whose name claims another hash is sent with the hash of its bytes.
    const fake="0".repeat(64);writeFileSync(join(a.mediaDir,"files",fake+".png"),"not what the name says");
    await syncFor(a).now({waitMedia:true});await syncFor(b).now({waitMedia:true});
    const r=rows(a.db,"media").get(`files/${fake}.png`)!;
    assert.notEqual(r.hash,fake);assert.equal(readFileSync(join(b.mediaDir,"files",fake+".png"),"utf8"),"not what the name says");
    // Neither device takes the name's word for it on the next full look, so neither sends it again.
    const events=(e:Etude)=>e.db.get("SELECT count(*) n FROM sync_events")!.n,before=[events(a),events(b)];
    for(const e of [a,b])(syncFor(e) as any).scanned=0;
    await syncFor(b).now({waitMedia:true});await syncFor(a).now({waitMedia:true});
    assert.deepEqual([events(a),events(b)],before);
    assert.equal(syncFor(b).status().error,null);
  }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});
test("media bytes kept by an earlier version are dropped; type asset bytes stay",async()=>{
  const dir=temp();const file=join(dir,"a.db");let e=await Etude.open(file,{home:join(dir,"home")});
  try {
    syncFor(e).setup({folder:join(dir,"shared")});
    const def=e.type("basic");e.saveType({...def,id:"with-asset",name:"With asset",assets:{"a.json":Buffer.from("{}").toString("base64")}});drain(e.db);
    const asset=e.db.get("SELECT hash FROM type_assets WHERE type_id='with-asset'")!.hash;
    e.db.run("INSERT INTO sync_blobs VALUES(?,?,?)",asset,"a".repeat(64),Buffer.from("{}"));
    e.db.run("INSERT INTO sync_blobs VALUES(?,?,?)","b".repeat(64),"c".repeat(64),Buffer.from("media"));
    e.db.run("DELETE FROM sync_meta WHERE key='media_bytes'");
    e.close();e=await Etude.open(file,{home:join(dir,"home")});
    assert.deepEqual(e.db.all("SELECT hash FROM sync_blobs").map(r=>r.hash),[asset]);
  }finally{e.close();rmSync(dir,{recursive:true,force:true});}
});
test("a type asset whose blob event hasn't arrived: the projection goes on without it, keeps its key and takes it on a later sync",async()=>{
  const dir=temp();for(const d of ["a","b"])mkdirSync(join(dir,d));
  const a=await Etude.open(join(dir,"a","a.db"),{home:join(dir,"ha")}),b=await Etude.open(join(dir,"b","b.db"),{home:join(dir,"hb")});
  try {
    const folder=join(dir,"shared");for(const e of [a,b]){syncFor(e).setup({folder});await syncFor(e).unlock({password});}
    put(a,"one");
    a.saveType({...a.type("basic"),id:"with-asset",name:"With asset",assets:{"a.json":Buffer.from('{"x":1}').toString("base64")}});
    await syncFor(a).now({waitMedia:true});
    const hash=a.db.get("SELECT hash FROM type_assets WHERE type_id='with-asset'")!.hash;
    // The asset's blob event is still on its way: take it out of the folder for now.
    const key=await syncKeys(fromB64((syncFor(a) as any).secrets().vk)),events=join(folder,"events",readdirSync(join(folder,"events"))[0]);
    let held="";
    for(const f of readdirSync(events)){const ev=JSON.parse(readFileSync(join(events,f),"utf8"));const c=await decryptEvent<Change>(key,ev.id,ev.ciphertext);if(c.table==="blob"&&c.key===hash)held=f;}
    assert.ok(held);renameSync(join(events,held),join(dir,held));
    await syncFor(b).now({waitMedia:true});
    assert.equal(syncFor(b).status().error,null);
    assert.ok(b.db.get("SELECT 1 FROM items WHERE id='one'"),"the rest of the collection is there");
    assert.ok(b.db.get("SELECT 1 FROM types WHERE id='with-asset'"));
    assert.equal(b.db.get("SELECT count(*) n FROM type_assets")!.n,0);
    assert.ok(b.db.get("SELECT 1 FROM sync_dirty WHERE tbl='type_assets'"),"the asset's key waits");
    renameSync(join(dir,held),join(events,held));
    await syncFor(b).now({waitMedia:true});
    assert.equal(Buffer.from(b.db.get("SELECT bytes FROM type_assets WHERE type_id='with-asset' AND name='a.json'")!.bytes).toString(),'{"x":1}');
    assert.equal(b.db.get("SELECT 1 FROM sync_dirty WHERE tbl='type_assets'"),undefined);
    assert.deepEqual(relational(b),await rebuilt(b,dir));
  }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});
async function login(s:ReturnType<typeof syncFor>,server:string,outbox:string,email:string){
  s.setup({server});await s.signin(email);
  const files=readdirSync(outbox).map(f=>({f,text:readFileSync(join(outbox,f),"utf8")}));
  const mail=files.map(x=>JSON.parse(x.text)).filter(x=>x.to.toLowerCase()===email.toLowerCase()).at(-1)!;
  await s.verify(mail.meta.token);
}
/** The property test's random stream. ETUDE_SYNC_SEED (decimal or 0x hex) runs another one; xorshift needs a non-zero seed. */
const SEED=(Number(process.env.ETUDE_SYNC_SEED ?? 0x5eed1234)>>>0)||1;
async function property(kind:"folder"|"cloud") {
  const dir=temp();const es:Etude[]=[];
  try {
    for(let i=0;i<3;i++)es.push(await Etude.open(join(dir,`d${i}.db`),{home:join(dir,`h${i}`)}));
    const ss=es.map(syncFor);const folder=join(dir,"shared");
    // After every sync, the incremental projection must equal a full rebuild of the same registers.
    const sync=async(i:number)=>{
      await ss[i].now({waitMedia:true});
      assert.equal(es[i].db.get("SELECT value FROM sync_meta WHERE key='fallback'")?.value,undefined);
      assert.deepEqual(relational(es[i]),await rebuilt(es[i],dir),`device ${i} after an incremental projection`);
    };
    for(let i=0;i<3;i++) {
      if(kind==="folder")ss[i].setup({folder});else await login(ss[i],process.env.ETUDE_SYNC_TEST_SERVER!,process.env.ETUDE_SYNC_TEST_OUTBOX!,`property-${dir.split("/").at(-1)}@example.test`);
      await ss[i].unlock({password});
      await sync(i);
    }
    for(let i=0;i<18;i++)put(es[0],"item-"+i);
    // Fuzz stays on: a review made here is fuzzed, and the next sync must replace it with the canonical replay.
    es[0].updateDeck("Test",{config:{}});
    es[0].ensureDeck("Drill");es[0].updateDeck("Drill",{config:{scheduler:"drill"}});put(es[0],"drill");es[0].moveItems(["drill"],"Drill");
    es[0].ensureDeck("Leitner");es[0].updateDeck("Leitner",{config:{scheduler:"leitner"}});put(es[0],"leitner");es[0].moveItems(["leitner"],"Leitner");
    es[0].saveScheduler({id:"seeded-script",name:"Seeded script",schedule:"return {due: Date.now()+1000+Math.floor(Math.random()*1000)+ctx.history.length*60000,state:{n:card.reps+1,today:ctx.doneToday,last:ctx.history.at(-1)?.at??null}};"});
    es[0].ensureDeck("Script");es[0].updateDeck("Script",{config:{scheduler:"seeded-script"}});put(es[0],"script");es[0].moveItems(["script"],"Script");
    // Asset and media bytes take the encrypted blob path.
    const def=es[0].type("basic");es[0].saveType({...def,id:"sync-basic",name:"Sync basic",assets:{"sample.json":Buffer.from('{"mesh":"private"}').toString("base64")}});
    es[0].storeMedia("pixel.png",Buffer.from("test bytes"));
    es[0].upsertItem({id:"custom",deck:"Test",type:"sync-basic",fields:{front:"custom front",back:"custom back"}});
    es[0].upsertItem({id:"typed",deck:"Test",type:"typed",fields:{prompt:"question",answers:["answer"]}});
    es[0].savePreset({id:"shared-preset",name:"Shared preset",config:{desiredRetention:0.9}});es[0].updateDeck("Test",{presetId:"shared-preset"});
    for(let n=0;n<2;n++)for(let i=0;i<3;i++)await sync(i);
    let state=SEED;const rand=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)/4294967296;};
    // The reviews that should survive, by sync id, with their card's.
    const deleted=new Set<string>();const made=new Map<string,string>();
    const rated=(e:Etude,card:string,reviewId:number)=>made.set(e.db.get("SELECT sync_id FROM reviews WHERE id=?",reviewId)!.sync_id,card);
    for(let round=0;round<240;round++) {
      const device=Math.floor(rand()*3),e=es[device],index=Math.floor(rand()*18),key="item-"+index;
      if(round%5===0){const c=e.db.get("SELECT id,sync_id FROM cards WHERE item_id=?",round%20===0?"drill":round%20===5?"leitner":round%20===10?"script":round%40===15?"custom":"item-"+index%6) ?? e.db.get("SELECT id,sync_id FROM cards WHERE item_id='drill'")!;rated(e,c.sync_id,e.rate(c.id,3,{at:new Date(1800000000000+round*1000)}).reviewId);}
      else if(round%13===0 && index>=12){if(e.db.get("SELECT 1 FROM items WHERE id=?",key)){e.deleteItems([key]);deleted.add(key);}}
      // Paths an incremental projection has to follow: decks created twice offline (a suffixed name), renamed or merged.
      else if(round%7===1){if(e.db.get("SELECT 1 FROM items WHERE id=?",key))e.moveItems([key],round%3?"Shared":"Shared::Inner");}
      else if(round%11===2){const d=e.db.get("SELECT name FROM decks WHERE name LIKE 'Shared%' ORDER BY name LIMIT 1");if(d)e.renameDeck(d.name,`Shared ${round%4}`);}
      // Configuration a card's schedule depends on: deck config, presets, a type's own scheduler, the day start.
      else if(round%17===3)e.updateDeck("Test",{config:{learningSteps:round%2?["1m","10m"]:["2m"]}});
      else if(round%43===10)e.reschedule();
      else if(round%17===8)e.savePreset({id:"shared-preset",name:"Shared preset",config:{desiredRetention:0.8+(round%3)*0.07}});
      else if(round%41===16)e.updateDeck("Test",{presetId:round%3?"shared-preset":null});
      else if(round%19===4){const def=e.type("sync-basic");e.saveType({...def,scheduler:round%2?"leitner":undefined});}
      else if(round%29===6)e.updateSettings({dayStartHour:round%24});
      // Card controls and history: suspension, reset, a due date, undo, graded attempts, tag notes.
      else if(round%23===5){const c=e.db.get("SELECT id FROM cards WHERE item_id=?",round%2?key:"custom");if(c)e.setSuspended([c.id],!!(round%3));}
      else if(round%23===12){const c=e.db.get("SELECT id FROM cards WHERE item_id=?",key);if(c)round%2?e.resetCards([c.id]):e.setDue([c.id],new Date(1900000000000+round*1000));}
      // Undo after a sync, so the undone review was already part of the canonical history. Undo takes this device's own newest
      // review, never one that came from another device.
      else if(round%31===7){await sync(device);const ids=()=>e.db.all("SELECT sync_id FROM reviews").map(r=>r.sync_id as string);const before=ids();e.undo();const after=new Set(ids());for(const k of before)if(!after.has(k))made.delete(k);}
      else if(round%31===20){const c=e.db.get("SELECT id,sync_id FROM cards WHERE item_id='typed'")!;const a=await e.submit(c.id,1,round%2?"answer":"wrong");rated(e,c.sync_id,e.rate(c.id,round%2?3:1,{attemptId:a.attemptId,at:new Date(1800000000000+round*1000)}).reviewId);}
      else if(round%37===9)e.setTagMeta(`tag-${device}`,{description:`round ${round}`});
      else if(e.db.get("SELECT 1 FROM items WHERE id=?",key)){
        const item=e.item(key);const f={...item.fields};f[round%2?"front":"back"]=`round ${round} device ${device}`;
        e.upsertItem({id:key,type:"basic",deck:"Test",fields:f,tags:["test",`tag-${device}`]});
      }
      if(rand()<0.23)await sync(Math.floor(rand()*3));
    }
    for(let n=0;n<3;n++)for(let i=0;i<3;i++)await sync(i);
    const expected=canonical(es[0]);for(const e of es.slice(1))assert.deepEqual(canonical(e),expected);
    for(const e of es){assert.deepEqual([...rows(e.db,"reviews").keys()].sort(),[...made.keys()].sort());assert.equal(e.db.get("SELECT count(*) n FROM reviews")!.n,[...made.values()].filter(k=>e.db.get("SELECT 1 FROM cards WHERE sync_id=?",k)).length);for(const k of deleted)assert.equal(e.db.get("SELECT 1 FROM items WHERE id=?",k),undefined);assert.equal(e.db.get("SELECT count(*) n FROM sync_outbox")!.n,0);}
    if(kind==="cloud") {
      // A device that joins now starts from the latest snapshot (the devices made them along the way, with
      // ETUDE_SYNC_SNAPSHOT_EVERY low) and pulls only the events after it.
      const late=await Etude.open(join(dir,"late.db"),{home:join(dir,"late")});es.push(late);
      const s=syncFor(late);
      await login(s,process.env.ETUDE_SYNC_TEST_SERVER!,process.env.ETUDE_SYNC_TEST_OUTBOX!,`property-${dir.split("/").at(-1)}@example.test`);
      await s.unlock({password});await s.now({waitMedia:true});
      assert.equal(late.db.get("SELECT value FROM sync_meta WHERE key='snapshot_error'")?.value,undefined);
      assert.ok(late.db.get("SELECT count(*) n FROM sync_events")!.n<es[0].db.get("SELECT count(*) n FROM sync_events")!.n,"only the events after the snapshot");
      assert.deepEqual(canonical(late),expected);
      assert.deepEqual(relational(late),await rebuilt(late,dir));
      es.pop();late.close();
    }
    assert.equal(es[1].typeAsset("sync-basic","sample.json")!.size,18);
    // Only the type asset keeps its bytes in the database; the media file is on disk.
    assert.equal(es[0].db.get("SELECT count(*) n FROM sync_blobs")!.n,1);
    for(const e of es)assert.equal(readFileSync(join(e.mediaDir,es[0].storeMedia("pixel.png",Buffer.from("test bytes"),{dryRun:true}).file),"utf8"),"test bytes");
  } finally {for(const e of es)e.close();rmSync(dir,{recursive:true,force:true});}
}
test(`seed 0x${SEED.toString(16)}: 3 offline devices converge through encrypted folder (240 rounds)`,()=>property("folder"));
test(`seed 0x${SEED.toString(16)}: 3 offline devices converge through real etude-cloud HTTP (240 rounds)`,{skip:!process.env.ETUDE_SYNC_TEST_SERVER},()=>property("cloud"));
test("undo takes this device's last review, not one that arrived from another device after it",async()=>{
  const dir=temp();const [a,b]=await Promise.all(["a","b"].map(n=>Etude.open(join(dir,`${n}.db`),{home:join(dir,"h"+n)})));
  try {
    const [sa,sb]=[a,b].map(syncFor);
    for(const s of [sa,sb]){s.setup({folder:join(dir,"shared")});await s.unlock({password});}
    put(a,"x");put(a,"y");await sa.now({waitMedia:true});await sb.now({waitMedia:true});
    const card=(e:Etude,item:string)=>e.db.get("SELECT id FROM cards WHERE item_id=?",item)!.id;
    // A review not synced yet is this device's own.
    a.rate(card(a,"x"),3);assert.equal(a.undo()?.itemId,"x");
    a.rate(card(a,"x"),3);await sa.now({waitMedia:true});
    // b answers later, and a receives that review after its own.
    b.rate(card(b,"y"),3);await sb.now({waitMedia:true});await sa.now({waitMedia:true});
    assert.equal(a.db.get("SELECT count(*) n FROM reviews")!.n,2);
    assert.equal(a.undo()?.itemId,"x");
    assert.equal(a.undo(),null,"b's review isn't a's to undo");
    assert.equal(b.undo()?.itemId,"y");
    for(let n=0;n<2;n++){await sa.now({waitMedia:true});await sb.now({waitMedia:true});}
    for(const e of [a,b])assert.equal(e.db.get("SELECT count(*) n FROM reviews")!.n,0);
  }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});
test("history that arrives out of order: an attempt before its review, a review before an earlier one",async()=>{
  const dir=temp();const es=await Promise.all(["a","b","c"].map(n=>Etude.open(join(dir,`${n}.db`),{home:join(dir,"h"+n)})));const [a,b,c]=es;
  try {
    const { projectChanges } = await import("../src/core/sync/project.ts");
    for(const e of es)syncFor(e).setup({folder:join(dir,"shared")});
    const deliver=(from:Etude,to:Etude,filter:(e:Change)=>boolean=()=>true)=>{drain(from.db);for(const r of from.db.all("SELECT id,body FROM sync_events ORDER BY id")){const e=JSON.parse(r.body);if(filter(e))receive(to.db,r.id,e);}projectChanges(to);};
    a.upsertItem({id:"typed",deck:"Test",type:"typed",fields:{prompt:"question",answers:["answer"]}});
    deliver(a,b);deliver(a,c);
    const answer=async(e:Etude,at:string)=>{const card=e.db.get("SELECT id FROM cards WHERE item_id='typed'")!.id;const x=await e.submit(card,1,"answer");e.rate(card,3,{attemptId:x.attemptId,at:new Date(at)});};
    // Offline, a answers later than c does.
    await answer(a,"2027-01-05T10:00:00.000Z");await answer(c,"2027-01-01T10:00:00.000Z");
    // b gets a's attempt alone, then a's review, then c's earlier answer.
    for(const step of [()=>deliver(a,b,e=>e.table==="attempts"),()=>deliver(a,b),()=>deliver(c,b)]) {
      step();
      assert.deepEqual(relational(b),await rebuilt(b,dir));
    }
    assert.equal(b.db.get("SELECT count(*) n FROM attempts WHERE review_id IS NOT NULL")!.n,2);
    assert.equal(b.db.get("SELECT value FROM sync_meta WHERE key='fallback'"),undefined);
  }finally{for(const e of es)e.close();rmSync(dir,{recursive:true,force:true});}
});
test("synced settings can't carry provider URLs or unsanitized theme CSS from another device",async()=>{
  const dir=temp();const e=await Etude.open(join(dir,"a.db"),{home:join(dir,"home")});
  try {
    syncFor(e).setup({folder:join(dir,"shared")});
    const before=e.settings().ai;
    // A compromised device (it holds the vault key) writes fields that a normal device never sends.
    receive(e.db,"evil-1",{v:1,table:"settings",key:"settings",stamp:[Date.now()+60000,0,"zz"],fields:{
      "/value/ai/feedback/url":"https://attacker.example/v1","/value/ai/feedback/keyEnv":"HOME","/value/market/url":"https://attacker.example/market",
      "/value/themes":[{id:"evil",name:"Evil",scheme:"dark",vars:{},css:"body{background:url(https://attacker.example/x)}"}],"/value/theme":"evil","/value/dayStartHour":7,
    }});
    const { project } = await import("../src/core/sync/project.ts");project(e);
    const s=e.settings();
    assert.deepEqual(s.ai,before,"provider settings stay local");
    assert.equal(s.market.url,"","the Market catalog stays local");
    assert.equal(s.dayStartHour,7,"synced keys still apply");
    assert.equal(s.theme,"evil");
    assert.ok(!(s.themes[0].css??"").includes("attacker.example"),"theme CSS went through the sanitizer");
  }finally{e.close();rmSync(dir,{recursive:true,force:true});}
});
