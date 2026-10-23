const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {AudioPipeline}=require('../src/audio.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){const end=Date.now()+3000;while(!check()){assert.ok(Date.now()<end,'lifecycle did not settle');await sleep(10);}}
async function pipeline(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'companion-idle-'));
 const p=new AudioPipeline({helper:path.join(__dirname,'capture-fixture.cjs'),python:path.join(__dirname,'asr-fixture.cjs'),worker:'fixture',directory,idleTimeoutMs:80});
 p.on('problem',()=>{});
 t.after(async()=>{p.close();await until(()=>!p.asr&&!p.capture);await fs.rm(directory,{recursive:true,force:true});});return p;
}
test('short pause stays warm; resume cancels unloading while listening',async t=>{
 assert.equal(new AudioPipeline({}).idleTimeoutMs,45*60*1000);
 const p=await pipeline(t);await p.start();const pid=p.asr.pid;
 await p.stop();await sleep(20);await p.start();await sleep(150);
 assert.equal(p.asr.pid,pid);assert.equal(p.listening,true);assert.equal(p.unloading,undefined);
});
test('prolonged pause exits the worker; Listen reloads and preserves transcript events',async t=>{
 const p=await pipeline(t),transcripts=[];p.on('transcript',v=>transcripts.push(v));
 await p.start({sessionId:'same-chat'});await p.flush();const pid=p.asr.pid;
 await p.stop();await until(()=>!p.asr&&!p.unloading);
 assert.throws(()=>process.kill(pid,0));
 await p.start({sessionId:'same-chat'});assert.notEqual(p.asr.pid,pid);await p.flush();
 assert.deepEqual(transcripts.map(t=>[t.text,t.sessionId]),[['preserved speech','same-chat'],['preserved speech','same-chat']]);
});
test('pause drains pending speech before starting the idle timeout',async t=>{
 const p=await pipeline(t);let text='';p.on('transcript',v=>text=v.text);
 await p.start();const pid=p.asr.pid;const flush=p.flush();await until(()=>p.pending.size===1);
 const pause=p.stop();await sleep(120);assert.equal(p.asr.pid,pid);assert.equal(p.pending.size,1);
 await Promise.all([flush,pause]);assert.equal(text,'preserved speech');assert.equal(p.asr.pid,pid);
 await until(()=>!p.asr&&!p.unloading);
});
test('resume during worker shutdown waits for exit before starting a fresh worker',async t=>{
 const p=await pipeline(t);await p.start();const pid=p.asr.pid;await p.stop();await until(()=>p.unloading);
 await p.start();assert.notEqual(p.asr.pid,pid);assert.equal(p.listening,true);await p.flush();
});
