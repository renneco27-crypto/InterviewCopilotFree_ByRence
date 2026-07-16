const { app, BrowserWindow, ipcMain, Menu, clipboard, shell, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');

let mainWindow;
let contentProtectionEnabled = false;
let isMicMuted = false;

function setContentProtection(enable) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  contentProtectionEnabled = enable;
  mainWindow.setContentProtection(enable);
}

function reassertContentProtection() {
  if (contentProtectionEnabled && mainWindow && !mainWindow.isDestroyed()) {
    setContentProtection(true);
  }
}

// ──────────────────────────────────────────────────────────────────────
// RELAY CONFIG — loaded from .env file
// ──────────────────────────────────────────────────────────────────────
let relayConfig = { url: '', secret: '' };
let phonePageUrl = '';
try {
  const envPath = path.join(__dirname, '.env');
  const envRaw = fs.readFileSync(envPath, 'utf8');
  for (const line of envRaw.split('\n')) {
    const m = line.trim().match(/^(\w+)=(.+)$/);
    if (m) {
      if (m[1] === 'RELAY_URL') relayConfig.url = m[2];
      if (m[1] === 'RELAY_SECRET') relayConfig.secret = m[2];
    }
  }
  phonePageUrl = relayConfig.url.replace(/^wss:\/\//, 'https://');
} catch (e) {
  console.warn('No .env file found at', path.join(__dirname, '.env'));
}

// ──────────────────────────────────────────────────────────────────────
// WINDOW CREATION — Main Overlay
// ──────────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 620,
    height: 420,
    minWidth: 400,
    minHeight: 300,
    x: 100,
    y: 100,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      enableRemoteModule: false,
    },
    show: false,
  });

  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media');
  });

  const htmlPath = path.join(__dirname, 'interview-copilot-overlay.html');
  mainWindow.loadFile(htmlPath);

  mainWindow.webContents.on('console-message', (event, level, message) => {
    const prefix = ['[Renderer:verbose]', '[Renderer:info]', '[Renderer:warn]', '[Renderer:error]'][level] ?? '[Renderer]';
    console.log(prefix, message);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    setContentProtection(true);
    mainWindow.show();
  });

  mainWindow.on('focus', reassertContentProtection);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ──────────────────────────────────────────────────────────────────────
// PHONE MIC — Launches Edge as a standalone --app window
// ──────────────────────────────────────────────────────────────────────

let phoneMicProcess = null;

function getEdgePath() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'msedge'; // hope it's on PATH
}

const RELAY_WINDOW_TITLE = 'Interview Mic';

function relayWindowAlreadyOpen() {
  return new Promise((resolve) => {
    const ps = `(Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${RELAY_WINDOW_TITLE}*' }).Count -gt 0`;
    exec(`powershell -NoProfile -Command "${ps}"`, (err, stdout) => {
      if (err) { resolve(false); return; }
      resolve(stdout.trim().toLowerCase() === 'true');
    });
  });
}

async function startPhoneMic() {
  if (!phonePageUrl) {
    console.warn('[PhoneMic] No phonePageUrl configured — check .env RELAY_URL');
    return;
  }

  if (phoneMicProcess && phoneMicProcess.exitCode === null) {
    console.log('[PhoneMic] Already running (pid', phoneMicProcess.pid, ')');
    return;
  }

  const alreadyOpen = await relayWindowAlreadyOpen();
  if (alreadyOpen) {
    console.log('[PhoneMic] Relay window already open — skipping');
    return;
  }

  const url = phonePageUrl + (phonePageUrl.includes('?') ? '&' : '?') + 'autostart=1';
  console.log('[PhoneMic] Launching Edge:', url);

  const edgePath = getEdgePath();

  phoneMicProcess = spawn(edgePath, [
    `--app=${url}`,
    '--new-window',
    '--no-first-run',
    '--disable-extensions',
  ], {
    detached: false,
    stdio: 'ignore',
  });

  phoneMicProcess.on('error', (err) => {
    console.error('[PhoneMic] Failed to launch Edge:', err.message);
    phoneMicProcess = null;
  });

  phoneMicProcess.on('exit', (code) => {
    console.log('[PhoneMic] Edge exited with code', code);
    phoneMicProcess = null;
  });
}

function stopPhoneMic() {
  if (!phoneMicProcess) return;
  const pid = phoneMicProcess.pid;
  phoneMicProcess = null;
  exec(`taskkill /F /T /PID ${pid}`, (e) => {
    if (e) console.error('[PhoneMic] taskkill error:', e.message);
    else   console.log('[PhoneMic] Edge killed (pid', pid, ')');
  });
}

