const { createInterface } = require('node:readline');
const { randomUUID } = require('node:crypto');
const args = process.argv.slice(2);
const option = flag => args[args.indexOf(flag) + 1];
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
if (args[0] === 'auth') {
  const loggedIn = !process.env.CLAUDE_FIXTURE_LOGGED_OUT;
  send({ loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none' });
  process.exitCode = loggedIn ? 0 : 1;
} else {
  const id = args.includes('--resume') ? option('--resume') : option('--session-id') || randomUUID();
  createInterface({ input: process.stdin }).on('line', line => {
    const input = JSON.parse(line);
    const prompt = input.message.content.find(c => c.type === 'text')?.text || '';
    send({ type: 'system', subtype: 'init', session_id: id });
    if (prompt === 'hang') { setTimeout(() => {}, 10000); process.on('SIGINT', () => process.exit(0)); return; }
    if (prompt === 'exit') { process.stderr.write('fixture transport failure'); process.exit(2); }
    if (prompt === 'fail') { send({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['fixture model unavailable'], session_id: id }); return; }
    if (prompt === 'logged out') {
      // The CLI reports a missing login as a synthetic assistant message plus an error result.
      send({ type: 'assistant', message: { id: randomUUID(), model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] }, session_id: id });
      send({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', session_id: id }); return;
    }
    const event = event => send({ type: 'stream_event', event, session_id: id });
    // Mirrors the CLI: thinking precedes text in the stream, and each finished
    // block is repeated as its own single-block assistant message.
    const reply = (messageId, text) => {
      event({ type: 'message_start', message: { id: messageId } });
      event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } });
      event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Considering.' } });
      send({ type: 'assistant', message: { id: messageId, content: [{ type: 'thinking', thinking: 'Considering.' }] }, session_id: id });
      event({ type: 'content_block_start', index: 1, content_block: { type: 'text' } });
      for (const part of [text.slice(0, 11), text.slice(11)]) event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: part } });
      send({ type: 'assistant', message: { id: messageId, content: [{ type: 'text', text }] }, session_id: id });
    };
    if (prompt === 'search') {
      reply('msg_1', 'Searching.');
      send({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', name: 'WebSearch' }] }, session_id: id });
      reply('msg_2', 'Found it.');
      send({ type: 'assistant', message: { id: 'msg_3', content: [{ type: 'text', text: 'Unstreamed.' }] }, session_id: id });
      send({ type: 'result', subtype: 'success', is_error: false, result: 'Unstreamed.', session_id: id }); return;
    }
    const response = JSON.stringify({ prompt, imageCount: input.message.content.filter(c => c.type === 'image').length, model: option('--model'), resumed: args.includes('--resume'), instructions: option('--system-prompt'), tools: option('--tools'), snapshot: option('--system-prompt-snapshot'), nested: !!process.env.CLAUDECODE });
    process.stdout.write('not-json\n');
    reply('msg_1', response);
    send({ type: 'result', subtype: 'success', is_error: false, result: response, session_id: id });
  });
}
