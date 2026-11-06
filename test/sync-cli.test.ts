import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/cli/run.ts";
test("sync CLI setup, stdin unlock, explicit JSON, now and off",async()=>{
  const dir=mkdtempSync(join((process.env.TMPDIR ?? tmpdir()),"sync-cli-"));
  async function cli(args:string[],stdin="") {let out="",err="";const code=await run(args,{stdout:s=>{out+=s;},stderr:s=>{err+=s;},stdin:()=>stdin,isTTY:false,env:{ETUDE_HOME:join(dir,"home")}});assert.equal(code,0,err);return JSON.parse(out);}
  try {
    assert.equal((await cli(["sync","status","--json"])).configured,false);
    assert.equal((await cli(["sync","setup","--folder",join(dir,"shared"),"--json"])).kind,"folder");
    const created=await cli(["sync","unlock","--json"],"test-password-only\n");assert.ok(created.recoveryKey);assert.equal(created.status.unlocked,true);
    assert.equal((await cli(["sync","unlock","--json"],"test-password-only\n")).recoveryKey,undefined);
    // `sync now` exits once the media is done too: the file's events are sent.
    mkdirSync(join(dir,"home","media"),{recursive:true});writeFileSync(join(dir,"home","media","clip.mp3"),"sound");
    const now=await cli(["sync","now","--json"]);assert.equal(now.busy,false);assert.deepEqual(now.media,{active:false,progress:null,error:null,received:0});
    const status=await cli(["sync","status","--format","table","--json"]);assert.equal(status.pending,0);assert.equal(status.media.active,false);
    assert.equal((await cli(["sync","off","--json"])).configured,false);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
