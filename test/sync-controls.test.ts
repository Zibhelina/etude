import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { syncFor } from "../src/core/sync/client.ts";
import { rows } from "../src/core/sync/log.ts";

test("offline field edits, tied reviews, attempts, reset/due controls, password recovery and private settings",async()=>{
  const dir=mkdtempSync(join(process.env.TMPDIR!,"sync-controls-"));
  const a=await Etude.open(join(dir,"a.db"),{home:join(dir,"ha")});const b=await Etude.open(join(dir,"b.db"),{home:join(dir,"hb")});
  const sa=syncFor(a),sb=syncFor(b);const password="local-password-test";
  try {
    a.upsertItem({id:"test",deck:"Test",type:"typed",fields:{prompt:"question",answers:["answer"]}});
    a.updateSettings({theme:"midnight",ai:{...a.settings().ai,language:"private-local-ai"}});
    sa.setup({folder:join(dir,"shared")});const key=(await sa.unlock({password})).recoveryKey!;await sa.now();
    sb.setup({folder:join(dir,"shared")});await assert.rejects(sb.unlock({password:"wrong-password"}));await sb.unlock({recovery:key});await sb.now();
    assert.equal(b.settings().theme,"midnight");assert.notEqual(b.settings().ai.language,"private-local-ai");
    const c=a.item("test").cards[0].id,d=b.item("test").cards[0].id;
    a.upsertItem({id:"test",deck:"Test",type:"typed",fields:{prompt:"edited on A",answers:["answer"]}});
    await new Promise(r=>setTimeout(r,5));
    b.upsertItem({id:"test",deck:"Test",type:"typed",fields:{prompt:"question",answers:["B answer"]}});
    // A's later upload must preserve B's independently edited answer field.
    await sb.now();await sa.now();await sb.now();
    assert.deepEqual(a.item("test").fields,{prompt:"edited on A",answers:["B answer"],match:"loose"});assert.deepEqual(a.item("test").fields,b.item("test").fields);
    const aa=await a.submit(c,1,"B answer"),ab=await b.submit(d,1,"B answer");
    const at=new Date("2026-10-26T01:00:00Z");a.rate(c,3,{attemptId:aa.attemptId,at});b.rate(d,4,{attemptId:ab.attemptId,at});
    for(let n=0;n<2;n++){await sa.now();await sb.now();}
    assert.equal(a.db.get("SELECT count(*) n FROM reviews")!.n,2);assert.equal(b.db.get("SELECT count(*) n FROM attempts")!.n,2);
    assert.equal(a.item("test").cards[0].due,b.item("test").cards[0].due);
    a.resetCards([c]);await sa.now();await sb.now();assert.equal(b.item("test").cards[0].reps,0);assert.equal(b.db.get("SELECT count(*) n FROM reviews")!.n,2);
    const due=new Date("2030-01-01T00:00:00Z");b.setDue([d],due);await sb.now();await sa.now();assert.equal(a.item("test").cards[0].due,due.toISOString());
    const settings=[...rows(a.db,"settings")];assert.equal(JSON.stringify(settings).includes("private-local-ai"),false);
    const device=a.db.get("SELECT device FROM sync_control")!.device;const file=join(dir,"ha/sync",device+".json");assert.equal(statSync(file).mode&0o777,0o600);assert.equal(readFileSync(file,"utf8").includes(password),false);
    assert.equal((await sa.unlock({password})).recoveryKey,undefined);
  }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});
