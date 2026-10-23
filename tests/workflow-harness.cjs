const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');const {EventEmitter}=require('node:events');
const {defaultModes,buildRequest}=require('../src/prompts.cjs');
function harness(){
 const calls=[],events=[],ipc=new Map(),shortcuts=new Map();let captures=0;
 const fakeImage={isEmpty:()=>false,toPNG:()=>Buffer.from('PNG'),resize(){return this},toDataURL:()=> 'data:image/png;base64,UE5H'};
 const electron={app:{commandLine:{appendSwitch(){}},setName(){},setPath(){},getPath:()=>'/tmp/companion-workflow-tests',requestSingleInstanceLock:()=>true,on(){},whenReady:()=>new Promise(()=>{})},ipcMain:{handle:(name,fn)=>ipc.set(name,fn)},systemPreferences:{getMediaAccessStatus:()=> 'granted'},screen:{getDisplayMatching:()=>({id:1,size:{width:2000,height:1000},workArea:{x:0,y:0,width:2000,height:1000}})},desktopCapturer:{getSources:async()=>{captures++;return [{display_id:'1',thumbnail:fakeImage}]}},nativeImage:{createFromBuffer:()=>fakeImage},globalShortcut:{unregisterAll(){shortcuts.clear()},register:(key,handler)=>{shortcuts.set(key,handler);return true}}};
 const codex=new EventEmitter();codex.ask=async request=>{calls.push(request)};
 const audio=new EventEmitter();audio.pending=new Map();audio.stop=async()=>{};audio.drain=async()=>{};audio.flush=async()=>{};
 const win={webContents:{send:(...v)=>events.push(v)},isDestroyed:()=>false,isVisible:()=>true,isFocused:()=>true,getBounds:()=>({x:0,y:0,width:690,height:500}),hide(){},show(){},focus(){},setSize(){},setContentProtection(){}};
 const context=vm.createContext({console,Buffer,process:{env:{},argv:[],resourcesPath:''},setTimeout:(fn,ms)=>{const t=setTimeout(fn,Math.min(ms,1));return t;},clearTimeout,require(name){if(name==='electron')return electron;if(name==='node:fs/promises')return {writeFile:async()=>{},rename:async()=>{},rm:async()=>{}};if(name.startsWith('./'))return require(path.resolve(__dirname,'../src',name));return require(name)},__dirname:path.resolve(__dirname,'../src'),fakeCodex:codex,fakeAudio:audio,fakeWin:win});
 vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../src/main.cjs'),'utf8'),context);
 vm.runInContext("win=fakeWin;codex=fakeCodex;audio=fakeAudio;connected=true;models=[{model:'fixture',inputModalities:['text','image'],supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]}];selectedModel='fixture';newSession();bindEvents();",context);
 const run=(code)=>vm.runInContext(code,context);
 return {calls,events,ipc,run,codex,audio,electron,shortcuts,captures:()=>captures};
}

module.exports=harness;