function killOrphanedRelayWindows() {
  try {
    const ps = `Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${RELAY_WINDOW_TITLE}*' } | ForEach-Object { $_.Id }`;
    const stdout = require('child_process').execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8', timeout: 5000 });
    const pids = stdout.trim().split(/\s+/).filter(Boolean);
    for (const pid of pids) {
      try {
        if (pid > 0) {
          require('child_process').execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', timeout: 3000 });
          console.log('[Cleanup] Killed orphan Edge pid', pid);
        }
      } catch {}
    }
  } catch {}
}

// ──────────────────────────────────────────────────────────────────────
// IPC COMMUNICATION
// ──────────────────────────────────────────────────────────────────────

ipcMain.handle('set-content-protection', (event, enable) => {
  setContentProtection(enable);
  return { success: true, enabled: contentProtectionEnabled };
});

ipcMain.handle('get-content-protection-status', () => {
  return { enabled: contentProtectionEnabled };
});

ipcMain.handle('resize-window', (event, width, height) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setSize(Math.round(width), Math.round(height));
    return { success: true };
  }
  return { success: false };
});

ipcMain.handle('read-clipboard', () => {
  return clipboard.readText();
});

ipcMain.handle('get-relay-config', () => relayConfig);

ipcMain.handle('start-phone-mic', async () => {
  await startPhoneMic();
  return { success: true };
});

ipcMain.handle('stop-phone-mic', () => {
  stopPhoneMic();
  return { success: true };
});

ipcMain.handle('toggle-phone-mic', async () => {
  const running = !!(phoneMicProcess && phoneMicProcess.exitCode === null);
  if (running) { stopPhoneMic(); return { success: true, state: 'stopped' }; }
  else         { await startPhoneMic(); return { success: true, state: 'starting' }; }
});

ipcMain.handle('set-mic-mute', (event, muted) => {
  isMicMuted = muted;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('mic-mute-changed', muted);
  }
  return { success: true, muted: isMicMuted };
});

ipcMain.handle('get-mic-mute', () => {
  return { muted: isMicMuted };
});

// Gate for relay data: renderer must call this before processing any relay
// message. Returns false when muted so the renderer drops the update entirely.
ipcMain.handle('relay-data-allowed', () => {
  return { allowed: !isMicMuted };
});

// Renderer forwards raw relay WebSocket messages here; main only re-emits
// them back as 'relay-message' if the mic is NOT muted.
ipcMain.on('relay-message-in', (event, payload) => {
  if (isMicMuted) return; // drop silently — mute blocks relay updates
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('relay-message', payload);
  }
});

// Renderer can trigger orphan cleanup as a safety net
ipcMain.handle('kill-orphan-relay', () => {
  killOrphanedRelayWindows();
  return { success: true };
});

// Graceful quit: stop phone mic + kill relay windows BEFORE closing the window,
// so cleanup runs while the process is still alive.
ipcMain.handle('quit-app', async () => {
  stopPhoneMic();
  killOrphanedRelayWindows();

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy(); // destroy skips the 'close' event, preventing loops
  }

  app.quit();
  return { success: true };
});

// ──────────────────────────────────────────────────────────────────────
// APP LIFECYCLE
// ──────────────────────────────────────────────────────────────────────

app.commandLine.appendSwitch('enable-features', 'WebSpeech');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream', 'false');
app.commandLine.appendSwitch('allow-http-screen-capture');

let pushToMuteActive = false;

app.on('ready', () => {
  killOrphanedRelayWindows();
  createWindow();
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  globalShortcut.register('Alt+Z', () => {
    isMicMuted = !isMicMuted;
    if (mainWindow && !mainWindow.isDestroyed()) {
      // push-to-mute: tells renderer to mute mic capture
      mainWindow.webContents.send('push-to-mute', isMicMuted);
      // relay-pause/resume: tells renderer to stop sending relay-message-in
      // so the main process gate above never even receives new relay data
      mainWindow.webContents.send(isMicMuted ? 'relay-pause' : 'relay-resume');
    }
  });
});

app.on('will-quit', () => {
  stopPhoneMic();
  killOrphanedRelayWindows();
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    reassertContentProtection();
    mainWindow.show();
  }
});

// ──────────────────────────────────────────────────────────────────────
// MENU
// ──────────────────────────────────────────────────────────────────────

const template = [
  {
    label: 'Interview Copilot',
    submenu: [
      {
        label: 'Toggle Content Protection',
        accelerator: 'Cmd+Shift+P',
        click: () => {
          setContentProtection(!contentProtectionEnabled);
        }
      },
      { type: 'separator' },
      {
        label: 'Quit',
        accelerator: 'Cmd+Q',
        click: () => app.quit()
      }
    ]
  }
];

module.exports = { setContentProtection, reassertContentProtection, killOrphanedRelayWindows };
