const fs = require('node:fs/promises');
const { RpcProcess, findCodex } = require('./codex.cjs');

// Codex dictation: the ChatGPT app's own transcription endpoint, reached with the user's Codex sign-in.
// It is undocumented, so AudioPipeline falls back to local Parakeet whenever a request fails.
const ENDPOINT = 'https://chatgpt.com/backend-api/transcribe';

class CodexDictation {
  constructor({ fetch, codexPath = findCodex(), timeoutMs = 8000 }) { Object.assign(this, { fetch, codexPath, timeoutMs }); }
  // The token stays in memory only; it is never saved or logged.
  async credentials(refresh = false) {
    if (!refresh && this.auth && this.auth.expires - 60000 > Date.now()) return this.auth;
    if (!refresh && this.loading) return this.loading;
    this.loading = (async () => {
      const rpc = new RpcProcess(this.codexPath, ['app-server', '--listen', 'stdio://']);
      try {
        await rpc.request('initialize', { clientInfo: { name: 'marc_local_companion', title: 'Local Companion', version: '0.1.0' } });
        rpc.send({ method: 'initialized', params: {} });
        const status = await rpc.request('getAuthStatus', { includeToken: true, refreshToken: refresh });
        let claims = null;
        try { claims = JSON.parse(Buffer.from(status.authToken.split('.')[1], 'base64url')); } catch {}
        const account = claims?.['https://api.openai.com/auth']?.chatgpt_account_id;
        if (!account) throw new Error('Codex dictation needs a ChatGPT sign-in. Run codex login in Terminal.');
        this.auth = { token: status.authToken, account, expires: claims.exp ? claims.exp * 1000 : Date.now() + 600000 };
        return this.auth;
      } finally { rpc.close(); this.loading = null; }
    })();
    return this.loading;
  }
  async post(file, auth) {
    const form = new FormData();
    form.append('file', new Blob([await fs.readFile(file)], { type: 'audio/wav' }), 'companion.wav');
    return this.fetch(new Request(ENDPOINT, { method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
      headers: { Authorization: `Bearer ${auth.token}`, 'ChatGPT-Account-Id': auth.account, originator: 'marc_local_companion', 'User-Agent': 'Local Companion/0.1.0' } }));
  }
  async transcribe(file, source) {
    const started = Date.now();
    let response = await this.post(file, await this.credentials());
    if (response.status === 401) response = await this.post(file, await this.credentials(true));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    return { type: 'transcript', source, text: String(body.text || '').trim(), seconds: (Date.now() - started) / 1000, engine: 'codex' };
  }
}
module.exports = { CodexDictation, ENDPOINT };
