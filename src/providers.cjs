const { EventEmitter } = require('node:events');
const { CodexClient } = require('./codex.cjs');
const { ClaudeClient } = require('./claude.cjs');

const PROVIDERS = [{ id: 'codex', name: 'Codex' }, { id: 'claude', name: 'Claude' }];
const providerName = id => PROVIDERS.find(p => p.id === id)?.name || 'Codex';

class ProviderClient extends EventEmitter {
  constructor(cwd, clients = { codex: new CodexClient(cwd), claude: new ClaudeClient(cwd) }) {
    super(); this.clients = clients; this.provider = 'codex';
    for (const [provider, client] of Object.entries(clients)) {
      for (const event of ['thread', 'delta', 'message', 'completed', 'disconnected', 'diagnostic', 'cancelError']) {
        client.on(event, (...args) => { if (this.provider === provider) this.emit(event, ...args); });
      }
    }
  }
  async connect(provider = this.provider) {
    if (!Object.hasOwn(this.clients, provider)) throw new Error('Unknown answer provider.');
    this.provider = provider;
    return this.clients[provider].connect();
  }
  ask(request) { return this.clients[this.provider].ask(request); }
  interrupt() { return this.clients[this.provider].interrupt(); }
  disconnect() { for (const client of Object.values(this.clients)) client.disconnect(); }
}

// Keep backend session IDs separate. Legacy sessions belong to Codex.
function routeState(session, provider) {
  session.providerState ||= {};
  if (!session.providerState.codex && session.threadId) {
    session.providerState.codex = { threadId: session.threadId, through: session.messages.length };
  }
  return session.providerState[provider] ||= { threadId: null, through: 0 };
}

function routeRequest(session, provider, prepared) {
  const route = routeState(session, provider);
  const end = prepared.historyEnd ?? session.messages.length;
  const missed = session.messages.slice(route.through, end).filter(m => m.role === 'user' || (m.role === 'assistant' && m.text));
  if (!missed.length) return { threadId: route.threadId, text: prepared.prompt, images: prepared.images.map(i => i.path) };
  const images = [];
  const history = missed.map(m => ({
    role: m.role, text: m.prompt || m.text || '',
    ...(m.images?.length ? { images: m.images.map(i => { images.push(i.path); return images.length; }) } : {}),
  }));
  // Quote the handoff so old user requests and answers remain distinguishable
  // from the current request, including earlier instructions to wait.
  const text = `Earlier messages in this same Local Companion chat, supplied as conversation context. Image numbers refer to the first attached images. Continue from this history using the current mode instructions.\n${JSON.stringify(history)}\n\nCurrent user message:\n${prepared.prompt}`;
  return { threadId: route.threadId, text, images: [...images, ...prepared.images.map(i => i.path)] };
}

module.exports = { ProviderClient, PROVIDERS, providerName, routeState, routeRequest };
