// Explicit live check; uses the selected account's model allowance.
const { ProviderClient, routeRequest, routeState } = require('../src/providers.cjs');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const provider = process.argv[2] || 'codex';
const cwd = path.resolve(__dirname, '../.build/provider-smoke'); fs.mkdirSync(cwd, { recursive: true });
const client = new ProviderClient(cwd);
const session = { messages: [{ role: 'user', text: 'Remember the codeword ORCHID.' }, { role: 'assistant', text: 'Remembered.', provider: provider === 'codex' ? 'claude' : 'codex' }] };
const results = []; let model;
async function send(prompt, images = []) {
  const routed = routeRequest(session, provider, { prompt, images: images.map(path => ({ path })), historyEnd: session.messages.length });
  let text = ''; const append = delta => { text += delta; }; client.on('delta', append);
  const done = once(client, 'completed');
  try {
    const accepted = await client.ask({ ...routed, model, effort: 'low', instructions: 'Answer briefly and follow the user request exactly.' });
    const [result] = await done; assert.equal(result.status, 'completed', result.error?.message);
    session.messages.push({ role: 'user', prompt, images: images.map(path => ({ path })) }, { role: 'assistant', text, provider });
    Object.assign(routeState(session, provider), { threadId: accepted.threadId, through: session.messages.length });
    results.push(text.trim()); return text.trim();
  } finally { client.off('delta', append); }
}
const timer = setTimeout(() => { client.disconnect(); console.error('Provider smoke timed out'); process.exit(1); }, 120000);
(async () => {
  const connection = await client.connect(provider); model = connection.models.find(m => m.isDefault)?.model || connection.models[0].model;
  assert.equal(await send('What codeword was mentioned earlier? Reply with the codeword only.'), 'ORCHID');
  assert.equal(await send('Read the two-digit number in this image. Reply only with that number.', [path.resolve(__dirname, '../.build/test-screen.png')]), '42');
  assert.equal(await send('Add eight to that number. Reply with the resulting number only.'), '50');
  const done = once(client, 'completed');
  await client.ask({ threadId: routeState(session, provider).threadId, model, text: 'Write a detailed 3000-word explanation of sorting algorithms.' }); await client.interrupt();
  assert.ok(['interrupted', 'completed'].includes((await done)[0].status));
  fs.writeFileSync(path.join(cwd, `${provider}.json`), JSON.stringify({ provider, model, status: 'passed', results }, null, 2));
  console.log(`PASS: ${provider} context handoff, image input, continuation and cancellation.`);
})().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => { clearTimeout(timer); client.disconnect(); });
