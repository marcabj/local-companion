const $ = id => document.getElementById(id);
let modeEditorId = null;
function saveDraft() { window.companion.saveDraft?.($('question').value); }
document.addEventListener('input',event=>{if(event.target.id==='question')saveDraft();});
let state, currentView = 'chat', settingsOpen = false, messagesKey = '', transcriptKey = '', historyKey = '';
let displayedSession, latestTurnKey = '', pendingTurnAnchor = false;
const escape = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const markdown = text => DOMPurify.sanitize(marked.parse(text || ''), { FORBID_TAGS: ['img', 'iframe', 'style', 'form', 'input'] });
async function act(name, value) { return window.companion.action(name, value); }
function showView(name) { $('view-nav').hidden=name==='chat';$('view-title').textContent=({transcript:'Transcript',notes:'Notes',history:'History',modes:'Modes'})[name]||''; if(currentView!==name) $('content').scrollTop=0; currentView = name; act('view',name);document.body.classList.toggle('management-view',['modes','history'].includes(name)); document.body.classList.toggle('history-view', name === 'history' && !state?.compact); for (const el of document.querySelectorAll('.view')) el.hidden = el.id !== name; for (const el of document.querySelectorAll('[data-view]')) el.classList.toggle('selected', el.dataset.view === name); hideScreenPreview(); if(name==='chat')followLatestMessage(); else updateMessageScroll(); }
function setOptions(select, entries, selected) {
  const signature = JSON.stringify(entries);
  if (select.dataset.options !== signature) { select.innerHTML = entries.map(([value, label]) => `<option value="${escape(value)}">${escape(label)}</option>`).join(''); select.dataset.options = signature; }
  select.value = selected;
}
function renderPrivacyToggle(enabled) {
  const button = $('privacy-toggle');
  const label = enabled ? 'Privacy mode on · Click to disable' : 'Privacy mode off · Click to enable';
  button.setAttribute('aria-pressed', String(enabled));
  button.setAttribute('aria-label', label); button.title = label;
  button.classList.toggle('active', enabled);
  $('privacy-eye').toggleAttribute('hidden', enabled); $('privacy-incognito').toggleAttribute('hidden', !enabled);
}
function render(s) {
  const expanding = state?.compact && !s.compact;
  if(s.session?.id && s.session.id!==state?.session?.id) $('question').value=s.session.draft||'';
  state = s;
  renderPrivacyToggle(!!s.preferences.contentProtection);
  if(settingsOpen){$('content-protection').checked=!!s.preferences.contentProtection;$('no-focus').checked=!!s.preferences.noFocusWhenPrivate;renderPrivacyStatus();}
  document.body.classList.toggle('compact', s.compact);
  document.body.classList.toggle('history-view', !s.compact && currentView === 'history' && !settingsOpen);
  $('connection').textContent = s.status; $('connection-dot').classList.toggle('ready', s.connected);
  const provider=s.selectedProvider==='claude'?'Claude':'Codex';
  $('provider-label').textContent=provider;
  $('provider-toggle').title=`Route answers to ${provider} · Choose provider`;
  $('provider-toggle').setAttribute('aria-label',`Answer provider: ${provider}. Choose provider`);
  $('provider-toggle').disabled=s.busy || s.requesting || s.connecting;
  $('provider').value=s.selectedProvider || 'codex';
  $('provider').disabled=s.busy || s.requesting || s.connecting;
  $('provider-help').textContent=s.selectedProvider==='claude'?'Uses Claude Code on this Mac. Sign in below, finish in Terminal, then reconnect. Model aliases follow Claude defaults; availability depends on your account. Switching providers shares this chat’s earlier messages and images with the selected provider.':'Uses your signed-in Codex CLI. Switching providers shares this chat’s earlier messages and images with the selected provider.';
  $('claude-setup').hidden=s.selectedProvider!=='claude';
  $('claude-login').hidden=s.selectedProvider!=='claude';
  $('reconnect').textContent=`Reconnect ${provider}`;
  $('reconnect').disabled=s.busy || s.requesting || s.connecting;
  $('audio-status').textContent = s.audioStatus; $('error').hidden = !s.problem; $('error').querySelector('span').textContent = s.problem;
  $('model-label').textContent = s.selectedModel; $('model-toggle').title='Choose model · '+(s.models.find(m=>m.model===s.selectedModel)?.displayName || s.selectedModel || 'Connecting…')+' · '+s.selectedEffort+' · '+(s.models.find(m=>m.model===s.selectedModel)?.serviceTiers?.find(t=>t.id===s.selectedServiceTier)?.name || 'Standard'); $('model-toggle').disabled=s.busy || s.requesting || !s.models.length; $('send').hidden = s.busy; $('stop').hidden = !s.busy;
  $('send').disabled = !s.connected || s.requesting || s.capturing; $('send').title = 'Send message, attached images and new speech';
  $('screen').disabled=s.requesting || s.capturing;
  const screenShortcut=s.preferences.shortcuts?.screenshot;
  $('screen').title='Attach screenshot'+(screenShortcut?' · '+screenShortcut.replaceAll('Alt','Option').replaceAll('+','–')+(screenShortcut==="Control+Alt+'"?' (è on Canadian–CSA)':''):'');
  $('active-mode').textContent=s.modes?.find(m=>m.id===s.modeId)?.name || 'General';
  $('end-session').disabled=s.busy||s.requesting||s.audioBusy||(!s.listening&&!s.session.transcript.length);
  for(const button of document.querySelectorAll('[data-action]')) button.disabled=s.busy||s.requesting||!s.connected;
  $('mode-toggle').disabled=s.busy || s.requesting;
  renderModes(s); renderNotes(s);
   $('image').disabled = s.requesting || s.capturing;
  $('listen').disabled = s.audioBusy; $('listen').classList.toggle('active', s.listening);
  $('listen').classList.toggle('loading', s.audioBusy);
  const listenLabel = s.audioBusy ? 'Starting…' : s.listening ? 'Pause' : 'Listen';
  $('listen').querySelector('span').textContent = listenLabel;
  $('listen').setAttribute('aria-label', listenLabel); $('listen').title = listenLabel;
  $('meters').hidden = !s.listening;
  $('transcript-empty-title').textContent = s.audioBusy ? 'Preparing local transcription…' : s.listening ? 'Listening…' : 'Ready to listen';
  $('transcript-empty-hint').textContent = s.audioBusy ? 'Loading Parakeet and opening your audio inputs.' : 'Play a video or speak. Words appear here after a short pause.';
  updateCaptureStatus();
  renderAttachments(s.attachments || []);
  setOptions($('model'), s.models.map(m => [m.model, m.displayName || m.model]), s.selectedModel);
  const model = s.models.find(m => m.model === $('model').value);
  setOptions($('effort'), (model?.supportedReasoningEfforts || []).map(e => [e.reasoningEffort, e.reasoningEffort[0].toUpperCase() + e.reasoningEffort.slice(1)]), s.selectedEffort);
  for (const id of ['model', 'effort', 'microphone', 'audio-source']) $(id).disabled = s.busy || s.listening || s.audioBusy;
  $('transcript-count').textContent = s.session.transcript.length || '';
  renderMessages(s);
  if (expanding) followLatestMessage();
  updateMessageScroll();
  const tk = JSON.stringify(s.session.transcript);
  if (tk !== transcriptKey) {
    const nearBottom = $('content').scrollHeight - $('content').scrollTop - $('content').clientHeight < 100;
    $('transcript').querySelector('.empty').hidden = s.session.transcript.length > 0;
    $('transcript-lines').innerHTML = s.session.transcript.map((t,i) => `<article class="transcript-line"><div class="who">${escape(t.source)}<time>${new Date(t.at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><button class="transcript-text" data-transcript="${i}" title="Ask about this line">${escape(t.text)}</button></article>`).join('');
    transcriptKey = tk;
    if (nearBottom && currentView === 'transcript') $('content').scrollTop = $('content').scrollHeight;
  }
  const hk = JSON.stringify([s.sessions, s.session.id,$('history-search').value]);
  if (hk !== historyKey) { $('history-list').innerHTML = s.sessions.filter(v=>!$('history-search').value || v.searchText?.includes($('history-search').value.toLowerCase()) || v.title.toLowerCase().includes($('history-search').value.toLowerCase())).map(v => `<button class="history-row ${v.id === s.session.id ? 'current' : ''}" data-session="${v.id}"><span>${escape(v.title)}</span><small>${new Date(v.createdAt).toLocaleString()}</small></button>`).join(''); historyKey = hk; }
}
function renderAttachments(images) {
  const container=$('attachment');container.hidden=!images.length;
  const key=JSON.stringify(images);
  if(container.dataset.key===key)return;
  container.innerHTML=images.map((image,i)=>`<div class="attachment-chip"><img src="${escape(image.preview)}" alt="Attachment ${i+1}"><span>${escape(image.name)} ${i+1}</span><button data-remove-image="${escape(image.id)}" type="button" aria-label="Remove attachment ${i+1}">×</button></div>`).join('');
  container.dataset.key=key;
}
function messageImages(message) {return message?.images || (message?.image?[{preview:message.image}]:[]);}
function followLatestMessage() {
  pendingTurnAnchor = true;
  layoutLatestTurn();
  if(typeof requestAnimationFrame === 'function') requestAnimationFrame(layoutLatestTurn);
}
function layoutLatestTurn() {
  if(currentView !== 'chat' || settingsOpen || state?.compact) { updateMessageScroll(); return; }
  const content = $('content'), messages = $('messages');
  const answer = messages.lastElementChild;
  const question = answer?.previousElementSibling?.classList.contains('user') ? answer.previousElementSibling : null;
  if(answer?.classList.contains('assistant')) {
    // Reserve a viewport for the latest turn so even a short answer leaves its question at the top.
    answer.style.minHeight = `${Math.max(0, content.clientHeight - (question?.offsetHeight || 0) - 18)}px`;
  }
  if(pendingTurnAnchor && content.clientHeight > 0) {
    const anchor = question || answer;
    if(anchor) content.scrollTop += anchor.getBoundingClientRect().top - content.getBoundingClientRect().top - 6;
    else content.scrollTop = 0;
    pendingTurnAnchor = false;
  }
  updateMessageScroll();
}
function updateMessageScroll() {
  const content = $('content');
  const visible = currentView === 'chat' && !settingsOpen && !state?.compact;
  const below = visible && content.scrollHeight - content.scrollTop - content.clientHeight > 4;
  $('jump-latest').hidden = !below;
  content.classList.toggle('more-below', !!below);
}
const copyIcon = '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></svg>';
const copiedIcon = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>';
function assistantMarkup(m, i, messages) {
  const request = messages[i - 1];
  const images=messageImages(request);
  const screen=request?.role==='user'?images.map((_,index)=>`<button class="viewed-screen" data-screen="${i-1}" data-image-index="${index}" aria-label="Preview image ${index+1}">${images.length===1?'Viewed screen':`Image ${index+1}`}</button>`).join(''):'';
  const working = m.state === 'working';
  const text = m.text ? markdown(m.text) : working ? '<span class="loading-dot" role="status" aria-label="Loading"></span>' : m.state === 'failed' || m.state === 'interrupted' ? '' : '<p>Nothing to add right now.</p>';
  const error = m.state === 'failed' || m.state === 'interrupted' ? `<div class="message-state">${escape(m.error || 'Answer stopped')}</div>` : '';
  const controls = !working ? `<div class="response-actions">${m.text?.trim() ? `<button class="response-copy" data-copy="${i}" title="Copy response" aria-label="Copy response">${copyIcon}</button>` : ''}${i === messages.length - 1 ? '<details class="response-more"><summary aria-label="Response actions" title="Response actions">···</summary><button data-retry="true">Retry answer</button></details>' : ''}${m.provider?`<span class="response-provider" title="${escape(m.model)}">${m.provider==='claude'?'Claude':'Codex'}</span>`:''}</div>` : '';
  return `${screen}<div class="markdown">${text}</div>${error}${controls}`;
}
function renderMessages(s) {
  const key = JSON.stringify([s.session.id,s.session.messages,s.preferences?.showRequestDetails]);
  if (key !== messagesKey) {
    if(displayedSession !== s.session.id) { $('messages').replaceChildren(); displayedSession = s.session.id; latestTurnKey = ''; hideScreenPreview(); }
    $('welcome').hidden = s.session.messages.length > 0;
    const container = $('messages');
    s.session.messages.forEach((m, i) => {
      let article = container.children[i];
      if(!article) { article = document.createElement('article'); container.appendChild(article); }
      article.className = `message ${m.role}`;
      if(i !== s.session.messages.length - 1) article.style.minHeight = '';
      const signature = JSON.stringify([m,s.preferences?.showRequestDetails,i === s.session.messages.length - 1,s.session.messages[i-1]?.image]);
      if(article.dataset.signature === signature) return;
      if(m.role === 'user') {
        article.innerHTML = `<div class="text">${escape(m.text)}</div>${m.context && s.preferences?.showRequestDetails ? `<details class="request-context"><summary>${m.context.screen?'Viewed screen · ':''}${m.context.transcriptCount} transcript segments · ${escape(m.context.mode)}${m.context.smart?' · Smart':''}</summary><pre>${escape(m.prompt||'')}</pre></details>`:''}`;
      } else {
        // Keep the screenshot trigger and existing messages stable during streamed updates.
        const holder = document.createElement('div'); holder.innerHTML = assistantMarkup(m, i, s.session.messages);
        if(article.querySelector('.markdown')) {
          const previous = article.querySelector('.markdown'), next = holder.querySelector('.markdown');
          if(previous.innerHTML !== next.innerHTML) previous.innerHTML = next.innerHTML;
          for(const selector of ['.message-state','.response-actions']) {
            article.querySelector(selector)?.remove();
            const element = holder.querySelector(selector); if(element) article.appendChild(element);
          }
        } else article.innerHTML = holder.innerHTML;
      }
      article.dataset.signature = signature;
    });
    while(container.children.length > s.session.messages.length) container.lastElementChild.remove();
    const turn = `${s.session.id}:${s.session.messages.length}`;
    if(turn !== latestTurnKey) { latestTurnKey = turn; followLatestMessage(); }
    else layoutLatestTurn();
    messagesKey = key;
  }
}
async function settings(value) {
  settingsOpen = value; if(value)$('view-nav').hidden=true; if(!value && !state?.compact) act('view',currentView);document.body.classList.toggle('settings-view',value); $('settings').hidden = !value; $('content').hidden = value;
  hideScreenPreview(); updateMessageScroll();
  if (value) { fillSettings(); await act('compact', false);await act('view','settings'); const result = await act('sources'); if (result.ok) setOptions($('microphone'), [['', 'System default microphone'], ...result.value.microphones.map(d => [d.id, d.name])], state.microphone); }
}
$('compact-toggle').onclick = () => { settings(false); act('compact', !state.compact); };
for (const button of document.querySelectorAll('[data-view]')) button.onclick = () => { settings(false); showView(button.dataset.view); };
$('more-toggle').onclick=()=>act('more');
$('mode-toggle').onclick=()=>act('choose-mode');
$('view-back').onclick=()=>{settings(false);showView('chat');};
$('model-toggle').onclick = () => act('choose-model');
$('provider-toggle').onclick = () => act('choose-provider');
$('provider').onchange = () => act('provider',$('provider').value);
$('claude-setup').onclick = () => act('claude-setup');
$('claude-login').onclick = () => act('claude-login');
$('privacy-toggle').onclick = () => act('toggle-privacy');
$('settings-close').onclick = () => {settings(false);showView('chat');};
$('ask-form').onsubmit = event => {event.preventDefault();return submit('assist');};
$('question').onpointerdown=()=>{if(state?.preferences?.contentProtection && state?.preferences?.noFocusWhenPrivate)act('type-question');};
$('question').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('ask-form').requestSubmit(); } };
for (const id of ['image', 'stop', 'dismiss-error', 'minimize', 'hide', 'export', 'permissions', 'microphone-permission']) $(id).onclick = () => act(id);
$('listen').onclick = () => act('listen');
$('reconnect').onclick = () => act('connect');
$('refresh-apps').onclick = async () => {
  $('refresh-apps').disabled = true;
  const result = await act('applications');
  if (result.ok) setOptions($('audio-source'), [['', 'All applications'], ...result.value.applications.sort((a, b) => a.name.localeCompare(b.name)).map(a => [String(a.pid), a.name])], state.audioPid);
  $('refresh-apps').disabled = false;
};
for (const id of ['model', 'effort', 'microphone', 'audio-source']) $(id).onchange = () => act('settings', { model: $('model').value, effort: $('effort').value, microphone: $('microphone').value, audioPid: $('audio-source').value });
$('history-list').onclick = async event => { const row = event.target.closest('[data-session]'); if (row) { const r = await act('session', row.dataset.session); if (r.ok) showView('chat'); } };
$('messages').onclick = async event => {
  if(event.target.closest('[data-retry]')) {await act('retry');return;}
  const screen = event.target.closest('[data-screen]');
  if(screen) { showScreenPreview(screen); return; }
  const button = event.target.closest('[data-copy]');
  if (button) {
    await navigator.clipboard.writeText(state.session.messages[Number(button.dataset.copy)].text);
    button.innerHTML = copiedIcon; button.title = 'Copied'; button.setAttribute('aria-label','Response copied');
    setTimeout(()=>{if(button.isConnected){button.innerHTML=copyIcon;button.title='Copy response';button.setAttribute('aria-label','Copy response');}},2000);
  }
};
function hideScreenPreview() { $('screen-preview').hidden = true; }
function showScreenPreview(button) {
  const image = messageImages(state?.session.messages[Number(button.dataset.screen)])[Number(button.dataset.imageIndex)||0]?.preview;
  if(!image) return;
  const preview = $('screen-preview');
  preview.querySelector('img').src = image; preview.hidden = false;
  const position = () => {
    const bounds = button.getBoundingClientRect(), height = preview.offsetHeight;
    preview.style.left = `${Math.max(8,Math.min(bounds.left,window.innerWidth-preview.offsetWidth-8))}px`;
    preview.style.top = `${Math.max(8,Math.min(bounds.bottom+8,window.innerHeight-height-8))}px`;
  };
  preview.querySelector('img').onload = position; position();
}
$('messages').addEventListener('pointerover',event=>{const button=event.target.closest('[data-screen]');if(button)showScreenPreview(button);});
$('messages').addEventListener('pointerout',event=>{if(event.target.closest('[data-screen]')&&!event.relatedTarget?.closest?.('[data-screen]'))hideScreenPreview();});
$('messages').addEventListener('focusin',event=>{const button=event.target.closest('[data-screen]');if(button)showScreenPreview(button);});
$('messages').addEventListener('focusout',hideScreenPreview);
document.addEventListener('keydown',event=>{if(event.key==='Escape')hideScreenPreview();});
$('content').addEventListener('scroll',()=>{hideScreenPreview();updateMessageScroll();});
$('jump-latest').onclick = () => { pendingTurnAnchor=false;$('content').scrollTo({top:$('content').scrollHeight,behavior:'smooth'}); };
for (const button of document.querySelectorAll('[data-prompt]')) button.onclick = () => { $('question').value = button.dataset.prompt; saveDraft();$('question').focus(); if (button.dataset.prompt.includes('screen')) act('screen'); };
async function submit(kind='assist',extra={}) {
  if(state?.busy || state?.requesting) return;
  const text=['assist','screen','screen-transcript'].includes(kind)?$('question').value.trim():'';
  settings(false);showView('chat');
  const result=await act('ask',{kind,text,...extra});
  if(result.ok && ['assist','screen','screen-transcript'].includes(kind) && $('question').value.trim()===text) { $('question').value='';saveDraft(); }
}
for(const button of document.querySelectorAll('[data-action]')) button.onclick=()=>submit(button.dataset.action);
$('screen').onclick=()=>act('screen');
$('attachment').onclick=event=>{const button=event.target.closest('[data-remove-image]');if(button)act('remove-image',button.dataset.removeImage);};
$('manual-screen').onclick=()=>act('screen');
$('end-session').onclick=()=>act('end-session');
$('history-search').oninput=()=>render(state);
$('rename-session').onclick=()=>act('rename-session',$('session-title').value);
$('copy-transcript').onclick=()=>navigator.clipboard.writeText(state.session.transcript.map(t=>`${t.source}: ${t.text}`).join('\n'));
$('transcript-lines').onclick=event=>{const line=event.target.closest('[data-transcript]');if(line)submit('latest',{text:'Answer or explain the selected transcript entry.',transcriptIndex:Number(line.dataset.transcript)});};
function formatDuration(ms){const seconds=Math.max(0,Math.floor(ms/1000));return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;}
function renderModes(s){
  if(!s.modes)return;
  setOptions($('mode-select'),s.modes.map(m=>[m.id,m.name]),s.modeId);
  const m=s.modes.find(m=>m.id===s.modeId)||s.modes[0];
  if(modeEditorId!==m.id){$('mode-name').value=m.name;$('mode-instructions').value=m.instructions;$('mode-context').value=m.context;$('mode-notes-template').value=m.notesTemplate;modeEditorId=m.id;}
  $('context-files').innerHTML=(m.files||[]).map(f=>`<div class="file-row"><span>${escape(f.name)}<small>${f.text.length.toLocaleString()} characters</small></span><button data-remove-file="${f.id}">Remove</button></div>`).join('');
}
$('mode-select').onchange=()=>act('mode',$('mode-select').value);
$('new-mode').onclick=()=>act('new-mode');
$('save-mode').onclick=async()=>{await act('save-mode',{id:state.modeId,name:$('mode-name').value,instructions:$('mode-instructions').value,context:$('mode-context').value,notesTemplate:$('mode-notes-template').value});};
$('import-context').onclick=()=>act('import-context');
$('context-files').onclick=event=>{const b=event.target.closest('[data-remove-file]');if(b)act('remove-context',b.dataset.removeFile);};
function renderNotes(s){$('notes-content').innerHTML=s.session.notes?markdown(s.session.notes):'<p class="hint">Generate notes from your transcript, or end the session to create them automatically.</p>';if(document.activeElement!==$('session-title'))$('session-title').value=s.session.title;}
$('copy-notes').onclick=()=>navigator.clipboard.writeText(state.session.notes||'');
$('edit-notes').onclick=()=>{$('notes-editor').hidden=false;$('notes-text').value=state.session.notes||'';};
$('save-notes').onclick=async()=>{await act('save-notes',$('notes-text').value);$('notes-editor').hidden=true;};
function renderPrivacyStatus(){const p=state.privacyStatus;$('privacy-status').textContent=p?`Capture exclusion requested: ${p.contentProtection?'yes':'no'} · Dock: ${p.dockVisible?'visible':'hidden'} · Mission Control: ${p.hiddenInMissionControl?'hidden':'visible'} · Keyboard: ${p.keyboardFocus?'enabled':'shortcuts only'}`:'';}
function fillSettings(){
  renderPrivacyStatus();
  const p=state.preferences||{};
  for(const [id,key] of Object.entries({'screen-use':'screenUse','smart':'smart','auto-notes':'autoNotes','content-protection':'contentProtection','no-focus':'noFocusWhenPrivate','request-details':'showRequestDetails'}))$(id).checked=!!p[key];
  $('language').value=p.language||'Auto';$('base-instructions').value=p.baseInstructions||'';
  $('permission-status').textContent=`Microphone: ${state.permissions?.microphone||'unknown'} · Screen: ${state.permissions?.screen||'unknown'}`;
  $('shortcut-fields').innerHTML=Object.entries(p.shortcuts||{}).map(([key,value])=>`<label>${escape(key)}<input data-shortcut="${key}" value="${escape(value)}"></label>`).join('');
}
for(const [id,key] of Object.entries({'screen-use':'screenUse','smart':'smart','auto-notes':'autoNotes','content-protection':'contentProtection','no-focus':'noFocusWhenPrivate','request-details':'showRequestDetails'}))$(id).onchange=()=>act('preferences',{[key]:$(id).checked});
$('language').onchange=()=>act('preferences',{language:$('language').value});
$('save-base').onclick=()=>act('preferences',{baseInstructions:$('base-instructions').value});
$('save-shortcuts').onclick=()=>act('preferences',{shortcuts:Object.fromEntries([...document.querySelectorAll('[data-shortcut]')].map(el=>[el.dataset.shortcut,el.value.trim()]))});
window.companion.onCommand?.(command=>{if(command==='focus-question'){$('question').focus();return;}if(command==='screen'){act('screen');return;}if(['assist','latest','screen-transcript'].includes(command))submit(command==='assist'?'latest':command);});
window.companion.onNavigate?.(async view=>{if(view==='settings'){await settings(true);return;}settings(false);if(view!=='new')await act('compact',false);showView(view==='new'?'chat':view);});
window.companion.onScroll?.(delta=>$('content').scrollBy({top:delta,behavior:'smooth'}));
window.companion.onState(render);
if(typeof ResizeObserver === 'function') {
  const answerResize = new ResizeObserver(layoutLatestTurn);
  answerResize.observe($('messages')); answerResize.observe($('content'));
}
$('messages').addEventListener('load',layoutLatestTurn,true);
const lastHeard = { Me: 0, Computer: 0 };
function updateCaptureStatus() {
  if (!state) return;
  const heard = Object.entries(lastHeard).filter(([, at]) => Date.now() - at < 1800).map(([source]) => source === 'Me' ? 'microphone' : 'computer audio');
  $('capture-status').textContent = state.audioBusy ? state.audioStatus : state.pendingAudio ? `Transcribing ${state.pendingAudio} audio segment${state.pendingAudio === 1 ? '' : 's'}…` : state.listening ? (heard.length ? `Hearing ${heard.join(' + ')}…` : 'Listening · waiting for speech…') : state.session?.transcript.length ? `Listening stopped · ${state.session.transcript.length} segments` : 'Start listening to see your live transcript.';
  $('listen').title=state.listening?'Listening · '+formatDuration((state.session.listenedMs||0)+Date.now()-(state.captureStartedAt||Date.now()))+' · click to pause':'Listen · Control–Option–L';
}
window.companion.onLevel(value => { $(value.source === 'Me' ? 'me-meter' : 'pc-meter').value = value.value; if (value.value > .032) lastHeard[value.source] = Date.now(); updateCaptureStatus(); });
window.companion.snapshot().then(s => { if (s.session) render(s); });
