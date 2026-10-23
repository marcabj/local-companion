const { contextBridge, ipcRenderer } = require('electron');
const inputHealth={keys:0,clicks:0,inputs:0,errors:0,rejections:0};
for(const [event,counter] of Object.entries({keydown:'keys',pointerdown:'clicks',input:'inputs',error:'errors',unhandledrejection:'rejections'}))
  window.addEventListener(event,()=>{inputHealth[counter]++;},true);
ipcRenderer.on('input-health-ping',(_event,sequence)=>ipcRenderer.send('input-health',{
  sequence,...inputHealth,focused:document.hasFocus(),visible:document.visibilityState==='visible',
}));
contextBridge.exposeInMainWorld('companion', {
  saveDraft: draft => ipcRenderer.invoke('save-draft', draft),
  snapshot: () => ipcRenderer.invoke('snapshot'),
  action: (name, payload) => ipcRenderer.invoke('action', name, payload),
  onState: callback => ipcRenderer.on('state', (_event, value) => callback(value)),
  onCommand: callback => ipcRenderer.on('command', (_event, value) => callback(value)),
  onNavigate: callback => ipcRenderer.on('navigate', (_event, value) => callback(value)),
  onScroll: callback => ipcRenderer.on('scroll', (_event, value) => callback(value)),
  onLevel: callback => ipcRenderer.on('level', (_event, value) => callback(value)),
});
