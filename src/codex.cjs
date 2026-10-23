const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createInterface } = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

class RpcProcess extends EventEmitter {
  constructor(command, args, options = {}) {
    super(); this.sequence = 0; this.pending = new Map(); this.closed = false;
    this.child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    this.stderr = '';
    this.child.stderr.on('data', b => { this.stderr = (this.stderr + b).slice(-4000); });
    this.child.on('error', e => this.fail(e));
    this.child.on('exit', (code, signal) => this.fail(new Error(`Codex stopped (${signal || code}). Reconnect to continue.`)));
    this.child.stdin.on('error', e => this.fail(e));
    createInterface({ input: this.child.stdout }).on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.id != null && !message.method) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else pending.resolve(message.result);
      } else if (message.id != null) {
        // This companion answers questions; interactive tool actions have no UI here.
        this.send({ id: message.id, error: { code: -32601, message: 'Interactive tools are not available in this companion. Answer using supplied context.' } });
      } else this.emit('notification', message);
    });
  }
  send(message) {
    if (this.closed) throw new Error('Codex is disconnected. Reconnect to continue.');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params = {}, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); this.emit('diagnostic', this.stderr); reject(new Error(`${method} timed out. Try reconnecting.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  fail(error) {
    if (this.closed) return; this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.emit('disconnected', error);
  }
  close() { this.fail(new Error('Codex connection closed.')); this.child.stdin.end(); this.child.kill(); }
}

function findCodex() {
  return [process.env.COMPANION_CODEX, path.join(os.homedir(), '.local/bin/codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex'].filter(Boolean).find(p => fs.existsSync(p)) || 'codex';
}

const { BASE_INSTRUCTIONS } = require('./prompts.cjs');

class CodexClient extends EventEmitter {
  constructor(cwd) { super(); this.instructionProfiles=new Map(); this.cwd = cwd; this.thread = null; this.turn = null; this.busy = false; }
  async connect() {
    this.disconnect();
    const rpc = this.rpc = new RpcProcess(findCodex(), ['app-server', '--listen', 'stdio://'], { cwd: this.cwd });
    rpc.on('diagnostic', text => this.emit('diagnostic', text));
    rpc.on('notification', message => {
      const p = message.params || {};
      if (p.threadId && p.threadId !== this.thread) return;
      if (message.method === 'item/agentMessage/delta') this.emit('delta', p.delta);
      if (message.method === 'item/completed' && p.item?.type === 'agentMessage') this.emit('message', p.item);
      if (message.method === 'turn/started') {
        this.turn = p.turn?.id; this.turnStarted = true;
        if (this.cancelRequested) void this.interrupt().catch(error => this.emit('cancelError', error.message));
      }
      if (message.method === 'turn/completed') {
        this.turn = null; this.busy = false; this.turnStarted = false; this.cancelRequested = false; this.emit('completed', p.turn);
      }
    });
    rpc.on('disconnected', e => { this.busy = false; this.turn = null; this.thread = null; this.emit('disconnected', e.message); });
    await rpc.request('initialize', { clientInfo: { name: 'marc_local_companion', title: 'Local Companion', version: '0.1.0' } });
    rpc.send({ method: 'initialized', params: {} });
    const account = await rpc.request('account/read', { refreshToken: false });
    if (!account.account && account.requiresOpenaiAuth) throw new Error('Sign in first: run codex login in Terminal, then reconnect.');
    const { config } = await rpc.request('config/read', { includeLayers: false });
    // The companion supplies its own screen/audio context and does not need the
    // user's development MCP servers (some require a parent Codex app session).
    this.threadConfig = { mcp_servers: Object.fromEntries(Object.keys(config.mcp_servers || {}).map(name => [name, { enabled: false }])) };
    const models = await rpc.request('model/list', {});
    return { models: models.data, auth: account.account?.type || 'configured provider' };
  }
  async ask({ threadId, text, image, images = [], model, effort = 'low', serviceTier = 'default', smart = false, instructions = BASE_INSTRUCTIONS }) {
    if (this.busy) throw new Error('Wait for the current answer or stop it first.');
    if (!this.rpc || this.rpc.closed) throw new Error('Connect to Codex first.');
    this.busy = true; this.turnStarted = false; this.cancelRequested = false;
    try {
      const profile = JSON.stringify({smart,instructions});
      if (threadId !== this.thread || !this.thread || profile !== this.profile) {
        const params = { model, serviceTier, cwd: this.cwd, approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: 'You are Local Companion. Follow the current conversation configuration supplied in developer instructions. Respond in the chat.', developerInstructions: instructions, config: { ...this.threadConfig, web_search: smart ? 'live' : 'disabled' } };
        const response = threadId
          ? await this.rpc.request('thread/resume', { ...params, threadId })
          : await this.rpc.request('thread/start', params);
        this.thread = response.thread.id; this.profile = profile;
        this.emit('thread', this.thread);
        if(!threadId) this.instructionProfiles.set(this.thread,instructions);
      }
      // Resuming an already-loaded thread does not reliably replace its instructions.
      // Append configuration only when it changes (or after restoring an unknown thread).
      if(this.instructionProfiles.get(this.thread)!==instructions) {
        await this.rpc.request('thread/inject_items',{threadId:this.thread,items:[{type:'message',role:'developer',content:[{type:'input_text',text:`Current conversation configuration:\n${instructions}`}]}]});
        this.instructionProfiles.set(this.thread,instructions);
      }
      const input = [];
      if (text?.trim()) input.push({type:'text',text});
      for(const file of [...images, ...(image?[image]:[])]) input.push({type:'localImage',path:file});
      if(!input.length) throw new Error('Add a message, speech or an image before sending.');
      const response = await this.rpc.request('turn/start', { threadId: this.thread, input, model, effort, serviceTier }, 60000);
      // A very short turn may complete before its start response is delivered.
      if (this.busy) this.turn = response.turn.id;
      return { threadId: this.thread };
    } catch (e) { this.busy = false; this.turn = null; throw e; }
  }
  async interrupt() {
    if (!this.busy) return;
    this.cancelRequested = true;
    if (!this.turn || !this.turnStarted) return;
    try { await this.rpc.request('turn/interrupt', { threadId: this.thread, turnId: this.turn }); }
    catch (error) { if (!/no active turn/i.test(error.message)) throw error; }
  }
  disconnect() { if (this.rpc) this.rpc.close(); this.rpc = null; this.thread = null; this.turn = null; this.busy = false; }
}
module.exports = { RpcProcess, CodexClient };
