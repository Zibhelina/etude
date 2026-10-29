import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { syncFor } from "../src/core/sync/client.ts";
import { compare, tick, rows, drain, receive, type Change } from "../src/core/sync/log.ts";
import { generateVaultKey, encryptBlob, decryptBlob, encryptEvent, decryptEvent } from "../src/core/sync/crypto.ts";

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
    await syncFor(a).now();
    // A compromised device (it holds the vault key) names a file outside the media folder.
    receive(b.db,"evil-1",{v:1,table:"media",key:"../escaped.png",stamp:[Date.now(),0,"zz"],fields:{"/hash":"0".repeat(64)}});
    await syncFor(b).now();
    assert.equal(readFileSync(join(b.mediaDir,"anki","Thüringen Wappen.png"),"utf8"),"flag");
    assert.equal(existsSync(join(b.mediaDir,"..","escaped.png")),false);
    assert.equal(syncFor(b).status().error,null);
    // A file changed on this device is uploaded, not overwritten by the copy it had before.
    writeFileSync(join(b.mediaDir,"anki","Thüringen Wappen.png"),"new flag");
    await syncFor(b).now();await syncFor(a).now();
    assert.equal(readFileSync(join(b.mediaDir,"anki","Thüringen Wappen.png"),"utf8"),"new flag");
    assert.equal(readFileSync(join(a.mediaDir,"anki","Thüringen Wappen.png"),"utf8"),"new flag");
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
    const sa=record(a);await syncFor(a).now();
    assert.deepEqual(sa.map(p=>p.step),["download","check","upload","apply"]);
    const up=sa.find(p=>p.step==="upload");assert.ok(up.done>3000);assert.equal(up.done,up.total);
    assert.deepEqual(sa.find(p=>p.step==="check"),{step:"check",done:3,total:3,rate:0});
    assert.equal(syncFor(a).status().progress,null);
    const sb=record(b);await syncFor(b).now();
    assert.ok(sb.find(p=>p.step==="download").done>up.done*0.9,"b downloads what a sent");
    assert.equal(sb.find(p=>p.step==="upload").total,0);
  }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});
async function login(s:ReturnType<typeof syncFor>,server:string,outbox:string,email:string){
  s.setup({server});await s.signin(email);
  const files=readdirSync(outbox).map(f=>({f,text:readFileSync(join(outbox,f),"utf8")}));
  const mail=files.map(x=>JSON.parse(x.text)).filter(x=>x.to.toLowerCase()===email.toLowerCase()).at(-1)!;
  await s.verify(mail.meta.token);
}
async function property(kind:"folder"|"cloud") {
  const dir=temp();const es:Etude[]=[];
  try {
    for(let i=0;i<3;i++)es.push(await Etude.open(join(dir,`d${i}.db`),{home:join(dir,`h${i}`)}));
    const ss=es.map(syncFor);const folder=join(dir,"shared");
    for(let i=0;i<3;i++) {
      if(kind==="folder")ss[i].setup({folder});else await login(ss[i],process.env.ETUDE_SYNC_TEST_SERVER!,process.env.ETUDE_SYNC_TEST_OUTBOX!,`property-${dir.split("/").at(-1)}@example.test`);
      await ss[i].unlock({password});
      await ss[i].now();
    }
    for(let i=0;i<18;i++)put(es[0],"item-"+i);
    es[0].updateDeck("Test",{config:{enableFuzz:false}});
    es[0].ensureDeck("Drill");es[0].updateDeck("Drill",{config:{scheduler:"drill"}});put(es[0],"drill");es[0].moveItems(["drill"],"Drill");
    es[0].ensureDeck("Leitner");es[0].updateDeck("Leitner",{config:{scheduler:"leitner"}});put(es[0],"leitner");es[0].moveItems(["leitner"],"Leitner");
    es[0].saveScheduler({id:"seeded-script",name:"Seeded script",schedule:"return {due: Date.now()+1000+Math.floor(Math.random()*1000),state:{n:card.reps+1}};"});
    es[0].ensureDeck("Script");es[0].updateDeck("Script",{config:{scheduler:"seeded-script"}});put(es[0],"script");es[0].moveItems(["script"],"Script");
    // Asset and media bytes take the encrypted blob path.
    const def=es[0].type("basic");es[0].saveType({...def,id:"sync-basic",name:"Sync basic",assets:{"sample.json":Buffer.from('{"mesh":"private"}').toString("base64")}});
    es[0].storeMedia("pixel.png",Buffer.from("test bytes"));
    for(let n=0;n<2;n++)for(const s of ss)await s.now();
    let state=0x5eed1234;const rand=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)/4294967296;};
    const deleted=new Set<string>();let reviews=0;const reviewKeys:string[]=[];
    for(let round=0;round<240;round++) {
      const device=Math.floor(rand()*3),e=es[device],index=Math.floor(rand()*18),key="item-"+index;
      if(round%5===0){const c=e.db.get("SELECT id,sync_id FROM cards WHERE item_id=?",round%20===0?"drill":round%20===5?"leitner":round%20===10?"script":key) ?? e.db.get("SELECT id,sync_id FROM cards WHERE item_id='drill'")!;e.rate(c.id,3,{at:new Date(1800000000000+round*1000)});reviewKeys.push(c.sync_id);reviews++;}
      else if(round%13===0 && index>=12){if(e.db.get("SELECT 1 FROM items WHERE id=?",key)){e.deleteItems([key]);deleted.add(key);}}
      else if(e.db.get("SELECT 1 FROM items WHERE id=?",key)){
        const item=e.item(key);const f={...item.fields};f[round%2?"front":"back"]=`round ${round} device ${device}`;
        e.upsertItem({id:key,type:"basic",deck:"Test",fields:f,tags:["test",`tag-${device}`]});
      }
      if(rand()<0.23)await ss[Math.floor(rand()*3)].now();
    }
    for(let n=0;n<3;n++)for(const s of ss)await s.now();
    const expected=canonical(es[0]);for(const e of es.slice(1))assert.deepEqual(canonical(e),expected);
    for(const e of es){assert.equal(rows(e.db,"reviews").size,reviews);assert.equal(e.db.get("SELECT count(*) n FROM reviews")!.n,reviewKeys.filter(k=>e.db.get("SELECT 1 FROM cards WHERE sync_id=?",k)).length);for(const k of deleted)assert.equal(e.db.get("SELECT 1 FROM items WHERE id=?",k),undefined);assert.equal(e.db.get("SELECT count(*) n FROM sync_outbox")!.n,0);}
    assert.equal(es[1].typeAsset("sync-basic","sample.json")!.size,18);
    assert.equal(es[0].db.get("SELECT count(*) n FROM sync_blobs")!.n,2);
  } finally {for(const e of es)e.close();rmSync(dir,{recursive:true,force:true});}
}
test("seed 0x5eed1234: 3 offline devices converge through encrypted folder (240 rounds)",()=>property("folder"));
test("seed 0x5eed1234: 3 offline devices converge through real etude-cloud HTTP (240 rounds)",{skip:!process.env.ETUDE_SYNC_TEST_SERVER},()=>property("cloud"));
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
