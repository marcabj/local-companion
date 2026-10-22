const { app, BrowserWindow, ipcMain, globalShortcut, Menu, Tray, desktopCapturer, screen, dialog, nativeImage, shell, systemPreferences } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { CodexClient } = require('./codex.cjs');
const { AudioPipeline } = require('./audio.cjs');
const { BASE_INSTRUCTIONS, ACTIONS, defaultModes, upgradeModes, buildRequest } = require('./prompts.cjs');
const { WindowPrivacy } = require('./privacy.cjs');
const runFile = promisify(execFile);

// Keep shortcut positions stable across keyboard layouts (quote = CSA è, backslash = CSA à).
app.commandLine.appendSwitch('disable-features', 'LayoutAwareGlobalHotkeys');
app.setName('Local Companion');
app.setPath('userData', process.env.COMPANION_DATA_DIR || path.join(app.getPath('appData'), 'Local Companion'));
const root = path.join(__dirname, '..');
const project = app.isPackaged ? require('../runtime.json').project : root;
const dataDir = process.env.COMPANION_DATA_DIR || app.getPath('userData');
const captureBinary = app.isPackaged ? path.join(process.resourcesPath, 'CompanionCapture') : path.join(root, '.build/CompanionCapture');
let win, codex, audio, connecting, activeId, audioSessionId, privacy, tray;
let sessions = [];
let models = [];
let status = 'Connecting to Codex…';
let connected = false, busy = false, audioBusy = false, listening = false;
let selectedServiceTier = 'default';
let selectedModel = '', selectedEffort = 'low', attachment = null, problem = '';
let microphone = '', audioPid = '';
let audioStatus = 'Local Parakeet';
let saveTimer, renderTimer;
let compact = true, quitting = false, requesting = false, captureStartedAt = null;
const DEFAULT_SHORTCUTS = {focus:'Control+Alt+P',assist:'Control+Alt+Return', visibility:'Control+Alt+Space', listen:'Control+Alt+L', screenshot:"Control+Alt+'",screenTranscript:'Control+Alt+\\', new:'Control+Alt+N', moveUp:'Command+Up',moveDown:'Command+Down',moveLeft:'Command+Left',moveRight:'Command+Right',scrollUp:'Control+Alt+Shift+Up',scrollDown:'Control+Alt+Shift+Down'};
let preferences = {screenUse:true,smart:false,language:'Auto',autoNotes:true,contentProtection:false,noFocusWhenPrivate:false,baseInstructions:BASE_INSTRUCTIONS,shortcuts:{...DEFAULT_SHORTCUTS}};
let modes = defaultModes(), modeId = 'general';
const currentMode = () => modes.find(m=>m.id===modeId) || modes[0];
const active = () => sessions.find(s => s.id === activeId);
function newSession() { const s = { id: randomUUID(), title: 'New conversation', createdAt: Date.now(), messages: [], transcript: [], threadId: null, modeId, notes:'', listenedMs:0 }; sessions.unshift(s); activeId = s.id; return s; }
function snapshot() {
  return { privacyStatus:privacy?.state(), preferences, modes, modeId, requesting, captureStartedAt, permissions:{microphone:systemPreferences.getMediaAccessStatus('microphone'),screen:systemPreferences.getMediaAccessStatus('screen')}, compact, status, connected, busy, audioBusy, listening, audioStatus, pendingAudio: audio?.pending.size || 0, problem, selectedModel, selectedEffort, selectedServiceTier, models, microphone, audioPid, attachment: attachment && { preview: attachment.preview, name: attachment.name }, session: active(), sessions: sessions.map(({ id, title, createdAt, notes, transcript, messages }) => ({ id, title, createdAt, hasNotes:!!notes, searchText:[title,notes,...transcript.map(t=>t.text),...messages.map(m=>m.text)].join(' ').toLowerCase() })) };
}
function update() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; if (win && !win.isDestroyed()) win.webContents.send('state', snapshot()); }, 25);
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void writeState(), 200);
}
let writeChain = Promise.resolve();
function writeState() {
  const content = JSON.stringify({ sessions, selectedModel, selectedEffort, selectedServiceTier, microphone, audioPid, preferences, modes, modeId });
  writeChain = writeChain.then(async () => { const tmp = path.join(dataDir, 'history.tmp'); await fs.writeFile(tmp, content, { mode: 0o600 }); await fs.rename(tmp, path.join(dataDir, 'history.json')); }).catch(e => report(`Could not save history: ${e.message}`));
  return writeChain;
}
function report(text) { problem = /TCC|declined.*capture/i.test(text) ? 'Enable Local Companion in System Settings → Privacy & Security → Screen & System Audio Recording, then reopen the app.' : text; if (win && compact) setCompact(true); update(); }
function showWindow(options) {if(privacy)privacy.show(options);else {win.show();if(options?.focus!==false)win.focus();}}
function toggleWindow() {if(privacy)privacy.toggle();else showWindow();}
function updateTray() {
  if(!tray)return;
  const invoke=(name,payload)=>()=>action(name,payload).catch(e=>report(e.message));
  tray.setContextMenu(Menu.buildFromTemplate([
    {label:'Show / hide Local Companion',click:toggleWindow},
    {label:'Type a question…',click:invoke('type-question')},
    {label:'Settings',click:invoke('open-settings')},
    {type:'separator'},
    {label:'Privacy mode',type:'checkbox',checked:preferences.contentProtection,click:item=>action('preferences',{contentProtection:item.checked}).catch(e=>report(e.message))},
    {label:'Keep focus in other apps',type:'checkbox',checked:preferences.noFocusWhenPrivate,enabled:preferences.contentProtection,click:item=>action('preferences',{noFocusWhenPrivate:item.checked}).catch(e=>report(e.message))},
    {type:'separator'},{role:'quit'},
  ]));
}
function setCompact(value) { compact = value; win.setSize(690, value ? 104 + (attachment ? 46 : 0) + (problem ? 72 : 0) : 500, true); update(); }
async function connect() {
  if (connecting) return connecting;
  if (busy) throw new Error('Stop the current answer before reconnecting.');
  connecting = (async () => {
    problem = ''; status = 'Connecting to Codex…'; connected = false; update();
    try {
      const result = await codex.connect(); models = result.models;
      if (!models.some(m => m.model === selectedModel)) selectedModel = models.find(m => m.isDefault)?.model || models[0]?.model;
      const model = models.find(m => m.model === selectedModel);
      selectedServiceTier=normalizeServiceTier(model,selectedServiceTier);
      if (!model?.supportedReasoningEfforts?.some(e => e.reasoningEffort === selectedEffort)) selectedEffort = model?.defaultReasoningEffort || 'low';
      connected = true; status = 'Codex connected'; save();
    } catch (e) { status = 'Codex disconnected'; report(e.message); }
    finally { connecting = null; update(); }
  })();
  return connecting;
}
async function captureScreen(forRequest = false) {
  if (busy && !forRequest) throw new Error('Wait for the answer before attaching a screen.');
  const display = screen.getDisplayMatching(win.getBounds());
  const scale = Math.min(1, 1920 / Math.max(display.size.width, display.size.height));
  const visible = win.isVisible(), focused=win.isFocused();
  win.hide();
  try {
    await new Promise(r => setTimeout(r, 180));
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) } });
    const source = sources.find(s => s.display_id === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) throw new Error('Enable Local Companion under System Settings → Privacy & Security → Screen & System Audio Recording, then reopen the app.');
    await setAttachment(source.thumbnail.toPNG(), 'Screen');
  } finally { if (visible) showWindow({focus:focused}); }
}
async function setAttachment(bytes, name) {
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error('Choose a PNG or JPEG image.');
  const target = path.join(dataDir, 'images', randomUUID() + '.png');
  await fs.writeFile(target, image.toPNG(), { mode: 0o600 });
  attachment = { path: target, preview: image.resize({ width: 320 }).toDataURL(), name };
  if (compact) setCompact(true);
  update();
}
async function ask(input = {}) {
  const request = typeof input === 'string' ? {text:input} : input || {};
  const kind = request.kind || 'assist';
  if (!Object.hasOwn(ACTIONS,kind)) throw new Error('Unknown answer action.');
  if (!connected) throw new Error('Connect to Codex first.');
  if (busy || requesting) throw new Error('Stop the current answer before asking again.');
  requesting = true; problem = ''; update();
  const s = active();
  try {
    if (audioBusy && kind !== 'screen') throw new Error('Audio is starting. Wait until Listening appears.');
    // Flush incomplete utterances without ending the listening session.
    if (kind !== 'screen' && (listening || audio.pending.size)) { status = 'Finishing the latest transcript…'; update(); await audio.flush(); }
    const freshScreen = ['screen','screen-transcript'].includes(kind);
    const shouldCapture = freshScreen || (preferences.screenUse && !['notes','email','latest'].includes(kind));
    const model = models.find(m=>m.model===selectedModel);
    if (['latest','screen-transcript'].includes(kind) && !s.transcript.some(t=>t.text?.trim())) throw new Error('No transcript yet. Start Listen and wait for speech before answering the latest question.');
    if (((kind !== 'latest' && attachment) || shouldCapture) && model?.inputModalities && !model.inputModalities.includes('image')) throw new Error('Choose an image-capable model or turn Uses Screen off.');
    if (shouldCapture && (!attachment || freshScreen)) { status='Capturing screen…'; update(); await captureScreen(true); }
    const image=kind === 'latest' ? null : attachment;
    if (!(request.text||'').trim() && !s.transcript.length && !image && !currentMode().context && !currentMode().files.length) throw new Error('Start Listen, enable Uses Screen, attach context, or type a question.');
    const built=buildRequest({...request,kind,session:s,mode:currentMode(),preferences,hasImage:!!image});
    busy=true; setCompact(false); showWindow();
    win.webContents.send('navigate','chat');
    s.modeId=modeId;
    if (!s.messages.length && s.title==='New conversation') s.title=built.label==='Assist' ? (s.transcript.find(t=>t.source==='Computer')?.text || 'Screen assistance').slice(0,65) : built.label.slice(0,65);
    if (kind !== 'latest') attachment=null;
    s.messages.push({role:'user',text:built.label,image:image?.preview||null,context:built.context,prompt:built.prompt});
    const answer={role:'assistant',text:'',state:'working',kind}; s.messages.push(answer); s.currentAnswer=s.messages.length-1;
    s.lastRequest={...request,kind};
    update();save();
    try { await codex.ask({threadId:freshScreen ? undefined : kind === 'latest' ? s.transcriptThreadId : s.threadId,text:built.prompt,image:image?.path,model:selectedModel,serviceTier:selectedServiceTier,effort:preferences.smart?smartEffort(model):selectedEffort,smart:preferences.smart,instructions:preferences.baseInstructions}); }
    catch(e) {busy=false;answer.state='failed';answer.error=e.message;throw e;}
  } finally { requesting=false;status=connected?'Codex connected':'Codex disconnected';update();save(); }
}
function normalizeServiceTier(model,tier) {return model?.serviceTiers?.some(t=>t.id===tier)?tier:'default';}
function smartEffort(model) { const available=model?.supportedReasoningEfforts?.map(e=>e.reasoningEffort)||[]; return available.includes('high')?'high':selectedEffort; }
function registerShortcuts(next) {
  const handlers={
    focus:()=>action('type-question'),assist:()=>ask({kind:'latest'}),visibility:toggleWindow,
    listen:()=>action('listen'),screenshot:()=>win.webContents.send('command','screen'),screenTranscript:()=>win.webContents.send('command','screen-transcript'),new:()=>action('new'),
    moveUp:()=>move(0,-80),moveDown:()=>move(0,80),moveLeft:()=>move(-80,0),moveRight:()=>move(80,0),
    scrollUp:()=>win.webContents.send('scroll',-240),scrollDown:()=>win.webContents.send('scroll',240),
  };
  const values=Object.values(next).filter(Boolean);
  if (new Set(values.map(v=>v.toLowerCase())).size!==values.length) throw new Error('Each shortcut must be unique.');
  globalShortcut.unregisterAll();
  for(const [name,accelerator] of Object.entries(next)) {
    if(!accelerator || !handlers[name]) continue;
    let registered=false;
    try { registered=globalShortcut.register(accelerator,()=>Promise.resolve().then(handlers[name]).catch(e=>report(e.message))); } catch {}
    if(!registered) { globalShortcut.unregisterAll(); throw new Error(`Shortcut ${accelerator} is unavailable. Choose another combination.`); }
  }
}
function move(dx,dy) {const b=win.getBounds(),area=screen.getDisplayMatching(b).workArea;win.setPosition(Math.max(area.x,Math.min(area.x+area.width-b.width,b.x+dx)),Math.max(area.y,Math.min(area.y+area.height-b.height,b.y+dy)));}

