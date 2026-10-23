const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {EventEmitter}=require('node:events');const vm=require('node:vm');
const {InputDiagnostics}=require('../src/input-diagnostics.cjs');
async function setup(t,options={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'companion-input-'));
  const win=new EventEmitter(),ipcMain=new EventEmitter(),webContents=new EventEmitter();
  Object.assign(webContents,{isFocused:()=>true,send:(name,sequence)=>{webContents.lastPing={name,sequence}}});
  Object.assign(win,{webContents,isDestroyed:()=>false,isFocused:()=>true,isFocusable:()=>true,isEnabled:()=>true,isVisible:()=>true});
  const diagnostics=new InputDiagnostics({win,ipcMain,directory,...options});
  t.after(async()=>{await diagnostics.dispose();await fs.rm(directory,{recursive:true,force:true});});
  return {win,ipcMain,webContents,diagnostics,directory};
}
test('records native versus renderer input counts without content, and exposes a missing renderer reply',async t=>{
  const h=await setup(t);const d=h.diagnostics;
  h.webContents.emit('before-input-event',{}, {type:'keyDown',key:'PRIVATE KEY'});
  h.webContents.emit('before-mouse-event',{}, {type:'mouseDown',x:999,y:888});
  d.ping();
  const {sequence}=h.webContents.lastPing;
  h.ipcMain.emit('input-health',{sender:{}},{sequence,keys:900});
  h.ipcMain.emit('input-health',{sender:h.webContents},{sequence,keys:1,clicks:1,inputs:1,focused:true,visible:true,text:'PRIVATE TEXT'});
  d.ping(); // Simulate a renderer that stops replying while main remains alive.
  await d.chain;
  const raw=await fs.readFile(d.file,'utf8');const rows=raw.trim().split('\n').map(JSON.parse);
  const reply=rows.find(r=>r.event==='renderer-health');
  assert.equal(reply.nativeKeys,1);assert.equal(reply.nativeClicks,1);assert.equal(reply.domKeys,1);
  assert.equal(rows.filter(r=>r.event==='renderer-health').length,1);
  assert.equal(rows.at(-1).event,'main-health');
  assert.doesNotMatch(raw,/PRIVATE/);
  assert.ok(rows.every(row=>!('key' in row)&&!('text' in row)&&!('x' in row)&&!('y' in row)));
});
test('rotates local diagnostics within two bounded files and detaches on shutdown',async t=>{
  const h=await setup(t,{maxBytes:700});
  for(let i=0;i<30;i++)h.diagnostics.record('focus');
  await h.diagnostics.dispose();
  for(const file of [h.diagnostics.file,h.diagnostics.previous])assert.ok((await fs.stat(file)).size<=700);
  assert.equal(h.webContents.listenerCount('before-input-event'),0);
  assert.equal(h.ipcMain.listenerCount('input-health'),0);
});
test('preload sends only counters and focus state, never event data',async()=>{
  const handlers=new Map(),ipc=new EventEmitter(),sent=[];
  ipc.send=(...args)=>sent.push(args);
  vm.runInNewContext(await fs.readFile(path.join(__dirname,'../src/preload.cjs'),'utf8'),{
    require:()=>({contextBridge:{exposeInMainWorld(){}},ipcRenderer:ipc}),
    window:{addEventListener:(type,fn)=>handlers.set(type,fn)},
    document:{hasFocus:()=>true,visibilityState:'visible'},
  });
  handlers.get('keydown')({key:'SECRET'});handlers.get('input')({target:{value:'SECRET'}});
  ipc.emit('input-health-ping',{},4);
  assert.deepEqual(JSON.parse(JSON.stringify(sent)),[['input-health',{sequence:4,keys:1,clicks:0,inputs:1,errors:0,rejections:0,focused:true,visible:true}]]);
});
