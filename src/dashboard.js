const $ = id => document.getElementById(id);
const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const act = (name, value) => window.companion.action(name, value);
const SHORTCUT_LABELS = {focus:'Type a question',assist:'Send',visibility:'Show / hide companion',listen:'Listen / pause',screenshot:'Queue screenshot',screenTranscript:'Quick Assist',transcribeMode:'Transcribe mode',new:'New chat',moveUp:'Move up',moveDown:'Move down',moveLeft:'Move left',moveRight:'Move right',scrollUp:'Scroll up',scrollDown:'Scroll down'};
let state, page = 'start', editingModeId = null, editingTextId = null, historyKey = '';

function setOptions(select, entries, selected) {
  const signature = JSON.stringify(entries);
  if (select.dataset.options !== signature) { select.innerHTML = entries.map(([value, label]) => `<option value="${escape(value)}">${escape(label)}</option>`).join(''); select.dataset.options = signature; }
  select.value = selected;
}
const chars = n => `${Number(n || 0).toLocaleString()} characters`;
const day = ms => ms ? new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
function showPage(name) {
  page = name;
  for (const el of document.querySelectorAll('.page')) el.hidden = el.id !== `page-${name}`;
  for (const el of document.querySelectorAll('[data-page]')) el.classList.toggle('selected', el.dataset.page === name);
  if (name === 'settings') void loadSources();
  if (name === 'context') void act('reload-context');
  if (state) render(state);
}
async function loadSources() {
  const result = await act('sources');
  if (result.ok) setOptions($('microphone'), [['', 'System default microphone'], ...result.value.microphones.map(d => [d.id, d.name])], state?.microphone || '');
}

