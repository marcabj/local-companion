const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');

class AudioPipeline extends EventEmitter {
  constructor({ helper, python, worker, directory, startupTimeout = 15000 }) {
    super(); Object.assign(this, { helper, python, worker, directory, startupTimeout });
    this.jobs = new Set(); this.flushWaiters = new Map(); this.pending = new Map(); this.sequence = 0; this.listening = false;
  }
  async prepare() {
    if (this.loading) return this.loading;
    this.loading = new Promise((resolve, reject) => {
      const child = this.asr = spawn(this.python, ['-u', this.worker], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TOKENIZERS_PARALLELISM: 'false' } });
      let ready = false, errorTail = '';
      const timer = setTimeout(() => { reject(new Error('Parakeet setup timed out. Check your connection and retry.')); child.kill(); }, 600000);
      child.stderr.on('data', b => { errorTail = (errorTail + b).slice(-1500); });
      child.stdin.on('error', () => {});
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', () => {
        clearTimeout(timer); this.loading = null; this.asr = null;
        if (!ready) reject(new Error(errorTail || 'Parakeet could not start. Run the audio setup script.'));
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Parakeet stopped.')); }
        this.pending.clear();
        this.emit('pending');
        if (this.listening) { this.emit('problem', 'Parakeet stopped. Listening has stopped.'); void this.stop(); }
      });
      createInterface({ input: child.stdout }).on('line', line => {
        let m; try { m = JSON.parse(line); } catch { return; }
        if (m.type === 'ready') { ready = true; clearTimeout(timer); resolve(m); }
        if (m.type === 'status') this.emit('status', m.message);
        if (m.type === 'fatal') { clearTimeout(timer); reject(new Error(m.message)); }
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); this.emit('pending'); clearTimeout(p.timer); m.type === 'error' ? p.reject(new Error(m.message)) : p.resolve(m); }
      });
    });
    return this.loading;
  }
  async transcribe(file, source) {
    await this.prepare();
    if (this.pending.size >= 8) throw new Error('Transcription cannot keep up. Stop and restart listening.');
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); this.emit('pending'); reject(new Error('Transcription timed out. Stop and restart listening.')); }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      this.emit('pending');
      this.asr.stdin.write(JSON.stringify({ id, path: file, source }) + '\n');
    });
  }
  async start({ microphone = '', pid = '', sessionId } = {}) {
    this.lastError = null;
    if (this.capture) throw new Error('Audio capture is already starting or running.');
    await this.prepare();
    this.emit('status', 'Starting microphone and computer audio…');
    await fs.mkdir(this.directory, { recursive: true });
    const args = ['--listen', this.directory, '--microphone', microphone, '--pid', String(pid)];
    const child = this.capture = spawn(this.helper, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    let ready = false, failStart, completeStart;
    const started = new Promise((resolve, reject) => { completeStart = resolve; failStart = reject; });
    const timer = setTimeout(() => { failStart(new Error('Audio capture timed out. Check macOS system audio and microphone permissions, then try again.')); child.kill(); }, this.startupTimeout);
    child.on('error', e => { clearTimeout(timer); failStart(e); });
    child.stderr.on('data', () => {});
    child.on('close', () => { clearTimeout(timer); this.capture = null; this.listening = false; this.emit('listening', false); if (!ready) failStart(new Error('Audio capture stopped before it was ready. Check microphone and system audio permissions.')); });
    createInterface({ input: child.stdout }).on('line', async line => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.type === 'status') this.emit('status', m.message);
      if (m.type === 'started') { ready = true; clearTimeout(timer); this.listening = true; this.emit('listening', true); completeStart(); }
      if (m.type === 'level') this.emit('level', m);
      if (m.type === 'error') { this.lastError=m.message; clearTimeout(timer); if (!ready) failStart(new Error(m.message)); else this.emit('problem', m.message); void this.stop(); }
      if (m.type === 'flushed') { this.flushWaiters.get(m.id)?.(); this.flushWaiters.delete(m.id); }
      if (m.type === 'segment') {
        const job = (async () => {
        try { const result = await this.transcribe(m.path, m.source); if (result.text) this.emit('transcript', { ...result, at: m.at, sessionId }); }
        catch (e) { this.lastError=e.message; this.emit('problem', e.message); void this.stop(); }
        finally { await fs.rm(m.path, { force: true }).catch(() => {}); }
        })();
        this.jobs.add(job); job.finally(() => this.jobs.delete(job));
      }
    });
    return started;
  }
  async flush() {
    const child = this.capture;
    if (child && this.listening && child.exitCode === null) {
      const id = String(++this.sequence);
      await new Promise((resolve,reject) => {
        const timer=setTimeout(()=>{this.flushWaiters.delete(id);reject(new Error('Audio did not flush in time. Try Assist again.'));},5000);
        this.flushWaiters.set(id,()=>{clearTimeout(timer);resolve();});
        child.stdin.write(`flush:${id}\n`);
      });
    }
    await this.drain();
    if(this.lastError) throw new Error(this.lastError);
  }
  async drain() { await Promise.all([...this.jobs]); }
  async stop() {
    const child = this.capture;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end('stop\n');
    const timer = setTimeout(() => child.kill(), 3000);
    child.once('close', () => clearTimeout(timer));
    await new Promise(resolve => child.once('close', resolve));
    await this.drain();
  }
  close() { this.capture?.kill(); this.asr?.kill(); }
}
module.exports = { AudioPipeline };
