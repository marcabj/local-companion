const { app, BrowserWindow, ipcMain, globalShortcut, Menu, Tray, desktopCapturer, screen, dialog, nativeImage, shell, systemPreferences } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { ProviderClient, PROVIDERS, providerName, routeState, routeRequest } = require('./providers.cjs');
const { findClaude } = require('./claude.cjs');
const { AudioPipeline } = require('./audio.cjs');
const { BASE_INSTRUCTIONS, LEGACY_BASE_INSTRUCTIONS, TRANSCRIBE_INSTRUCTIONS, ACTIONS, defaultModes, upgradeModes, buildRequest } = require('./prompts.cjs');
const { WindowPrivacy } = require('./privacy.cjs');
const { InputDiagnostics } = require('./input-diagnostics.cjs');
const { WindowMovement, heldChord } = require('./window-movement.cjs');
const runFile = promisify(execFile);

// Keep shortcut positions stable across keyboard layouts (quote = CSA è, backslash = CSA à).
app.commandLine.appendSwitch('disable-features', 'LayoutAwareGlobalHotkeys');
app.setName('Local Companion');
app.setPath('userData', process.env.COMPANION_DATA_DIR || path.join(app.getPath('appData'), 'Local Companion'));
const root = path.join(__dirname, '..');
const project = app.isPackaged ? require('../runtime.json').project : root;
const dataDir = process.env.COMPANION_DATA_DIR || app.getPath('userData');
const captureBinary = app.isPackaged ? path.join(process.resourcesPath, 'CompanionCapture') : path.join(root, '.build/CompanionCapture');
let win, dashboard, codex, audio, connecting, activeId, audioSessionId, privacy, tray, inputDiagnostics, movement;
let sessions = [];
let models = [];
let selectedProvider = 'codex', providerSelections = {};
const backendName = () => providerName(selectedProvider);
let connectionAuth = '';
const connectionStatus = () => `${backendName()} ${connected?'connected':'disconnected'}${connected && selectedProvider==='claude' && /api|third_party/.test(connectionAuth)?' · API billing':''}`;
let status = 'Connecting to Codex…';
let connected = false, busy = false, audioBusy = false, listening = false;
let selectedServiceTier = 'default';
let selectedModel = '', selectedEffort = 'low', capturing = false, problem = '';
let microphone = '', audioPid = '';
let audioStatus = 'Local Parakeet';
let saveTimer, renderTimer, transcription = null;
let compact = true, quitting = false, requesting = false, captureStartedAt = null;
const DEFAULT_SHORTCUTS = {focus:'Control+Alt+P',assist:'Control+Alt+Return', visibility:'Control+Alt+Space', listen:'Control+Alt+L', screenshot:"Control+Alt+'",screenTranscript:'Control+Alt+\\', transcribeMode:'Control+Alt+T', new:'Control+Alt+N', moveUp:'Command+Up',moveDown:'Command+Down',moveLeft:'Command+Left',moveRight:'Command+Right',scrollUp:'Control+Alt+Shift+Up',scrollDown:'Control+Alt+Shift+Down'};
let preferences = {conversationVersion:2,screenUse:false,transcribeMode:false,smart:false,language:'Auto',autoNotes:true,contentProtection:false,noFocusWhenPrivate:false,baseInstructions:BASE_INSTRUCTIONS,shortcuts:{...DEFAULT_SHORTCUTS}};
let modes = defaultModes(), modeId = 'general';
// The user's context library: files and pasted text, sent with each chat only when ticked.
let contextItems = [];
const CONTEXT_LIMIT = 200000;
const BUILTIN_MODE_IDS = defaultModes().map(m=>m.id);
const enabledContext = () => contextItems.filter(c=>c.enabled);
const contextChars = items => items.reduce((n,c)=>n+c.text.length,0);
const currentMode = () => modes.find(m=>m.id===modeId) || modes[0];
const active = () => sessions.find(s => s.id === activeId);
const isFreshChat = () => { const s=active();return s && !s.messages.length && !s.transcript.length && !s.threadId && !s.notes; };
function newSession() { const s = { id: randomUUID(), title: 'New conversation', createdAt: Date.now(), messages: [], transcript: [], threadId: null, conversationVersion:2, attachments:[], sentTranscriptKeys:[], modeId, notes:'', listenedMs:0 }; sessions.unshift(s); activeId = s.id; return s; }
function snapshot() {
  return { selectedProvider, providers:PROVIDERS, contextItems:contextItems.map(({text,...item})=>item), contextChars:contextChars(enabledContext()), contextLimit:CONTEXT_LIMIT, builtinModeIds:BUILTIN_MODE_IDS, connecting:!!connecting, privacyStatus:privacy?.state(), preferences, modes, modeId, requesting, capturing, captureStartedAt, permissions:{microphone:systemPreferences.getMediaAccessStatus('microphone'),screen:systemPreferences.getMediaAccessStatus('screen')}, compact, status, connected, busy, transcribing:!!transcription, audioBusy, listening, audioStatus, pendingAudio: audio?.pending.size || 0, problem, selectedModel, selectedEffort, selectedServiceTier, models, microphone, audioPid, attachments: (active()?.attachments || []).map(({id,preview,name})=>({id,preview,name})), session: active(), sessions: sessions.map(({ id, title, createdAt, notes, transcript, messages }) => ({ id, title, createdAt, hasNotes:!!notes, searchText:[title,notes,...transcript.map(t=>t.text),...messages.map(m=>m.text)].join(' ').toLowerCase() })) };
}
function update() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; const state = snapshot(); for (const target of [win, dashboard]) if (target && !target.isDestroyed() && (target === win || target.isVisible())) target.webContents.send('state', state); }, 25);
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void writeState(), 200);
}
let writeChain = Promise.resolve();
function writeState() {
  providerSelections[selectedProvider] = { selectedModel, selectedEffort, selectedServiceTier };
  const content = JSON.stringify({ sessions, selectedProvider, providerSelections, selectedModel, selectedEffort, selectedServiceTier, microphone, audioPid, preferences, modes, modeId, contextItems });
  writeChain = writeChain.then(async () => { const tmp = path.join(dataDir, 'history.tmp'); await fs.writeFile(tmp, content, { mode: 0o600 }); await fs.rename(tmp, path.join(dataDir, 'history.json')); }).catch(e => report(`Could not save history: ${e.message}`));
  return writeChain;
}
function report(text) { problem = /TCC|declined.*capture/i.test(text) ? 'Enable Local Companion in System Settings → Privacy & Security → Screen & System Audio Recording, then reopen the app.' : text; if (win && compact) setCompact(true); update(); }
function showWindow(options) {hideDashboard();if(privacy)privacy.show(options);else {win.show();if(options?.focus!==false)win.focus();}}
function toggleWindow() {if(!win.isVisible())hideDashboard();if(privacy)privacy.toggle();else showWindow();}
function applyPrivacy() {privacy?.apply(preferences);if(dashboard && !dashboard.isDestroyed()) {dashboard.setContentProtection(!!preferences.contentProtection);if(process.platform==='darwin')dashboard.setHiddenInMissionControl(!!preferences.contentProtection);}}
// The Dashboard is where you set up the companion; it and the floating panel are never shown together.
function createDashboard() {
  const window = new BrowserWindow({ show:false, width:920, height:670, minWidth:760, minHeight:560, title:'Local Companion', titleBarStyle:'hiddenInset', trafficLightPosition:{x:16,y:14}, backgroundColor:'#090C0D', fullscreenable:false, webPreferences:{ preload:path.join(__dirname,'preload.cjs'), contextIsolation:true, nodeIntegration:false, sandbox:true } });
  window.on('close', event => { if (quitting) return; event.preventDefault(); void action('start').catch(e => report(e.message)); });
  window.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { if (url !== window.webContents.getURL()) event.preventDefault(); });
  return window;
}
function openDashboard(page) {
  if (!dashboard || dashboard.isDestroyed()) return;
  if (page) dashboard.webContents.send('navigate', page);
  win.hide(); dashboard.show();
  if (process.platform === 'darwin') app.focus({ steal: true });
  dashboard.focus(); update();
}
function hideDashboard() { if (dashboard && !dashboard.isDestroyed() && dashboard.isVisible()) dashboard.hide(); }
const dialogParent = () => dashboard && !dashboard.isDestroyed() && dashboard.isVisible() ? dashboard : win;
async function extractDocument(file) {
  const output=await runFile(path.join(project,'.venv/bin/python'),[path.join(root,'scripts/extract_document.py'),file],{timeout:30000,maxBuffer:2000000});
  return JSON.parse(output.stdout);
}
// Files stay linked to their path; edited files are re-read when the companion starts.
async function refreshContext() {
  for (const item of contextItems) {
    if (item.kind !== 'file') continue;
    try {
      const { mtimeMs } = await fs.stat(item.path);
      item.missing = false;
      if (mtimeMs === item.mtimeMs) continue;
      const doc = await extractDocument(item.path);
      Object.assign(item, { text: doc.text, chars: doc.text.length, mtimeMs, updatedAt: Date.now() });
    } catch (e) {
      if (e.code === 'ENOENT') item.missing = true;
      else report(`Could not reload ${item.name}: ${e.message}`);
    }
  }
  save(); update();
}
function contextSummary() {
  if (modeId === 'plain') return 'Plain: no instructions or context';
  const names = enabledContext().map(c => c.name);
  return names.length ? `Context: ${names.join(', ')}`.slice(0, 80) : 'No context selected';
}
function updateTray() {
  if(!tray)return;
  const invoke=(name,payload)=>()=>action(name,payload).catch(e=>report(e.message));
  tray.setContextMenu(Menu.buildFromTemplate([
    {label:'Open Dashboard',click:()=>openDashboard()},
    {label:'Show / hide companion',click:toggleWindow},
    {label:'Type a question…',click:invoke('type-question')},
    {type:'separator'},
    {label:'Privacy mode',type:'checkbox',checked:preferences.contentProtection,click:item=>action('preferences',{contentProtection:item.checked}).catch(e=>report(e.message))},
    {label:'Keep focus in other apps',type:'checkbox',checked:preferences.noFocusWhenPrivate,enabled:preferences.contentProtection,click:item=>action('preferences',{noFocusWhenPrivate:item.checked}).catch(e=>report(e.message))},
    {type:'separator'},{role:'quit'},
  ]));
}
function setCompact(value) { compact = value; win.setSize(690, value ? 104 + (active()?.attachments?.length ? 66 : 0) + (problem ? 72 : 0) : 500, true); update(); }
async function connect() {
  if (connecting) return connecting;
  if (busy) throw new Error('Stop the current answer before reconnecting.');
  connecting = (async () => {
    problem = ''; status = `Connecting to ${backendName()}…`; connected = false; connectionAuth='';models = []; update();
    try {
      const result = await codex.connect(selectedProvider); models = result.models;
      if (!models.some(m => m.model === selectedModel)) selectedModel = models.find(m => m.isDefault)?.model || models[0]?.model;
      const model = models.find(m => m.model === selectedModel);
      selectedServiceTier=normalizeServiceTier(model,selectedServiceTier);
      if (!model?.supportedReasoningEfforts?.some(e => e.reasoningEffort === selectedEffort)) selectedEffort = model?.defaultReasoningEffort || 'low';
      connected = true;connectionAuth=result.auth || '';status = connectionStatus(); save();
    } catch (e) { status = `${backendName()} disconnected`; report(e.message); }
    finally { connecting = null; update(); }
  })();
  return connecting;
}
async function captureScreen(forRequest = false) {
  if (capturing || (requesting && !forRequest)) throw new Error('Wait for the current capture or send.');
  capturing=true;update();
  let visible=false, focused=false;
  try {
    visible=win.isVisible(); focused=win.isFocused();
    const display = screen.getDisplayMatching(win.getBounds());
    const scale = Math.min(1, 1920 / Math.max(display.size.width, display.size.height));
    win.hide();
    await new Promise(r => setTimeout(r, 180));
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) } });
    const source = sources.find(s => s.display_id === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) throw new Error('Enable Local Companion under System Settings → Privacy & Security → Screen & System Audio Recording, then reopen the app.');
    await setAttachment(source.thumbnail.toPNG(), 'Screen');
  } finally {capturing=false;update();if (visible) showWindow({focus:focused}); }
}
async function setAttachment(bytes, name) {
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error('Choose a PNG or JPEG image.');
  const target = path.join(dataDir, 'images', randomUUID() + '.png');
  await fs.writeFile(target, image.toPNG(), { mode: 0o600 });
  active().attachments ||= [];
  active().attachments.push({id:randomUUID(),path:target,preview:image.resize({width:320}).toDataURL(),name});
  save();
  if (compact) setCompact(true);
  update();
}
async function ask(input = {}) {
  const request=typeof input==='string'?{text:input}:input || {};
  const s=active(), retry=request.retry?s.lastPreparedRequest:null;
  const kind=retry?.kind || request.kind || 'assist';
  if(!Object.hasOwn(ACTIONS,kind)) throw new Error('Unknown answer action.');
  if(!connected) throw new Error(`Connect to ${backendName()} first.`);
  if(busy || requesting || capturing) throw new Error('Stop the current answer or wait for capture before sending.');
  requesting=true;problem='';update();
  try {
    let prepared=retry;
    if(!prepared) {
      if(audioBusy) throw new Error('Audio is starting. Wait until Listening appears.');
      if(listening || audio.pending.size) {status='Finishing the transcript…';update();await audio.flush();}
      const takeScreen=['screen','screen-transcript'].includes(kind) || (kind==='assist' && preferences.screenUse && !request.screenText && (request.text||'').trim() && !s.attachments?.length);
      if(takeScreen) await captureScreen(true);
      const images=kind==='latest' || ['notes','recap','email'].includes(kind)?[]:[...(s.attachments||[])];
      const built=buildRequest({...request,kind,session:s,mode:currentMode(),preferences,context:enabledContext(),hasImage:images.length>0});
      if(!built.prompt.trim() && !images.length) throw new Error('Type a message, attach images or use Listen to add new speech.');
      prepared={...built,kind,images,historyEnd:s.messages.length};
    }
    const model=models.find(m=>m.model===selectedModel);
    if(prepared.images.length && model?.inputModalities && !model.inputModalities.includes('image')) throw new Error('Choose an image-capable model.');
    const routed=routeRequest(s,selectedProvider,prepared);
    busy=true;setCompact(false);showWindow();win.webContents.send('navigate','chat');s.modeId=modeId;
    if(!s.messages.length && s.title==='New conversation') s.title=prepared.label.slice(0,65);
    s.messages.push({role:'user',text:prepared.label,images:prepared.images,context:prepared.context,prompt:prepared.prompt});
    const answer={role:'assistant',text:'',state:'working',kind,provider:selectedProvider,model:selectedModel};s.messages.push(answer);s.currentAnswer=s.messages.length-1;
    s.lastPreparedRequest=prepared;update();save();
    try {
      const result=await codex.ask({...routed,model:selectedModel,serviceTier:selectedServiceTier,effort:preferences.smart?smartEffort(model):selectedEffort,smart:preferences.smart,instructions:prepared.instructions});
      const route=routeState(s,selectedProvider);route.through=s.messages.length;
      if(result?.threadId) {route.threadId=result.threadId;if(selectedProvider==='codex')s.threadId=result.threadId;}
      const sent=new Set(prepared.images.map(i=>i.id));s.attachments=(s.attachments||[]).filter(i=>!sent.has(i.id));
      s.sentTranscriptKeys=[...new Set([...(s.sentTranscriptKeys||[]),...prepared.transcriptKeys])];
    } catch(e) {busy=false;answer.state='failed';answer.error=e.message;throw e;}
  } finally {requesting=false;status=connectionStatus();update();save();}
}
// In Transcribe mode, Send transcribes the queued images in a separate hidden request, then sends the transcription in their place with the typed text and new speech.
const shouldTranscribe = request => preferences.transcribeMode && !request?.retry && (request?.kind || 'assist')==='assist' && !!active().attachments?.length;
async function transcribeAndSend(request) {
  if(!connected) throw new Error(`Connect to ${backendName()} first.`);
  if(busy || requesting || capturing || audioBusy) throw new Error('Stop the current answer or wait for capture before transcribing.');
  const model=models.find(m=>m.model===selectedModel);
  if(model?.inputModalities && !model.inputModalities.includes('image')) throw new Error('Choose an image-capable model.');
  requesting=true;problem='';update();
  let text;
  try {
    const source=active(), images=[...source.attachments];
    const done=new Promise(resolve=>{transcription={text:'',resolve};});
    busy=true;status='Transcribing screenshots…';update();
    try {
      const effort=model?.supportedReasoningEfforts?.some(e=>e.reasoningEffort==='low')?'low':selectedEffort;
      await codex.ask({threadId:null,text:'Transcribe the attached screenshots.',images:images.map(i=>i.path),model:selectedModel,serviceTier:selectedServiceTier,effort,smart:false,instructions:TRANSCRIBE_INSTRUCTIONS});
    } catch(e) {transcription=null;busy=false;throw e;}
    const result=await done;
    if(result.status!=='completed') throw new Error(result.status==='interrupted'?'Screen transcription stopped.':result.error || `${backendName()} could not transcribe the screen.`);
    text=result.text.trim();
    if(!text) throw new Error('No text was found on the screen.');
    const sent=new Set(images.map(i=>i.id));source.attachments=source.attachments.filter(i=>!sent.has(i.id));
    for(const image of images) if(!sessions.some(s=>s.messages.some(m=>m.images?.some(i=>i.path===image.path)))) await fs.rm(image.path,{force:true});
  } finally {requesting=false;status=connectionStatus();update();save();}
  await ask({...request,kind:'assist',screenText:text});
}
function normalizeServiceTier(model,tier) {return model?.serviceTiers?.some(t=>t.id===tier)?tier:'default';}
function smartEffort(model) { const available=model?.supportedReasoningEfforts?.map(e=>e.reasoningEffort)||[]; return available.includes('high')?'high':selectedEffort; }
async function registerShortcuts(next) {
  const handlers={
    focus:()=>action('type-question'),assist:()=>win.webContents.send('command','assist'),visibility:toggleWindow,
    listen:()=>action('listen'),screenshot:()=>win.webContents.send('command','screen'),screenTranscript:()=>win.webContents.send('command','screen-transcript'),transcribeMode:()=>action('preferences',{transcribeMode:!preferences.transcribeMode}),new:()=>action('new'),
    ...Object.fromEntries(['Up','Down','Left','Right'].map(direction=>['move'+direction,()=>move(...({Up:[0,-80],Down:[0,80],Left:[-80,0],Right:[80,0]}[direction]))])),
    scrollUp:()=>win.webContents.send('scroll',-240),scrollDown:()=>win.webContents.send('scroll',240),
  };
  const values=Object.values(next).filter(Boolean);
  if (new Set(values.map(v=>v.toLowerCase())).size!==values.length) throw new Error('Each shortcut must be unique.');
  globalShortcut.unregisterAll();
  if(movement)await movement.configure(next);
  for(const [name,accelerator] of Object.entries(next)) {
    if(!accelerator || !handlers[name] || (movement && name.startsWith('move') && heldChord(accelerator))) continue;
    let registered=false;
    try { registered=globalShortcut.register(accelerator,()=>Promise.resolve().then(handlers[name]).catch(e=>report(e.message))); } catch {}
    if(!registered) { globalShortcut.unregisterAll(); throw new Error(`Shortcut ${accelerator} is unavailable. Choose another combination.`); }
  }
}
function move(dx,dy) {const b=win.getBounds(),area=screen.getDisplayMatching(b).workArea;win.setPosition(Math.max(area.x,Math.min(area.x+area.width-b.width,b.x+dx)),Math.max(area.y,Math.min(area.y+area.height-b.height,b.y+dy)));}