function render(s) {
  state = s;
  const busy = s.busy || s.requesting;
  $('connection').textContent = s.status; $('connection-dot').classList.toggle('ready', s.connected);
  $('error').hidden = !s.problem; $('error').querySelector('span').textContent = s.problem || '';
  renderStart(s, busy); renderContext(s); renderModes(s, busy); renderHistory(s); renderSettings(s, busy);
}
function renderStart(s, busy) {
  setOptions($('start-mode'), s.modes.map(m => [m.id, m.name]), s.modeId);
  $('start-mode').disabled = busy;
  $('start-provider').value = s.selectedProvider || 'codex';
  $('start-provider').disabled = busy || s.connecting;
  const plain = s.modeId === 'plain';
  $('start-plain').hidden = !plain;
  $('start-context').classList.toggle('muted', plain);
  $('start-context').innerHTML = s.contextItems.length
    ? s.contextItems.map(c => `<label class="check"><input type="checkbox" data-toggle="${escape(c.id)}" ${c.enabled ? 'checked' : ''} ${plain ? 'disabled' : ''}><span>${escape(c.name)}<small>${c.kind === 'file' ? 'File' : 'Text'} · ${chars(c.chars)}${c.missing ? ' · file not found' : ''}</small></span></label>`).join('')
    : '<p class="empty">No context yet. <button class="link" data-goto="context">Add your résumé or notes</button></p>';
  for (const button of document.querySelectorAll('[data-untick-all]')) button.hidden = !s.contextItems.some(c => c.enabled) || plain;
  $('start-context-total').textContent = s.contextItems.length ? `Ticked: ${chars(s.contextChars)} of ${s.contextLimit.toLocaleString()}` : '';
  const continuing = !!s.session?.messages?.length;
  $('start').textContent = continuing ? 'Continue current chat' : 'Start companion';
  $('start').title = continuing ? `Return to “${s.session.title}”` : '';
  $('start-new').hidden = !continuing;
  $('start-new').disabled = busy || s.audioBusy;
}
function renderContext(s) {
  $('context-list').innerHTML = s.contextItems.map(c => `<div class="item">
    <input type="checkbox" data-toggle="${escape(c.id)}" ${c.enabled ? 'checked' : ''} aria-label="Send ${escape(c.name)} with chats">
    <span class="item-main"><strong>${escape(c.name)}</strong><small>${c.kind === 'file' ? escape(c.path) : 'Pasted text'} · ${chars(c.chars)} · updated ${day(c.updatedAt)}${c.missing ? ' · <em>file not found, using the last copy</em>' : ''}</small></span>
    ${c.kind === 'text' ? `<button class="secondary" data-edit="${escape(c.id)}">Edit</button>` : ''}
    <button class="secondary" data-remove="${escape(c.id)}">Remove</button></div>`).join('')
    || '<p class="empty">Nothing here yet. Add a file or paste some text to get started.</p>';
  $('context-total').textContent = s.contextItems.length ? `Ticked items: ${chars(s.contextChars)} of ${s.contextLimit.toLocaleString()} per chat.` : '';
}
function renderModes(s, busy) {
  const editable = s.modes.filter(m => m.id !== 'plain');
  if (!editable.some(m => m.id === editingModeId)) editingModeId = editable.some(m => m.id === s.modeId) ? s.modeId : editable[0].id;
  setOptions($('mode-select'), editable.map(m => [m.id, m.name + (m.id === s.modeId ? ' (active)' : '')]), editingModeId);
  const mode = s.modes.find(m => m.id === editingModeId);
  if ($('mode-name').dataset.mode !== mode.id) {
    $('mode-name').value = mode.name; $('mode-instructions').value = mode.instructions; $('mode-notes-template').value = mode.notesTemplate || '';
    $('mode-name').dataset.mode = mode.id;
  }
  $('delete-mode').hidden = s.builtinModeIds?.includes(mode.id) ?? true;
  for (const id of ['save-mode', 'delete-mode', 'new-mode']) $(id).disabled = busy;
}
function renderHistory(s) {
  const query = $('history-search').value.toLowerCase();
  const key = JSON.stringify([s.sessions, s.session?.id, query]);
  if (key === historyKey) return;
  historyKey = key;
  $('history-list').innerHTML = s.sessions.filter(v => !query || v.searchText?.includes(query) || v.title.toLowerCase().includes(query))
    .map(v => `<button class="history-row${v.id === s.session?.id ? ' current' : ''}" data-session="${escape(v.id)}"><span>${escape(v.title)}</span><small>${new Date(v.createdAt).toLocaleString()}${v.id === s.session?.id ? ' · current' : ''}${v.hasNotes ? ' · notes' : ''}</small></button>`).join('')
    || '<p class="empty">No matching chats.</p>';
}
function renderSettings(s, busy) {
  const p = s.preferences || {};
  const claude = s.selectedProvider === 'claude', provider = claude ? 'Claude' : 'Codex';
  $('provider').value = s.selectedProvider || 'codex'; $('provider').disabled = busy || s.connecting;
  $('provider-help').textContent = claude
    ? 'Uses Claude Code on this Mac. Sign in, finish in Terminal, then reconnect. Switching providers shares this chat’s earlier messages and images with the selected provider.'
    : 'Uses your signed-in Codex CLI. Switching providers shares this chat’s earlier messages and images with the selected provider.';
  $('reconnect').textContent = `Reconnect ${provider}`; $('reconnect').disabled = busy || s.connecting;
  $('claude-setup').hidden = !claude; $('claude-login').hidden = !claude;
  const audioLocked = busy || s.listening || s.audioBusy;
  for (const id of ['microphone', 'audio-source', 'refresh-apps']) $(id).disabled = audioLocked;
  $('audio-locked').hidden = !(s.listening || s.audioBusy);
  if ($('microphone').dataset.options) $('microphone').value = s.microphone || '';
  for (const [id, key] of Object.entries(TOGGLES)) { $(id).checked = !!p[key]; $(id).disabled = busy; }
  $('no-focus').disabled = busy || !p.contentProtection;
  $('language').value = p.language || 'Auto'; $('language').disabled = busy;
  $('speech-to-text').value = p.speechToText || 'parakeet'; $('speech-to-text').disabled = busy;
  $('speech-to-text-help').textContent = p.speechToText === 'codex'
    ? 'Sends each speech segment to OpenAI using your Codex sign-in. This endpoint is undocumented and may stop working; if a request fails, the rest of that Listen session uses local Parakeet.'
    : 'Audio is transcribed on this Mac and never leaves it.';
  const privacy = s.privacyStatus;
  $('privacy-status').textContent = privacy ? `Capture exclusion requested: ${privacy.contentProtection ? 'yes' : 'no'} · Dock: ${privacy.dockVisible ? 'visible' : 'hidden'} · Keyboard: ${privacy.keyboardFocus ? 'enabled' : 'shortcuts only'}` : '';
  $('permission-status').textContent = `Microphone: ${s.permissions?.microphone || 'unknown'} · Screen: ${s.permissions?.screen || 'unknown'}`;
  const shortcuts = JSON.stringify(p.shortcuts || {});
  if ($('shortcut-fields').dataset.key !== shortcuts) {
    $('shortcut-fields').innerHTML = Object.entries(p.shortcuts || {}).map(([key, value]) => `<label class="row"><span>${escape(SHORTCUT_LABELS[key] || key)}</span><input data-shortcut="${escape(key)}" value="${escape(value)}"></label>`).join('');
    $('shortcut-fields').dataset.key = shortcuts;
  }
  if (document.activeElement !== $('base-instructions')) $('base-instructions').value = p.baseInstructions || '';
}
const TOGGLES = {'screen-use':'screenUse','smart':'smart','auto-notes':'autoNotes','content-protection':'contentProtection','no-focus':'noFocusWhenPrivate','request-details':'showRequestDetails'};

