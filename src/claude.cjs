const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { EventEmitter, once } = require('node:events');
const { createInterface } = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { BASE_INSTRUCTIONS } = require('./prompts.cjs');
const runFile = promisify(execFile);

function findClaude() {
  return [process.env.COMPANION_CLAUDE, path.join(os.homedir(), '.local/bin/claude'), path.join(os.homedir(), '.claude/local/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']
    .filter(Boolean).find(p => fs.existsSync(p)) || 'claude';
}

// CLI aliases follow Anthropic's defaults without pinning a model version.
const models = ['sonnet', 'opus', 'haiku'].map(model => ({
  model, displayName: `Claude ${model[0].toUpperCase() + model.slice(1)}`, isDefault: model === 'sonnet',
  inputModalities: ['text', 'image'], defaultReasoningEffort: 'low',
  supportedReasoningEfforts: model === 'haiku' ? [] : ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort })),
}));

const SIGN_IN = 'Open Settings → Sign in to Claude, finish the login in Terminal, then reconnect Claude.';
const signInError = message => /not logged in|please run \/login|authentication_error|invalid api key|oauth token/i.test(message) ? SIGN_IN : message;

// When the companion is started from a Claude Code terminal, the CLI must not
// run as a child of that host session or borrow its entrypoint.
const HOST_SESSION = /^(CLAUDECODE|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|CHILD_SESSION|HOST_SESSION_ID|EXECPATH|MESSAGING_\w+|SDK_\w+)|CLAUDE_AGENT_SDK_\w+)$/;
const cliEnv = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([key]) => !HOST_SESSION.test(key)));