function bindEvents() {
  codex.on('diagnostic', text => { void fs.writeFile(path.join(dataDir, 'connection-diagnostic.log'), text, { mode: 0o600 }); });
  codex.on('cancelError', report);
  codex.on('notice', report);
  codex.on('thread', id => { if (transcription) return; const s=active();routeState(s,selectedProvider).threadId=id;if(selectedProvider==='codex')s.threadId=id; save(); });
  codex.on('delta', text => { if (transcription) { transcription.text += text; return; } const s = active(); const a = s.messages[s.currentAnswer]; if (a) { a.text += text; update(); } });
  codex.on('message', item => { if (transcription) { if (!transcription.text) transcription.text = item.text || ''; return; } const s = active(); const a = s.messages[s.currentAnswer]; if (a && !a.text) a.text = item.text || ''; update(); });
  codex.on('completed', turn => {
    busy = false;
    if (transcription) { const t = transcription; transcription = null; t.resolve({ status: turn?.status || 'failed', error: turn?.error?.message, text: t.text }); update(); return; }
    const s = active(); const a = s.messages[s.currentAnswer];
    if (a) { a.state = turn?.status || 'failed'; if (turn?.error) a.error = turn.error.message || `${backendName()} could not complete this answer.`; }
    if (a?.kind === 'notes' && turn?.status === 'completed') { s.notes=a.text; s.notesAt=Date.now(); win.webContents.send('navigate','notes'); }
    if (turn?.status === 'failed') report(a?.error || `${backendName()} could not complete this answer.`);
    update(); save();
  });
  codex.on('disconnected', message => {
    connected = false; status = `${backendName()} disconnected`;
    if (transcription) { const t = transcription; transcription = null; busy = false; t.resolve({ status: 'failed', error: message, text: '' }); }
    if (busy) { busy = false; const s = active(); const a = s?.messages[s.currentAnswer]; if (a) { a.state = 'failed'; a.error = message; } save(); }
    update();
  });
  audio.on('status', value => { audioStatus = value; update(); });
  audio.on('pending', update);
  audio.on('listening', value => { if(value && !captureStartedAt) captureStartedAt=Date.now(); if(!value && captureStartedAt) {const s=active();s.listenedMs=(s.listenedMs||0)+Date.now()-captureStartedAt;captureStartedAt=null;save();} listening = value; audioBusy = false; audioStatus = value ? 'Listening · local Parakeet' : 'Local Parakeet'; update(); });
  audio.on('level', value => win?.webContents.send('level', value));
  audio.on('problem', value => { audioBusy = false; report(value); });
  audio.on('transcript', item => {
    const s = sessions.find(s => s.id === item.sessionId);
    if (s) { s.transcript.push({ id:randomUUID(), source: item.source, text: item.text, at: item.at, seconds: item.seconds }); s.transcript.sort((a, b) => a.at - b.at); save(); update(); }
  });
}
async function action(name, payload) {
  if(['toggle-privacy','type-question','open-settings','more','choose-model','choose-mode','compact','screen','new','listen','preferences'].includes(name))
    inputDiagnostics?.record('action',{action:name});
  switch (name) {
    case 'view': if(!compact)win.setSize(690,500,true);break;
    case 'compact': setCompact(Boolean(payload)); break;
    case 'toggle-window': toggleWindow(); break;
    case 'toggle-privacy':
      preferences.contentProtection = !preferences.contentProtection;
      applyPrivacy();updateTray();save();update();break;
    case 'connect': await connect(); break;
    case 'choose-provider': {
      const enabled=!busy && !requesting && !connecting;
      Menu.buildFromTemplate(PROVIDERS.map(p=>({label:p.name,type:'radio',checked:selectedProvider===p.id,enabled,click:()=>void action('provider',p.id).catch(e=>report(e.message))}))).popup({window:win});break;
    }
    case 'provider': {
      if(busy || requesting || connecting) throw new Error('Wait for the current answer or connection before switching providers.');
      if(!PROVIDERS.some(p=>p.id===payload)) throw new Error('Unknown answer provider.');
      if(payload===selectedProvider) {if(!connected)await connect();break;}
      providerSelections[selectedProvider]={selectedModel,selectedEffort,selectedServiceTier};
      selectedProvider=payload;
      ({selectedModel='',selectedEffort='low',selectedServiceTier='default'}=providerSelections[payload] || {});
      models=[];connected=false;save();update();await connect();break;
    }
    case 'claude-setup': {
      await shell.openExternal('https://code.claude.com/docs/en/quickstart');break;
    }
    case 'claude-login': {
      const command=findClaude();
      const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
      const script=path.join(dataDir,'claude-login.command');
      await fs.writeFile(script,`#!/bin/zsh\nexec ${quote(command)} auth login\n`,{mode:0o700});
      await runFile('/usr/bin/open',['-a','Terminal',script]);break;
    }
    case 'ask':
      if(shouldTranscribe(payload)) {await transcribeAndSend(payload);break;}
      await ask(payload); break;
    case 'more': {
      const navigate=view=>win.webContents.send('navigate',view);
      Menu.buildFromTemplate([
        ...(preferences.contentProtection && preferences.noFocusWhenPrivate?[{label:'Type a question…',click:()=>action('type-question').catch(e=>report(e.message))},{type:'separator'}]:[]),
        {label:'Quick Assist · screen + voice',enabled:connected && !busy && !requesting && !audioBusy,click:()=>win.webContents.send('command','screen-transcript')},
        {label:'Transcript',click:()=>navigate('transcript')},
        {label:'Notes',click:()=>navigate('notes')},
        {type:'separator'},
        {label:'New chat',enabled:!busy && !requesting && !audioBusy,click:()=>void action('new').catch(e=>report(e.message))},
        {label:'Dashboard…',click:()=>openDashboard()},
      ]).popup({window:win});break;
    }
    case 'choose-mode': {
      const preferred=['interview','behavioral','coding','assessment','system-design','case','recruiter','general','plain'];
      const entry=m=>({label:m.name,type:'radio',checked:modeId===m.id,enabled:!busy && !requesting,click:()=>void action('mode',m.id).catch(e=>report(e.message))});
      const primary=preferred.map(id=>modes.find(m=>m.id===id)).filter(Boolean);
      const others=modes.filter(m=>!preferred.includes(m.id));
      Menu.buildFromTemplate([...primary.map(entry),...(others.length?[{label:'Other modes',submenu:others.map(entry)}]:[]),{type:'separator'},{label:'Transcribe screenshots',type:'checkbox',checked:!!preferences.transcribeMode,enabled:!busy && !requesting,click:item=>void action('preferences',{transcribeMode:item.checked}).catch(e=>report(e.message))},{type:'separator'},{label:contextSummary(),enabled:false},{label:'Change mode & context…',click:()=>openDashboard('start')}]).popup({window:win});break;
    }
    case 'choose-model': {
      if(busy || requesting) throw new Error('Wait for the answer before changing models.');
      if(!models.length) throw new Error(`Connect to ${backendName()} to load your models.`);
      const model=models.find(m=>m.model===selectedModel);
      const choose=payload=>void action('answer-model',payload).catch(e=>report(e.message));
      Menu.buildFromTemplate([
        ...models.map(m=>({label:m.displayName || m.model,type:'radio',checked:m.model===selectedModel,click:()=>choose({model:m.model})})),
        {type:'separator'},
        {label:'Answer speed',submenu:[{label:'Standard',type:'radio',checked:selectedServiceTier==='default',click:()=>choose({serviceTier:'default'})},...(model?.serviceTiers||[]).filter(t=>t.id!=='default').map(t=>({label:`${t.name} · ${t.description || 'Faster answers'}${/usage/i.test(t.description||'')?'':' · increased usage'}`,type:'radio',checked:selectedServiceTier===t.id,click:()=>choose({serviceTier:t.id})}))]},
        ...(model?.supportedReasoningEfforts?.length?[{label:'Reasoning effort',submenu:model.supportedReasoningEfforts.map(e=>({label:e.reasoningEffort,type:'radio',checked:e.reasoningEffort===selectedEffort,click:()=>choose({effort:e.reasoningEffort})}))}]:[]),
      ]).popup({window:win});
      break;
    }
    case 'answer-model': {
      if(busy || requesting) throw new Error('Wait for the answer before changing models.');
      const model=models.find(m=>m.model===(payload.model || selectedModel));
      if(!model) throw new Error('Model is unavailable. Reconnect to refresh the list.');
      if(payload.serviceTier && payload.serviceTier!=='default' && !model.serviceTiers?.some(t=>t.id===payload.serviceTier)) throw new Error('This speed is not available for the selected model.');
      selectedModel=model.model;
      selectedServiceTier=normalizeServiceTier(model,payload.serviceTier || selectedServiceTier);
      const effort=payload.effort || selectedEffort;
      selectedEffort=model.supportedReasoningEfforts?.some(e=>e.reasoningEffort===effort)?effort:model.defaultReasoningEffort || 'low';
      save();update();break;
    }
    case 'retry': if(!active().lastPreparedRequest) throw new Error('Send a new message to continue this saved conversation.'); await ask({retry:true}); break;
    case 'end-session': {
      if(busy || requesting || audioBusy) throw new Error('Wait for the current operation before ending the session.');
      await audio.stop(); await audio.drain(); active().endedAt=Date.now(); save();
      if(preferences.autoNotes && active().transcript.length) await ask({kind:'notes'});
      break;
    }
    case 'type-question': {
      preferences.noFocusWhenPrivate=false;applyPrivacy();updateTray();save();update();showWindow();
      win.webContents.send('command','focus-question');break;
    }
    case 'open-settings': openDashboard('settings'); break;
    case 'open-dashboard': openDashboard(typeof payload==='string'?payload:undefined); break;
    case 'start': {
      if(payload?.newChat && !isFreshChat()) await action('new');
      await refreshContext();
      showWindow();
      if(!connected && !connecting) void connect();
      break;
    }
    case 'preferences': {
      if(busy || requesting) throw new Error('Wait for the answer before changing its settings.');
      const next={...preferences};
      for(const k of ['screenUse','transcribeMode','smart','autoNotes','contentProtection','noFocusWhenPrivate','showRequestDetails']) if(typeof payload[k]==='boolean') next[k]=payload[k];
      if(typeof payload.language==='string') next.language=payload.language.slice(0,60);
      if(typeof payload.baseInstructions==='string') next.baseInstructions=payload.baseInstructions.trim() || BASE_INSTRUCTIONS;
      if(payload.shortcuts) {
        next.shortcuts={...DEFAULT_SHORTCUTS,...payload.shortcuts};
        try { await registerShortcuts(next.shortcuts); } catch(e) {try{await registerShortcuts(preferences.shortcuts);}catch{} throw e;}
      }
      preferences=next;applyPrivacy();updateTray();save();update();break;
    }
    case 'mode': {
      if(busy || requesting) throw new Error('Wait for the answer before switching modes.');
      if(!modes.some(m=>m.id===payload)) throw new Error('Mode not found.');
      modeId=payload;active().modeId=modeId;save();update();break;
    }
    case 'save-mode': {
      if(busy || requesting) throw new Error('Wait for the answer before editing its mode.');
      const mode=modes.find(m=>m.id===payload.id);if(!mode) throw new Error('Mode not found.');
      if(mode.id==='plain') throw new Error('Plain mode adds nothing, so it has no instructions to edit.');
      for(const key of ['name','instructions','context','notesTemplate']) if(typeof payload[key]==='string') mode[key]=payload[key].slice(0,key==='name'?80:20000);
      if(!mode.name.trim()) mode.name='Custom mode';save();update();break;
    }
    case 'new-mode': {if(busy || requesting) throw new Error('Wait for the answer before switching modes.'); const mode={id:randomUUID(),name:'Custom mode',instructions:'',context:'',notesTemplate:'Summary\nDecisions\nAction items\nOpen questions',files:[]};modes.push(mode);modeId=mode.id;save();update();break;}
    case 'delete-mode': {
      if(busy || requesting) throw new Error('Wait for the answer before deleting a mode.');
      if(BUILTIN_MODE_IDS.includes(payload)) throw new Error('Built-in modes can be edited but not deleted.');
      modes=modes.filter(m=>m.id!==payload);if(modeId===payload)modeId='general';save();update();break;
    }
    case 'add-context-files': {
      const result=await dialog.showOpenDialog(dialogParent(),{properties:['openFile','multiSelections'],filters:[{name:'Documents',extensions:['pdf','docx','txt','md','csv','json']}]});
      if(!result.canceled) for(const file of result.filePaths) {
        const doc=await extractDocument(file);
        const {mtimeMs}=await fs.stat(file);
        const enabled=contextChars(enabledContext())+doc.text.length<=CONTEXT_LIMIT;
        contextItems.push({id:randomUUID(),kind:'file',name:doc.name,path:file,text:doc.text,chars:doc.text.length,mtimeMs,updatedAt:Date.now(),enabled});
        if(!enabled) report(`${doc.name} was added unticked: ticked context is limited to ${CONTEXT_LIMIT.toLocaleString()} characters.`);
        save();update();
      }break;
    }
    case 'add-context-text': {
      const text=String(payload?.text||'').trim();if(!text) throw new Error('Paste some text first.');
      if(text.length>100000) throw new Error('Text exceeds 100,000 characters. Add a focused excerpt.');
      const enabled=contextChars(enabledContext())+text.length<=CONTEXT_LIMIT;
      contextItems.push({id:randomUUID(),kind:'text',name:String(payload?.name||'').trim().slice(0,80)||'Notes',text,chars:text.length,updatedAt:Date.now(),enabled});
      if(!enabled) report(`Added unticked: ticked context is limited to ${CONTEXT_LIMIT.toLocaleString()} characters.`);
      save();update();break;
    }
    case 'update-context': {
      const item=contextItems.find(c=>c.id===payload?.id);if(!item) throw new Error('Context item not found.');
      if(typeof payload.name==='string' && payload.name.trim()) item.name=payload.name.trim().slice(0,80);
      if(typeof payload.text==='string' && item.kind==='text') {
        const text=payload.text.trim();if(!text) throw new Error('Text cannot be empty. Remove the item instead.');
        if(text.length>100000) throw new Error('Text exceeds 100,000 characters. Add a focused excerpt.');
        if(item.enabled && contextChars(enabledContext())-item.text.length+text.length>CONTEXT_LIMIT) throw new Error(`Ticked context is limited to ${CONTEXT_LIMIT.toLocaleString()} characters.`);
        Object.assign(item,{text,chars:text.length,updatedAt:Date.now()});
      }
      if(typeof payload.enabled==='boolean') {
        if(payload.enabled && !item.enabled && contextChars(enabledContext())+item.text.length>CONTEXT_LIMIT) throw new Error(`Ticked context is limited to ${CONTEXT_LIMIT.toLocaleString()} characters. Untick something first.`);
        item.enabled=payload.enabled;
      }
      save();update();break;
    }
    case 'context-text': return contextItems.find(c=>c.id===payload)?.text || '';
    case 'reload-context': await refreshContext(); break;
    case 'untick-all-context': for(const item of contextItems) item.enabled=false; save();update();break;
    case 'remove-context': {contextItems=contextItems.filter(c=>c.id!==payload);save();update();break;}
    case 'rename-session': {if(typeof payload==='string'&&payload.trim())active().title=payload.trim().slice(0,120);save();update();break;}
    case 'save-notes': {active().notes=String(payload);active().notesAt=Date.now();save();update();break;}
    case 'permissions': await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');break;
    case 'microphone-permission': await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');break;
    case 'stop': await codex.interrupt(); break;
    case 'screen': await captureScreen(); break;
    case 'remove-image': {
      if(requesting || capturing) throw new Error('Wait for the current capture or send.');
      const queue=active().attachments || [];const image=queue.find(i=>i.id===payload);
      active().attachments=queue.filter(i=>i!==image);
      if(image && !sessions.some(s=>s.messages.some(m=>m.images?.some(i=>i.path===image.path)))) await fs.rm(image.path,{force:true});
      if(compact)setCompact(true);save();update();break;
    }
    case 'image': {
      if(capturing || requesting) throw new Error('Wait for the current capture or send.');
      capturing=true;update();
      try {
        const result=await dialog.showOpenDialog(dialogParent(),{properties:['openFile','multiSelections'],filters:[{name:'Images',extensions:['png','jpg','jpeg']}]});
        if(!result.canceled) for(const file of result.filePaths) await setAttachment(await fs.readFile(file),path.basename(file));
      } finally {capturing=false;update();}
      break;
    }
    case 'new':
    case 'session': {
      if(name==='new' && isFreshChat()) return;
      if (busy || requesting || capturing || audioBusy || audio.pending.size) throw new Error('Wait for the current answer or pending transcription before switching sessions.');
      await audio.stop();
      if(name==='new' && isFreshChat()) return;
      if (name === 'new') newSession(); else if (sessions.some(s => s.id === payload)) {activeId = payload;modeId=active().modeId || modeId;}
      problem = ''; setCompact(name === 'new'); win.webContents.send('navigate',name==='new'?'new':'chat'); save(); update(); break;
    }
    case 'listen':
      if (audioBusy || requesting) break;
      audioBusy = true; problem = ''; update();
      try {
        if (listening) await audio.stop();
        else {
          delete active().endedAt;audioSessionId = activeId;
          // The visible, bundled app owns the permission prompt. A command-line
          // child must not wait on its own invisible AVFoundation prompt.
          const permission = systemPreferences.getMediaAccessStatus('microphone');
          if (permission !== 'granted') {
            audioStatus = 'Waiting for microphone permission…'; update();
            if (permission !== 'not-determined' || !await systemPreferences.askForMediaAccess('microphone')) throw new Error('Allow Local Companion in System Settings → Privacy & Security → Microphone, then reopen the app.');
          }
          audioStatus = 'Loading Parakeet…';
          await audio.start({ microphone, pid: audioPid, sessionId: activeId });
        }
      } finally { audioBusy = false; update(); }
      break;
    case 'settings': {
      if (busy || requesting || listening || audioBusy) throw new Error('Stop the answer and audio before changing settings.');
      if (payload.model && models.some(m => m.model === payload.model)) selectedModel = payload.model;
      const model = models.find(m => m.model === selectedModel);
      selectedServiceTier=normalizeServiceTier(model,selectedServiceTier);
      if (model?.supportedReasoningEfforts?.some(e => e.reasoningEffort === payload.effort)) selectedEffort = payload.effort;
      else selectedEffort = model?.defaultReasoningEffort || 'low';
      microphone = String(payload.microphone || ''); audioPid = String(payload.audioPid || ''); save(); update(); break;
    }
    case 'sources': {
      const devices = await runFile(captureBinary, ['--devices'], { timeout: 15000 });
      return JSON.parse(devices.stdout);
    }
    case 'applications': {
      const sources = await runFile(captureBinary, ['--sources'], { timeout: 30000 });
      return JSON.parse(sources.stdout);
    }
    case 'export': {
      const s = active(); const result = await dialog.showSaveDialog(dialogParent(), { defaultPath: `${s.title.replace(/[/\\:]/g, '-')}.txt` });
      if (!result.canceled) await fs.writeFile(result.filePath, s.messages.map(m => `${m.role.toUpperCase()}\n${m.text}`).join('\n\n') + '\n\nNOTES\n' + (s.notes||'') + '\n\nTRANSCRIPT\n' + s.transcript.map(t => `${t.source}: ${t.text}`).join('\n'));
      break;
    }
    case 'dismiss-error': problem = ''; if (compact) setCompact(true); update(); break;
    case 'minimize': win.minimize(); break;
    case 'hide': await audio.stop(); win.hide(); break;
    default: throw new Error('Unknown action.');
  }
  return snapshot();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if(win)openDashboard(); });
  app.whenReady().then(async () => {
    await fs.mkdir(path.join(dataDir, 'images'), { recursive: true });
    await fs.mkdir(path.join(dataDir, 'workspace'), { recursive: true });
    try {
      const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'history.json'), 'utf8'));
      preferences={...preferences,...saved.preferences,shortcuts:{...DEFAULT_SHORTCUTS,...saved.preferences?.shortcuts}};
      if(saved.preferences?.conversationVersion!==2) {preferences.screenUse=false;preferences.conversationVersion=2;}
      if(preferences.baseInstructions===LEGACY_BASE_INSTRUCTIONS) preferences.baseInstructions=BASE_INSTRUCTIONS; modes=saved.modes?.length?upgradeModes(saved.modes):modes;modeId=saved.modeId||'general';
      delete preferences.shortcuts.transcribeScreen; // replaced by the transcribeMode toggle
      for(const direction of ['Up','Down','Left','Right']) {
        if(preferences.shortcuts['move'+direction]==='Control+Alt+'+direction) preferences.shortcuts['move'+direction]='Command+'+direction;
      }
      contextItems = Array.isArray(saved.contextItems) ? saved.contextItems : [];
      // Earlier builds kept background and files inside each mode; move them into the library unticked.
      for(const mode of modes) {
        if(mode.context?.trim()) contextItems.push({id:randomUUID(),kind:'text',name:`${mode.name} background`,text:mode.context.trim(),chars:mode.context.trim().length,updatedAt:Date.now(),enabled:false});
        for(const file of mode.files||[]) contextItems.push({id:file.id||randomUUID(),kind:'text',name:file.name,text:file.text,chars:file.text.length,updatedAt:Date.now(),enabled:false});
        mode.context='';mode.files=[];
      }
      sessions = saved.sessions || [];
      for(const s of sessions) {
        if(s.conversationVersion!==2) {
          if(s.messages.findLast(m=>m.role==='assistant')?.kind==='latest' && s.transcriptThreadId) s.threadId=s.transcriptThreadId;
          s.conversationVersion=2;delete s.transcriptThreadId;
        }
        s.attachments ||= [];s.sentTranscriptKeys ||= [];
      } selectedProvider=PROVIDERS.some(p=>p.id===saved.selectedProvider)?saved.selectedProvider:'codex';providerSelections=saved.providerSelections || {};
      selectedModel = saved.selectedModel || ''; selectedEffort = saved.selectedEffort || 'low'; selectedServiceTier = saved.selectedServiceTier || 'default'; microphone = saved.microphone || '';
      for (const s of sessions) for (const m of s.messages) if (m.state === 'working') m.state = 'interrupted';
    } catch (e) { if (e.code !== 'ENOENT') problem = 'Could not load saved history. The existing file has been left in place.'; }
    if (!sessions.length) newSession(); else {activeId = sessions[0].id;modeId=active().modeId || modeId;}
    codex = new ProviderClient(path.join(dataDir, 'workspace'));
    audio = new AudioPipeline({ helper: captureBinary, python: path.join(project, '.venv/bin/python'), worker: path.join(root, 'scripts/transcribe.py'), directory: path.join(dataDir, 'audio-temp') });
    bindEvents();
    compact = active().messages.length === 0;
    win = new BrowserWindow({ show:false, ...(process.platform==='darwin'?{type:'panel'}:{}), acceptFirstMouse:true, fullscreenable:false, hiddenInMissionControl:preferences.contentProtection, skipTaskbar:preferences.contentProtection, width: 690, height: compact ? 104 : 500, minWidth: 690, maxWidth: 690, minHeight: 104, title: 'Local Companion', backgroundColor: '#00000000', transparent: true, frame: false, roundedCorners: true, hasShadow: false, alwaysOnTop: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    movement=new WindowMovement({helper:captureBinary,move,canMove:()=>!quitting && !win.isDestroyed() && win.isVisible(),onError:report});
    win.on('hide',()=>movement.stop());win.on('closed',()=>movement.stop());
    inputDiagnostics=new InputDiagnostics({win,ipcMain,directory:path.join(dataDir,'diagnostics'),
      getContext:()=>({busy,requesting,capturing,listening,audioBusy,private:preferences.contentProtection,noFocus:preferences.noFocusWhenPrivate})});
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.webContents.on('before-input-event', (event, input) => {
      if(movement.handleInput(input))event.preventDefault();
    });
    win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
    win.webContents.on('will-navigate', (event, url) => { if (url !== win.webContents.getURL()) event.preventDefault(); });
    await win.loadFile(path.join(__dirname, 'index.html'));
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Local Companion', submenu: [{ label: 'Dashboard…', accelerator: 'CmdOrCtrl+,', click: () => openDashboard() }, { label: 'Show / Hide', accelerator: 'Control+Alt+Space', click: toggleWindow }, { label: 'New conversation', accelerator: 'CmdOrCtrl+N', click: () => action('new').catch(e => report(e.message)) }, { type: 'separator' }, { role: 'quit' }] }, { role: 'editMenu' }, { role: 'windowMenu' }]));
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname,'trayTemplate.png')));
    tray.setToolTip('Local Companion');updateTray();
    privacy = new WindowPrivacy({app,win,onError:report,onChange:update});
    dashboard = createDashboard(); await dashboard.loadFile(path.join(__dirname, 'dashboard.html'));
    applyPrivacy();
    win.setAlwaysOnTop(true,'modal-panel');
    if (process.argv.includes('--ui-fixture')) showWindow(); else openDashboard();
    try {await registerShortcuts(preferences.shortcuts);}catch(e){report(e.message);}
    if (process.argv.includes('--ui-fixture')) {
      connected = true; status = 'Preview · sample conversation'; selectedModel = 'gpt-6.1-sol';
      models = [{ model: selectedModel, displayName: 'GPT-6.1 Sol', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }];
      const s = active(); s.messages = [{ role: 'user', text: 'How would you explain this project in an interview?' }, { role: 'assistant', state: 'completed', text: 'Start with the problem, then your contribution.\n\n**A useful structure**\n\n1. Explain what users needed.\n2. Describe the part you built.\n3. Give one concrete result.\n\nKeep the first answer to about a minute, then let the interviewer choose what to explore.' }]; update();
    } else void connect();
  }).catch(e => { dialog.showErrorBox('Local Companion', e.message); app.quit(); });
}
ipcMain.handle('snapshot', () => snapshot());
ipcMain.handle('save-draft', (_event, draft) => {
  if(typeof draft==='string' && active()) {active().draft=draft;save();}
});
ipcMain.handle('action', async (_event, name, payload) => { try { return { ok: true, value: await action(name, payload) }; } catch (e) { report(e.message); return { ok: false, error: e.message }; } });
app.on('activate', () => { if(win)openDashboard(); });
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true;
  clearTimeout(saveTimer); void movement?.dispose();privacy?.dispose();tray?.destroy();globalShortcut.unregisterAll(); audio?.close(); codex?.disconnect();
  void Promise.allSettled([writeState(),inputDiagnostics?.dispose()]).finally(() => app.quit());
});
app.on('window-all-closed', () => app.quit());