document.addEventListener('click', event => {
  const nav = event.target.closest('[data-page],[data-goto]');
  if (nav) showPage(nav.dataset.page || nav.dataset.goto);
});
document.addEventListener('change', event => {
  const toggle = event.target.closest('[data-toggle]');
  if (toggle) void act('update-context', { id: toggle.dataset.toggle, enabled: toggle.checked }).then(r => { if (!r.ok) toggle.checked = !toggle.checked; });
});
$('dismiss-error').onclick = () => act('dismiss-error');
for (const button of document.querySelectorAll('[data-untick-all]')) button.onclick = () => act('untick-all-context');

// Start
$('start-mode').onchange = () => act('mode', $('start-mode').value);
$('start-provider').onchange = () => act('provider', $('start-provider').value);
$('start').onclick = () => act('start');
$('start-new').onclick = () => act('start', { newChat: true });

// Context
function openTextEditor(id, name = '', text = '') {
  editingTextId = id; $('text-name').value = name; $('text-body').value = text;
  $('text-editor').hidden = false; $('text-name').focus();
}
$('add-files').onclick = () => act('add-context-files');
$('add-text').onclick = () => openTextEditor(null);
$('text-cancel').onclick = () => { $('text-editor').hidden = true; editingTextId = null; };
$('text-save').onclick = async () => {
  const payload = { name: $('text-name').value, text: $('text-body').value };
  const result = editingTextId ? await act('update-context', { id: editingTextId, ...payload }) : await act('add-context-text', payload);
  if (result.ok) { $('text-editor').hidden = true; editingTextId = null; }
};
$('context-list').onclick = async event => {
  const edit = event.target.closest('[data-edit]'), remove = event.target.closest('[data-remove]');
  if (edit) {
    const item = state.contextItems.find(c => c.id === edit.dataset.edit);
    const result = await act('context-text', item.id);
    if (result.ok) openTextEditor(item.id, item.name, result.value);
  }
  if (remove) {
    const item = state.contextItems.find(c => c.id === remove.dataset.remove);
    if (window.confirm(`Remove “${item.name}” from your context?${item.kind === 'file' ? ' The original file is not deleted.' : ''}`)) await act('remove-context', item.id);
  }
};

// Modes
$('mode-select').onchange = () => { editingModeId = $('mode-select').value; render(state); };
$('new-mode').onclick = async () => { const before = new Set(state.modes.map(m => m.id)); const result = await act('new-mode'); if (result.ok) { editingModeId = result.value.modes.find(m => !before.has(m.id))?.id || editingModeId; render(result.value); $('mode-name').focus(); } };
$('save-mode').onclick = async () => {
  const result = await act('save-mode', { id: editingModeId, name: $('mode-name').value, instructions: $('mode-instructions').value, notesTemplate: $('mode-notes-template').value });
  if (result.ok) { $('mode-saved').hidden = false; setTimeout(() => { $('mode-saved').hidden = true; }, 1500); }
};
$('delete-mode').onclick = async () => {
  const mode = state.modes.find(m => m.id === editingModeId);
  if (window.confirm(`Delete the mode “${mode.name}”?`)) { const result = await act('delete-mode', mode.id); if (result.ok) editingModeId = null; }
};

// History
$('history-search').oninput = () => render(state);
$('history-list').onclick = async event => {
  const row = event.target.closest('[data-session]');
  if (row && (await act('session', row.dataset.session)).ok) await act('start');
};
$('export').onclick = () => act('export');

// Settings
$('provider').onchange = () => act('provider', $('provider').value);
$('reconnect').onclick = () => act('connect');
$('claude-setup').onclick = () => act('claude-setup');
$('claude-login').onclick = () => act('claude-login');
for (const id of ['permissions', 'microphone-permission']) $(id).onclick = () => act(id);
const audioSettings = () => act('settings', { model: state.selectedModel, effort: state.selectedEffort, microphone: $('microphone').value, audioPid: $('audio-source').value });
$('microphone').onchange = audioSettings; $('audio-source').onchange = audioSettings;
$('refresh-apps').onclick = async () => {
  $('refresh-apps').disabled = true;
  const result = await act('applications');
  if (result.ok) setOptions($('audio-source'), [['', 'All applications'], ...result.value.applications.sort((a, b) => a.name.localeCompare(b.name)).map(a => [String(a.pid), a.name])], state.audioPid);
  $('refresh-apps').disabled = false;
};
for (const [id, key] of Object.entries(TOGGLES)) $(id).onchange = () => act('preferences', { [key]: $(id).checked });
$('language').onchange = () => act('preferences', { language: $('language').value });
$('speech-to-text').onchange = () => act('preferences', { speechToText: $('speech-to-text').value });
$('save-shortcuts').onclick = () => act('preferences', { shortcuts: Object.fromEntries([...document.querySelectorAll('[data-shortcut]')].map(el => [el.dataset.shortcut, el.value.trim()])) });
$('save-base').onclick = () => act('preferences', { baseInstructions: $('base-instructions').value });

window.companion.onNavigate?.(name => { if (document.getElementById(`page-${name}`)) showPage(name); });
window.companion.onState(render);
window.companion.snapshot().then(s => { if (s.modes) render(s); });
