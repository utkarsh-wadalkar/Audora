const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFolder: (path) => ipcRenderer.invoke('open-folder', path),
  showNotification: (opts) => ipcRenderer.invoke('show-notification', opts),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
});
