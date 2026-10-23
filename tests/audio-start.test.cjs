const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AudioPipeline } = require('../src/audio.cjs');

async function pipeline(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-audio-test-'));
  const p = new AudioPipeline({ helper: path.join(__dirname, 'capture-fixture.cjs'), directory, startupTimeout: 2000 });
  p.prepare = async () => {};
  p.on('problem', () => {});
  t.after(async () => { await p.stop(); await fs.rm(directory, { recursive: true, force: true }); });
  return p;
}
test('capture startup resolves only after the native stream is ready', async t => {
  const p = await pipeline(t);
  let ready = false;
  p.on('listening', value => { ready = value; });
  await p.start();
  assert.equal(ready, true, 'UI must not finish loading before native capture starts');
});
test('native startup failure rejects instead of reporting a successful start', async t => {
  const p = await pipeline(t);
  await assert.rejects(p.start({ microphone: 'fail' }), /permission denied/);
});
test('native startup has a bounded timeout', async t => {
  const p = await pipeline(t);
  p.startupTimeout = 200;
  await assert.rejects(p.start({ microphone: 'hang' }), /timed out/i);
});
test('an unexpected helper exit after readiness is reported and prevents stale submission',async t=>{
  const p=await pipeline(t);const problems=[];p.on('problem',message=>problems.push(message));
  await p.start({microphone:'crash'});
  await new Promise(resolve=>p.capture.once('close',resolve));
  assert.equal(p.listening,false);
  assert.match(problems.join(' '),/capture.*stopped.*SIGKILL/i);
  await assert.rejects(p.flush(),/capture.*stopped/i);
});
test('an intentional pause does not report a helper crash',async t=>{
  const p=await pipeline(t);const problems=[];p.on('problem',message=>problems.push(message));
  await p.start();await p.stop();assert.deepEqual(problems,[]);
});
test('flush waits for the emitted speech to finish transcribing without stopping capture',async t=>{
 const p=await pipeline(t);let received='';p.transcribe=async()=>{await new Promise(r=>setTimeout(r,40));return {text:'the last spoken question',source:'Computer'}};p.on('transcript',v=>received=v.text);
 await p.start();await p.flush();assert.equal(received,'the last spoken question');assert.equal(p.listening,true);
});
test('flush exposes transcription failure instead of sending stale context',async t=>{
 const p=await pipeline(t);p.transcribe=async()=>{throw Error('ASR fixture failed')};await p.start();await assert.rejects(p.flush(),/ASR fixture failed/);
});