class ClaudeClient extends EventEmitter {
  constructor(cwd, options = {}) {
    super(); this.cwd = cwd; this.command = options.command || findClaude(); this.prefix = options.prefix || [];
    this.env = options.env || cliEnv(); this.connected = false; this.busy = false; this.children = new Set();
  }
  async connect() {
    if (this.busy) throw new Error('Stop the current answer before reconnecting.');
    this.connected = false;
    try {
      const { stdout } = await runFile(this.command, [...this.prefix, 'auth', 'status'], { cwd: this.cwd, env: this.env, timeout: 15000, maxBuffer: 100000 });
      const account = JSON.parse(stdout);
      if (account.loggedIn === false || !account.authMethod || account.authMethod === 'none') throw new Error(SIGN_IN);
      this.connected = true;
      return { models, auth: account.authMethod };
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('Claude Code is not installed. Open Settings → Set up Claude, then reconnect.');
      if (error.killed) throw new Error('Claude sign-in check timed out. Run claude auth status in Terminal, then reconnect.');
      if (typeof error.code === 'number') throw new Error(SIGN_IN);
      throw error;
    }
  }
  async ask({ threadId, text = '', images = [], model = 'sonnet', effort = 'low', smart = false, instructions = BASE_INSTRUCTIONS }) {
    if (this.busy) throw new Error('Wait for the current answer or stop it first.');
    if (!this.connected) throw new Error('Connect to Claude first.');
    this.busy = true;
    const run = this.run = { child: null, done: false, cancelled: false, sessionId: threadId || randomUUID(), text: '', message: null, streamed: new Set(), separate: false, stderr: '' };
    const finish = (status, message) => {
      if (run.done) return;
      run.done = true; clearTimeout(run.killTimer);
      if (this.run === run) { this.run = null; this.busy = false; }
      this.emit('completed', { status: run.cancelled ? 'interrupted' : status, ...(message ? { error: { message } } : {}) });
    };
    try {
      const content = [];
      if (text.trim()) content.push({ type: 'text', text });
      for (const file of images) {
        const bytes = await fs.promises.readFile(file);
        const media_type = bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png' : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : null;
        if (!media_type) throw new Error('Claude attachments must be PNG or JPEG images.');
        content.push({ type: 'image', source: { type: 'base64', media_type, data: bytes.toString('base64') } });
      }
      if (!content.length) throw new Error('Add a message, speech or an image before sending.');
      if (run.cancelled) throw new Error('Answer stopped before sending.');
      const input = JSON.stringify({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: run.sessionId }) + '\n';
      if (Buffer.byteLength(input) > 10 * 1024 * 1024) throw new Error('This chat’s text and images exceed Claude Code’s 10 MB input limit. Start a new chat or remove queued images.');
      const tools = smart ? 'WebSearch,WebFetch' : '';
      const args = [...this.prefix, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        '--model', model, '--system-prompt', instructions, '--system-prompt-snapshot', 'off',
        '--tools', tools, '--permission-mode', 'dontAsk', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-chrome',
        ...(smart ? ['--allowedTools', tools] : []),
        ...(model !== 'haiku' ? ['--effort', effort] : []),
        ...(threadId ? ['--resume', threadId] : ['--session-id', run.sessionId])];
      const child = run.child = spawn(this.command, args, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
      this.children.add(child);
      child.stderr.on('data', b => { run.stderr = (run.stderr + b).slice(-4000); });
      child.stdin.on('error', error => finish('failed', `Claude input failed: ${error.message}`));
      child.on('error', error => finish('failed', error.message));
      child.on('close', (code, signal) => {
        this.children.delete(child);
        if (!run.done) finish('failed', run.stderr.trim() || `Claude stopped (${signal || code}) before completing its answer.`);
      });
      createInterface({ input: child.stdout }).on('line', line => {
        if (run.done) return;
        let message; try { message = JSON.parse(line); } catch { return; }
        if (message.session_id && message.session_id !== this.thread) { this.thread = message.session_id; this.emit('thread', this.thread); }
        // Separate text written before and after thinking or tool calls.
        const append = (delta, block) => {
          if ((block || run.separate) && run.text && !/\s$/.test(run.text)) delta = '\n\n' + delta;
          run.separate = false; run.text += delta; this.emit('delta', delta);
        };
        const event = message.type === 'stream_event' && message.event;
        if (event?.type === 'message_start') run.message = event.message?.id ?? null;
        if (event?.type === 'content_block_start' && event.content_block?.type === 'text') run.separate = true;
        if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') { run.streamed.add(run.message); append(event.delta.text); }
        // The CLI repeats each completed content block as its own assistant
        // message, so block indexes do not match the stream. Use these only
        // for API messages that were not streamed; synthetic messages repeat
        // errors that the result reports.
        if (message.type === 'assistant' && message.message?.model !== '<synthetic>' && !run.streamed.has(message.message?.id ?? null)) {
          for (const block of message.message?.content || []) if (block.type === 'text' && block.text) append(block.text, true);
        }
        if (message.type === 'result') {
          const failed = message.is_error || message.subtype !== 'success';
          if (!failed && !run.text && message.result) this.emit('message', { text: message.result });
          finish(failed ? 'failed' : 'completed', failed ? signInError(message.errors?.join('\n') || message.result || 'Claude could not complete this answer.') : undefined);
        }
      });
      await once(child, 'spawn');
      child.stdin.end(input);
      return { threadId: run.sessionId };
    } catch (error) {
      if (this.run === run) { this.run = null; this.busy = false; }
      run.done = true; if (run.child) run.child.kill();
      throw error;
    }
  }
  async interrupt() {
    const run = this.run;
    if (!run || run.done) return;
    run.cancelled = true;
    if (run.child) {
      run.child.kill('SIGINT');
      run.killTimer = setTimeout(() => { if (!run.done) run.child.kill('SIGTERM'); }, 1500);
      run.killTimer.unref();
    }
  }
  disconnect() {
    this.connected = false;
    if (this.run) { this.run.done = true; clearTimeout(this.run.killTimer); this.run = null; }
    for (const child of this.children) child.kill('SIGTERM');
    this.busy = false;
  }
}

module.exports = { ClaudeClient, findClaude };
