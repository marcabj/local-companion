const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ClaudeClient } = require('../src/claude.cjs');
const { ProviderClient, routeRequest, routeState } = require('../src/providers.cjs');
const harness = require('./workflow-harness.cjs');

async function fixture(t, env = process.env) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-claude-'));
  const client = new ClaudeClient(cwd, { command: process.execPath, prefix: [path.join(__dirname, 'claude-fixture.cjs')], env });
  t.after(async () => { client.disconnect(); await fs.rm(cwd, { recursive: true, force: true }); });
  return { client, cwd };
}
async function turn(client, request) {
  let text = ''; const append = delta => { text += delta; };
  client.on('delta', append);
  const completion = once(client, 'completed');
  try { await client.ask(request); const [result] = await completion; return { result, text }; }
  finally { client.off('delta', append); }
}

test('Claude CLI streams images and resumes the same session with updated instructions', async t => {
  const { client, cwd } = await fixture(t);
  const connected = await client.connect();
  assert.equal(connected.auth, 'claude.ai'); assert.ok(connected.models.some(m => m.model === 'sonnet'));
  const image = path.join(cwd, 'image.png'); await fs.writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const first = await turn(client, { text: 'Wait for more', images: [image, image], instructions: 'Mode A', model: 'sonnet' });
  assert.equal(first.result.status, 'completed'); assert.equal(JSON.parse(first.text).imageCount, 2);
  const thread = client.thread; assert.ok(thread);
  const second = await turn(client, { threadId: thread, text: 'Continue', instructions: 'Mode B', model: 'opus', smart: true });
  assert.equal(client.thread, thread); const reply = JSON.parse(second.text);
  assert.equal(reply.resumed, true); assert.equal(reply.instructions, 'Mode B'); assert.equal(reply.model, 'opus');
  assert.equal(reply.snapshot, 'off'); assert.equal(reply.tools, 'WebSearch,WebFetch');
  const third = await turn(client, { images: [image], model: 'haiku' });
  assert.equal(third.result.status, 'completed'); assert.equal(JSON.parse(third.text).prompt, '');
});
test('Claude rejects unsigned-in accounts and reports model errors and premature exit', async t => {
  const loggedOut = (await fixture(t, { ...process.env, CLAUDE_FIXTURE_LOGGED_OUT: '1' })).client;
  await assert.rejects(loggedOut.connect(), /Sign in to Claude/); assert.equal(loggedOut.connected, false);
  const { client } = await fixture(t); await client.connect();
  const failed = await turn(client, { text: 'fail' });
  assert.equal(failed.result.status, 'failed'); assert.match(failed.result.error.message, /model unavailable/);
  const loggedOutTurn = await turn(client, { text: 'logged out' });
  assert.equal(loggedOutTurn.result.status, 'failed'); assert.equal(loggedOutTurn.text, '');
  assert.match(loggedOutTurn.result.error.message, /Sign in to Claude/);
  const exited = await turn(client, { text: 'exit' });
  assert.equal(exited.result.status, 'failed'); assert.match(exited.result.error.message, /transport failure/);
  assert.equal(client.busy, false);
});
test('Claude answers stream once across thinking, tool calls and unstreamed messages', async t => {
  const { client } = await fixture(t); await client.connect();
  const { result, text } = await turn(client, { text: 'search' });
  assert.equal(result.status, 'completed'); assert.equal(text, 'Searching.\n\nFound it.\n\nUnstreamed.');
});
test('Claude CLI does not inherit a host Claude Code session', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-claude-'));
  const saved = process.env.CLAUDECODE; process.env.CLAUDECODE = '1';
  const client = new ClaudeClient(cwd, { command: process.execPath, prefix: [path.join(__dirname, 'claude-fixture.cjs')] });
  if (saved === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = saved;
  t.after(async () => { client.disconnect(); await fs.rm(cwd, { recursive: true, force: true }); });
  await client.connect();
  assert.equal(JSON.parse((await turn(client, { text: 'Hello' })).text).nested, false);
});
test('Claude Stop terminates a running answer and permits the next request', async t => {
  const { client } = await fixture(t); await client.connect();
  const initialized = once(client, 'thread'); const completion = once(client, 'completed');
  await client.ask({ text: 'hang' }); await initialized; await client.interrupt();
  assert.equal((await completion)[0].status, 'interrupted'); assert.equal(client.busy, false);
  assert.equal((await turn(client, { text: 'Next question' })).result.status, 'completed');
});
test('Claude rejects missing attachments and oversized input before starting a turn', async t => {
  const { client, cwd } = await fixture(t); await client.connect();
  await assert.rejects(client.ask({ images: [path.join(cwd, 'missing.png')] }), /ENOENT/);
  assert.equal(client.busy, false); assert.equal(client.children.size, 0);
  await assert.rejects(client.ask({ text: 'a'.repeat(10 * 1024 * 1024) }), /10 MB/);
  assert.equal(client.busy, false); assert.equal(client.children.size, 0);
});
test('provider routing ignores inactive backend events and never silently falls back', async () => {
  const codex = new EventEmitter(), claude = new EventEmitter();
  codex.connect = async () => ({ models: ['codex'] }); claude.connect = async () => ({ models: ['claude'] });
  codex.ask = async () => { throw Error('wrong route'); }; claude.ask = async r => r;
  const client = new ProviderClient('/tmp', { codex, claude }); const deltas = [];
  client.on('delta', d => deltas.push(d)); await client.connect('claude');
  codex.emit('delta', 'stale'); claude.emit('delta', 'answer'); assert.deepEqual(deltas, ['answer']);
  assert.equal((await client.ask({ text: 'question' })).text, 'question');
  await assert.rejects(client.connect('unknown'), /Unknown/); assert.equal(client.provider, 'claude');
  claude.connect = async () => { throw Error('Claude offline'); }; await assert.rejects(client.connect('claude'), /offline/);
  assert.equal(client.provider, 'claude');
});
test('switching providers transfers missed context and images without mixing session IDs', () => {
  const session = { threadId: 'codex-thread', messages: [{ role: 'user', prompt: 'Wait for the second image', images: [{ path: '/first.png' }] }, { role: 'assistant', text: 'Waiting' }] };
  const prepared = { prompt: 'Now solve it', images: [{ path: '/second.png' }], historyEnd: 2 };
  const claude = routeRequest(session, 'claude', prepared);
  assert.equal(claude.threadId, null); assert.match(claude.text, /Wait for the second image/); assert.match(claude.text, /Now solve it/);
  assert.deepEqual(claude.images, ['/first.png', '/second.png']);
  const codex = routeRequest(session, 'codex', prepared);
  assert.equal(codex.threadId, 'codex-thread'); assert.equal(codex.text, 'Now solve it'); assert.deepEqual(codex.images, ['/second.png']);
  Object.assign(routeState(session, 'claude'), { threadId: 'claude-session', through: 4 });
  session.messages.push({ role: 'user', text: 'A Claude followup' }, { role: 'assistant', text: 'Claude reply' });
  const back = routeRequest(session, 'codex', { ...prepared, historyEnd: 4 });
  assert.equal(back.threadId, 'codex-thread'); assert.match(back.text, /Claude reply/); assert.doesNotMatch(back.text, /Wait for the second image/);
  assert.equal(routeState(session, 'claude').threadId, 'claude-session');
});
test('app provider selection preserves draft, queued images and listening; restores model preferences', async () => {
  const h = harness(); h.codex.connect = async provider => ({ auth: 'claude.ai', models: provider === 'claude' ? [{ model: 'sonnet', isDefault: true }] : [{ model: 'fixture', isDefault: true }] });
  h.run("active().draft='unfinished';active().attachments=[{id:'queued'}];listening=true;selectedEffort='high'");
  await h.run("action('provider','claude')");
  assert.equal(h.run('selectedProvider'), 'claude'); assert.equal(h.run('selectedModel'), 'sonnet');
  assert.equal(h.run('active().draft'), 'unfinished'); assert.equal(h.run('active().attachments[0].id'), 'queued'); assert.equal(h.run('listening'), true);
  h.run('busy=true'); await assert.rejects(h.run("action('provider','codex')"), /Wait/);
  h.run('busy=false'); await h.run("action('provider','codex')"); assert.equal(h.run('selectedModel'), 'fixture');
  assert.equal(h.run('providerSelections.codex.selectedModel'), 'fixture');
});
test('app sends to the chosen backend session and retains Codex history when returning', async () => {
  const h = harness(); h.run("active().threadId='codex-thread';active().messages=[{role:'user',text:'Remember 42'},{role:'assistant',text:'OK'}];selectedProvider='claude'");
  await h.run("ask({text:'Add eight'})");
  assert.equal(h.calls[0].threadId, null); assert.match(h.calls[0].text, /Remember 42/);
  h.codex.emit('thread', 'claude-session'); h.codex.emit('delta', '50'); h.codex.emit('completed', { status: 'completed' });
  assert.equal(h.run('active().threadId'), 'codex-thread'); assert.equal(h.run('active().providerState.claude.threadId'), 'claude-session');
  h.run("selectedProvider='codex'"); await h.run("ask({text:'Double that'})");
  assert.equal(h.calls[1].threadId, 'codex-thread'); assert.match(h.calls[1].text, /50/);
  assert.equal(h.run('active().messages.at(-1).provider'), 'codex');
});
