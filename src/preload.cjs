const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('companion', {
  snapshot: () => ipcRenderer.invoke('snapshot'),
  action: (name, payload) => ipcRenderer.invoke('action', name, payload),
  onState: callback => ipcRenderer.on('state', (_event, value) => callback(value)),
  onCommand: callback => ipcRenderer.on('command', (_event, value) => callback(value)),
  onNavigate: callback => ipcRenderer.on('navigate', (_event, value) => callback(value)),
  onScroll: callback => ipcRenderer.on('scroll', (_event, value) => callback(value)),
  onLevel: callback => ipcRenderer.on('level', (_event, value) => callback(value)),
});
