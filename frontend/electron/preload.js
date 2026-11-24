const { contextBridge, ipcRenderer } = require('electron');

const portArgument = process.argv.find((argument) => argument.startsWith('--audora-backend-port='));
const backendPort = Number(portArgument?.split('=')[1]);

contextBridge.exposeInMainWorld('electronAPI', {
  backendPort: Number.isInteger(backendPort) && backendPort > 0 && backendPort <= 65535 ? backendPort : 8000,
  openFolder: (path) => ipcRenderer.invoke('open-folder', path),
  showNotification: (opts) => ipcRenderer.invoke('show-notification', opts),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  adjustZoom: (steps) => ipcRenderer.invoke('adjust-zoom', steps),
  getUpdateState: () => ipcRenderer.invoke('update:get-state'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('update:state', listener);
    return () => ipcRenderer.removeListener('update:state', listener);
  },
});