function bindEvents() {
  codex.on('diagnostic', text => { void fs.writeFile(path.join(dataDir, 'connection-diagnostic.log'), text, { mode: 0o600 }); });
  codex.on('cancelError', report);
  codex.on('thread', id => { const s=active(); const key=s.messages[s.currentAnswer]?.kind==='latest'?'transcriptThreadId':'threadId'; s[key]=id; save(); });
  codex.on('delta', text => { const s = active(); const a = s.messages[s.currentAnswer]; if (a) { a.text += text; update(); } });
  codex.on('message', item => { const s = active(); const a = s.messages[s.currentAnswer]; if (a && !a.text) a.text = item.text || ''; update(); });
  codex.on('completed', turn => {
    busy = false;
    const s = active(); const a = s.messages[s.currentAnswer];
    if (a) { a.state = turn?.status || 'failed'; if (turn?.error) a.error = turn.error.message || 'Codex could not complete this answer.'; }
    if (a?.kind === 'notes' && turn?.status === 'completed') { s.notes=a.text; s.notesAt=Date.now(); win.webContents.send('navigate','notes'); }
    if (turn?.status === 'failed') report(a?.error || 'Codex could not complete this answer.');
    update(); save();
  });
  codex.on('disconnected', message => {
    connected = false; status = 'Codex disconnected';
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
    if (s) { s.transcript.push({ source: item.source, text: item.text, at: item.at, seconds: item.seconds }); s.transcript.sort((a, b) => a.at - b.at); save(); update(); }
  });
}
async function action(name, payload) {
  switch (name) {
    case 'view': if(!compact)win.setSize(690,['modes','history','settings'].includes(payload)?760:500,true);break;
    case 'compact': setCompact(Boolean(payload)); break;
    case 'toggle-window': toggleWindow(); break;
    case 'toggle-privacy':
      preferences.contentProtection = !preferences.contentProtection;
      privacy?.apply(preferences);updateTray();save();update();break;
    case 'connect': await connect(); break;
    case 'ask': await ask(payload); break;
    case 'more': {
      const navigate=view=>win.webContents.send('navigate',view);
      Menu.buildFromTemplate([
        ...(preferences.contentProtection && preferences.noFocusWhenPrivate?[{label:'Type a question…',click:()=>action('type-question').catch(e=>report(e.message))},{type:'separator'}]:[]),
        {label:'Screen + transcript',enabled:connected && !busy && !requesting && !audioBusy,click:()=>win.webContents.send('command','screen-transcript')},
        {label:'Transcript',click:()=>navigate('transcript')},
        {label:'History',click:()=>navigate('history')},
        {label:'Notes',click:()=>navigate('notes')},
        {type:'separator'},
        {label:'New interview',enabled:!busy && !requesting && !audioBusy,click:()=>void action('new').catch(e=>report(e.message))},
        {label:'Settings',click:()=>action('open-settings').catch(e=>report(e.message))},
      ]).popup({window:win});break;
    }
    case 'choose-mode': {
      const preferred=['interview','behavioral','coding','system-design','case','recruiter','general'];
      const entry=m=>({label:m.name,type:'radio',checked:modeId===m.id,enabled:!busy && !requesting,click:()=>void action('mode',m.id).catch(e=>report(e.message))});
      const primary=preferred.map(id=>modes.find(m=>m.id===id)).filter(Boolean);
      const others=modes.filter(m=>!preferred.includes(m.id));
      Menu.buildFromTemplate([...primary.map(entry),...(others.length?[{label:'Other modes',submenu:others.map(entry)}]:[]),{type:'separator'},{label:'Edit modes & context…',click:async()=>{await action('type-question');win.webContents.send('navigate','modes');}}]).popup({window:win});break;
    }
    case 'choose-model': {
      if(busy || requesting) throw new Error('Wait for the answer before changing models.');
      if(!models.length) throw new Error('Connect to Codex to load your models.');
      const model=models.find(m=>m.model===selectedModel);
      const choose=payload=>void action('answer-model',payload).catch(e=>report(e.message));
      Menu.buildFromTemplate([
        ...models.map(m=>({label:m.displayName || m.model,type:'radio',checked:m.model===selectedModel,click:()=>choose({model:m.model})})),
        {type:'separator'},
        {label:'Answer speed',submenu:[{label:'Standard',type:'radio',checked:selectedServiceTier==='default',click:()=>choose({serviceTier:'default'})},...(model?.serviceTiers||[]).filter(t=>t.id!=='default').map(t=>({label:`${t.name} · ${t.description || 'Faster answers'}${/usage/i.test(t.description||'')?'':' · increased usage'}`,type:'radio',checked:selectedServiceTier===t.id,click:()=>choose({serviceTier:t.id})}))]},
        {label:'Reasoning effort',submenu:(model?.supportedReasoningEfforts || []).map(e=>({label:e.reasoningEffort,type:'radio',checked:e.reasoningEffort===selectedEffort,click:()=>choose({effort:e.reasoningEffort})}))},
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
    case 'retry': await ask(active().lastRequest || {}); break;
    case 'end-session': {
      if(busy || requesting || audioBusy) throw new Error('Wait for the current operation before ending the session.');
      await audio.stop(); await audio.drain(); active().endedAt=Date.now(); save();
      if(preferences.autoNotes && active().transcript.length) await ask({kind:'notes'});
      break;
    }
    case 'type-question': {
      preferences.noFocusWhenPrivate=false;privacy?.apply(preferences);updateTray();save();update();showWindow();
      win.webContents.send('command','focus-question');break;
    }
    case 'open-settings': {
      await action('type-question');win.webContents.send('navigate','settings');break;
    }
    case 'preferences': {
      if(busy || requesting) throw new Error('Wait for the answer before changing its settings.');
      const next={...preferences};
      for(const k of ['screenUse','smart','autoNotes','contentProtection','noFocusWhenPrivate','showRequestDetails']) if(typeof payload[k]==='boolean') next[k]=payload[k];
      if(typeof payload.language==='string') next.language=payload.language.slice(0,60);
      if(typeof payload.baseInstructions==='string') next.baseInstructions=payload.baseInstructions.trim() || BASE_INSTRUCTIONS;
      if(payload.shortcuts) {
        next.shortcuts={...DEFAULT_SHORTCUTS,...payload.shortcuts};
        try { registerShortcuts(next.shortcuts); } catch(e) {try{registerShortcuts(preferences.shortcuts);}catch{} throw e;}
      }
      preferences=next;privacy?.apply(preferences);updateTray();save();update();break;
    }
    case 'mode': {
      if(busy || requesting) throw new Error('Wait for the answer before switching modes.');
      if(!modes.some(m=>m.id===payload)) throw new Error('Mode not found.');
      modeId=payload;active().modeId=modeId;save();update();break;
    }
    case 'save-mode': {
      if(busy || requesting) throw new Error('Wait for the answer before editing its mode.');
      const mode=modes.find(m=>m.id===payload.id);if(!mode) throw new Error('Mode not found.');
      for(const key of ['name','instructions','context','notesTemplate']) if(typeof payload[key]==='string') mode[key]=payload[key].slice(0,key==='name'?80:20000);
      if(!mode.name.trim()) mode.name='Custom mode';save();update();break;
    }
    case 'new-mode': {if(busy || requesting) throw new Error('Wait for the answer before switching modes.'); const mode={id:randomUUID(),name:'Custom mode',instructions:'',context:'',notesTemplate:'Summary\nDecisions\nAction items\nOpen questions',files:[]};modes.push(mode);modeId=mode.id;save();update();break;}
    case 'import-context': {
      const mode=currentMode();
      const result=await dialog.showOpenDialog(win,{properties:['openFile','multiSelections'],filters:[{name:'Reference documents',extensions:['pdf','docx','txt','md','csv','json']}]});
      if(!result.canceled) for(const file of result.filePaths) {
        const output=await runFile(path.join(project,'.venv/bin/python'),[path.join(root,'scripts/extract_document.py'),file],{timeout:30000,maxBuffer:2000000});
        const doc=JSON.parse(output.stdout);
        if(mode.files.reduce((n,f)=>n+f.text.length,0)+doc.text.length>200000) throw new Error('This mode has over 200,000 reference characters. Remove a file or import an excerpt.');
        mode.files.push({id:randomUUID(),...doc});save();update();
      }break;
    }
    case 'remove-context': {currentMode().files=currentMode().files.filter(f=>f.id!==payload);save();update();break;}
    case 'rename-session': {if(typeof payload==='string'&&payload.trim())active().title=payload.trim().slice(0,120);save();update();break;}
    case 'save-notes': {active().notes=String(payload);active().notesAt=Date.now();save();update();break;}
    case 'permissions': await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');break;
    case 'microphone-permission': await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');break;
    case 'stop': await codex.interrupt(); break;
    case 'screen': await captureScreen(); break;
    case 'remove-image': if (attachment) await fs.rm(attachment.path, { force: true }); attachment = null; if (compact) setCompact(true); update(); break;
    case 'image': {
      const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }] });
      if (!result.canceled) await setAttachment(await fs.readFile(result.filePaths[0]), path.basename(result.filePaths[0]));
      break;
    }
    case 'new':
    case 'session': {
      if (busy || requesting || audioBusy || audio.pending.size) throw new Error('Wait for the current answer or pending transcription before switching sessions.');
      await audio.stop();
      if (name === 'new') newSession(); else if (sessions.some(s => s.id === payload)) {activeId = payload;modeId=active().modeId || modeId;}
      attachment = null; problem = ''; setCompact(name === 'new'); win.webContents.send('navigate',name==='new'?'new':'chat'); save(); update(); break;
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
      const s = active(); const result = await dialog.showSaveDialog(win, { defaultPath: `${s.title.replace(/[/\\:]/g, '-')}.txt` });
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
  app.on('second-instance', () => { if(win)void action('type-question'); });
  app.whenReady().then(async () => {
    await fs.mkdir(path.join(dataDir, 'images'), { recursive: true });
    await fs.mkdir(path.join(dataDir, 'workspace'), { recursive: true });
    try {
      const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'history.json'), 'utf8'));
      preferences={...preferences,...saved.preferences,shortcuts:{...DEFAULT_SHORTCUTS,...saved.preferences?.shortcuts}}; modes=saved.modes?.length?upgradeModes(saved.modes):modes;modeId=saved.modeId||'general';
      for(const direction of ['Up','Down','Left','Right']) {
        if(preferences.shortcuts['move'+direction]==='Control+Alt+'+direction) preferences.shortcuts['move'+direction]='Command+'+direction;
      }
      sessions = saved.sessions || []; selectedModel = saved.selectedModel || ''; selectedEffort = saved.selectedEffort || 'low'; selectedServiceTier = saved.selectedServiceTier || 'default'; microphone = saved.microphone || '';
      for (const s of sessions) for (const m of s.messages) if (m.state === 'working') m.state = 'interrupted';
    } catch (e) { if (e.code !== 'ENOENT') problem = 'Could not load saved history. The existing file has been left in place.'; }
    if (!sessions.length) newSession(); else {activeId = sessions[0].id;modeId=active().modeId || modeId;}
    codex = new CodexClient(path.join(dataDir, 'workspace'));
    audio = new AudioPipeline({ helper: captureBinary, python: path.join(project, '.venv/bin/python'), worker: path.join(root, 'scripts/transcribe.py'), directory: path.join(dataDir, 'audio-temp') });
    bindEvents();
    compact = active().messages.length === 0;
    win = new BrowserWindow({ show:false, ...(process.platform==='darwin'?{type:'panel'}:{}), acceptFirstMouse:true, fullscreenable:false, hiddenInMissionControl:preferences.contentProtection, skipTaskbar:preferences.contentProtection, width: 690, height: compact ? 104 : 500, minWidth: 690, maxWidth: 690, minHeight: 104, title: 'Local Companion', backgroundColor: '#00000000', transparent: true, frame: false, roundedCorners: true, hasShadow: false, alwaysOnTop: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.webContents.on('before-input-event', (event, input) => {
      if(input.type!=='keyDown' || !input.meta || input.control || input.alt || input.shift) return;
      const direction=input.key.replace(/^Arrow/,'');
      const delta={Up:[0,-80],Down:[0,80],Left:[-80,0],Right:[80,0]}[direction];
      if(delta && preferences.shortcuts['move'+direction]==='Command+'+direction) {event.preventDefault();move(...delta);}
    });
    win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
    win.webContents.on('will-navigate', (event, url) => { if (url !== win.webContents.getURL()) event.preventDefault(); });
    await win.loadFile(path.join(__dirname, 'index.html'));
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Local Companion', submenu: [{ label: 'Show / Hide', accelerator: 'Control+Alt+Space', click: toggleWindow }, { label: 'New conversation', accelerator: 'CmdOrCtrl+N', click: () => action('new').catch(e => report(e.message)) }, { type: 'separator' }, { role: 'quit' }] }, { role: 'editMenu' }, { role: 'windowMenu' }]));
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname,'trayTemplate.png')));
    tray.setToolTip('Local Companion');updateTray();
    privacy = new WindowPrivacy({app,win,onError:report,onChange:update});privacy.apply(preferences);
    win.setAlwaysOnTop(true,'modal-panel');showWindow();
    try {registerShortcuts(preferences.shortcuts);}catch(e){report(e.message);}
    if (process.argv.includes('--ui-fixture')) {
      connected = true; status = 'Preview · sample conversation'; selectedModel = 'gpt-6.1-sol';
      models = [{ model: selectedModel, displayName: 'GPT-6.1 Sol', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }];
      const s = active(); s.messages = [{ role: 'user', text: 'How would you explain this project in an interview?' }, { role: 'assistant', state: 'completed', text: 'Start with the problem, then your contribution.\n\n**A useful structure**\n\n1. Explain what users needed.\n2. Describe the part you built.\n3. Give one concrete result.\n\nKeep the first answer to about a minute, then let the interviewer choose what to explore.' }]; update();
    } else void connect();
  }).catch(e => { dialog.showErrorBox('Local Companion', e.message); app.quit(); });
}
ipcMain.handle('snapshot', () => snapshot());
ipcMain.handle('action', async (_event, name, payload) => { try { return { ok: true, value: await action(name, payload) }; } catch (e) { report(e.message); return { ok: false, error: e.message }; } });
app.on('activate', () => { if(win)showWindow(); });
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true;
  clearTimeout(saveTimer); privacy?.dispose();tray?.destroy();globalShortcut.unregisterAll(); audio?.close(); codex?.disconnect();
  void writeState().finally(() => app.quit());
});
app.on('window-all-closed', () => app.quit());
