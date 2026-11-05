const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CodexDictation, ENDPOINT } = require('../src/dictation.cjs');
const { AudioPipeline } = require('../src/audio.cjs');

async function wav(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-dictation-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'segment.wav'); await fs.writeFile(file, Buffer.from('RIFF fixture'));
  return { directory, file };
}
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('Codex dictation uploads the segment with the signed-in account and returns its text', async t => {
  const { file } = await wav(t);
  const requests = [];
  const d = new CodexDictation({ fetch: async request => { requests.push(request); return reply(200, { text: ' The meeting is on Friday. ' }); } });
  d.credentials = async () => ({ token: 'token-1', account: 'account-1' });
  const result = await d.transcribe(file, 'Me');
  assert.equal(requests[0].url, ENDPOINT); assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].headers.get('authorization'), 'Bearer token-1');
  assert.equal(requests[0].headers.get('chatgpt-account-id'), 'account-1');
  const upload = (await requests[0].formData()).get('file');
  assert.equal(upload.type, 'audio/wav'); assert.equal(await upload.text(), 'RIFF fixture');
  assert.deepEqual({ ...result, seconds: 0 }, { type: 'transcript', source: 'Me', text: 'The meeting is on Friday.', seconds: 0, engine: 'codex' });
});

test('an expired Codex token is refreshed once before giving up', async t => {
  const { file } = await wav(t);
  const tokens = [], refreshes = [];
  const d = new CodexDictation({ fetch: async request => { tokens.push(request.headers.get('authorization')); return tokens.length === 1 ? reply(401, {}) : reply(200, { text: 'hello' }); } });
  d.credentials = async (refresh = false) => { refreshes.push(refresh); return { token: refresh ? 'fresh' : 'stale', account: 'a' }; };
  assert.equal((await d.transcribe(file, 'Me')).text, 'hello');
  assert.deepEqual(refreshes, [false, true]); assert.deepEqual(tokens, ['Bearer stale', 'Bearer fresh']);
  d.fetch = async () => reply(503, {});
  await assert.rejects(d.transcribe(file, 'Me'), /HTTP 503/);
});

function pipeline(t, directory, dictation) {
  const p = new AudioPipeline({ helper: path.join(__dirname, 'capture-fixture.cjs'), directory, startupTimeout: 2000, dictation, engine: 'codex' });
  p.loads = 0; p.prepare = async () => { p.loads++; };
  p.on('problem', () => {});
  t.after(() => p.stop());
  return p;
}

test('Codex engine transcribes without loading Parakeet', async t => {
  const { directory, file } = await wav(t);
  const p = pipeline(t, directory, { credentials: async () => ({}), transcribe: async (f, source) => ({ text: 'from codex', source, engine: 'codex' }) });
  await p.start();
  assert.equal((await p.transcribe(file, 'Computer')).text, 'from codex');
  assert.equal(p.loads, 0); assert.equal(p.pending.size, 0); assert.equal(p.engineLabel(), 'Codex dictation');
});

test('a failed Codex request falls back to Parakeet for that segment and the rest of the session', async t => {
  const { directory, file } = await wav(t);
  let calls = 0; const statuses = [];
  const p = pipeline(t, directory, { credentials: async () => ({}), transcribe: async () => { calls++; throw new Error('HTTP 503'); } });
  p.on('status', s => statuses.push(s));
  p.workerReady = true; p.asr = { stdin: { write: line => { const { id, source } = JSON.parse(line); setImmediate(() => { const q = p.pending.get(id); p.pending.delete(id); q.resolve({ text: 'from parakeet', source }); }); } } };
  await p.start();
  assert.equal((await p.transcribe(file, 'Me')).text, 'from parakeet');
  assert.equal((await p.transcribe(file, 'Me')).text, 'from parakeet');
  assert.equal(calls, 1, 'later segments go straight to Parakeet');
  assert.match(statuses.join('\n'), /Codex dictation failed \(HTTP 503\) · using local Parakeet/);
  assert.equal(p.engineLabel(), 'local Parakeet');
  await p.stop(); await p.start();
  assert.equal(p.engineLabel(), 'Codex dictation', 'a new Listen session tries Codex again');
});

test('a missing Codex sign-in falls back to Parakeet before capture starts', async t => {
  const { directory } = await wav(t);
  const p = pipeline(t, directory, { credentials: async () => { throw new Error('Codex dictation needs a ChatGPT sign-in.'); } });
  const statuses = []; p.on('status', s => statuses.push(s));
  await p.start();
  assert.equal(p.loads, 1); assert.equal(p.listening, true);
  assert.match(statuses[0], /needs a ChatGPT sign-in.*using local Parakeet/);
});
