// ──────────────────────────────────────────────────────────────────────
// PRELOAD SCRIPT - Safe API Bridge for Content Protection
// ──────────────────────────────────────────────────────────────────────

const { contextBridge, ipcRenderer } = require('electron');

// Expose a safe API to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Set content protection (hide from screen recorders)
  setContentProtection: (enable) => {
    return ipcRenderer.invoke('set-content-protection', enable);
  },

  // Check current protection status
  getContentProtectionStatus: () => {
    return ipcRenderer.invoke('get-content-protection-status');
  },

  // Resize the window
  resizeWindow: (width, height) => {
    return ipcRenderer.invoke('resize-window', width, height);
  },

  // Listen for window focus events to reassert protection
  onWindowFocus: (callback) => {
    ipcRenderer.on('window-focused', callback);
  },

  // Platform detection for frontend
  getPlatform: () => process.platform,

  // Read from clipboard
  readClipboard: () => ipcRenderer.invoke('read-clipboard'),

  // Relay config from .env
  getRelayConfig: () => ipcRenderer.invoke('get-relay-config'),

  // Phone mic window (hidden BrowserWindow)
  startPhoneMic: () => ipcRenderer.invoke('start-phone-mic'),
  stopPhoneMic: () => ipcRenderer.invoke('stop-phone-mic'),
});

console.log('✓ Electron API exposed to renderer');
