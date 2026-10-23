// Local Parakeet lifecycle check with a known mono 16 kHz WAV; no model API calls.
const {AudioPipeline}=require('../src/audio.cjs');
const path=require('node:path');const fs=require('node:fs');const assert=require('node:assert/strict');
const file=process.argv[2];if(!file)throw Error('Pass a known mono 16 kHz PCM WAV.');
const directory=path.resolve(__dirname,'../.build/audio-idle-smoke');fs.mkdirSync(directory,{recursive:true});
const p=new AudioPipeline({helper:path.join(__dirname,'capture-fixture.cjs'),python:path.resolve(__dirname,'../.venv/bin/python'),worker:path.resolve(__dirname,'../scripts/transcribe.py'),directory,idleTimeoutMs:300});
const timeout=setTimeout(()=>{p.close();process.exitCode=1;console.error('Lifecycle check timed out');},90000);
(async()=>{
 const start=Date.now();await p.start();const firstPid=p.asr.pid;const first=await p.transcribe(file,'Computer');assert.ok(first.text);
 await p.stop();await new Promise(resolve=>p.asr.once('close',resolve));
 assert.throws(()=>process.kill(firstPid,0));
 await p.start();const nextPid=p.asr.pid;assert.notEqual(firstPid,nextPid);const second=await p.transcribe(file,'Computer');assert.equal(second.text,first.text);
 await p.stop();const result={status:'passed',idleTimeoutMs:300,firstPid,nextPid,transcriptPreserved:true,elapsedMs:Date.now()-start};
 fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(result);
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{clearTimeout(timeout);p.close();});
