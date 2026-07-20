const { app, BrowserWindow, ipcMain, Menu, clipboard, shell, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');

let mainWindow;
let contentProtectionEnabled = false;
let isMicMuted = false;
let cleanupDone = false; // guard: ensures stopPhoneMicSync only runs once across quit paths

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
    // Ensure the relay Edge window is always killed when the overlay closes,
    // regardless of how it was closed (OS X button, task manager, etc.)
    stopPhoneMicSync();
  });
}

// ──────────────────────────────────────────────────────────────────────
// PHONE MIC — Launches Edge as a standalone --app window
// ──────────────────────────────────────────────────────────────────────

let phoneMicProcess = null;
// Launch lock: set to true the moment we decide to spawn, cleared on exit/error.
// Prevents a second concurrent startPhoneMic() call from spawning a duplicate
// window during the async gap between the decision and the process being alive.
let phoneMicLaunching = false;

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

// Returns the PIDs of every Edge process that either:
//   (a) has a MainWindowTitle matching RELAY_WINDOW_TITLE, OR
//   (b) was launched with a command-line containing the relay URL.
// Dual approach because --app windows sometimes don't set MainWindowTitle
// reliably until the page finishes loading.
function getRelayWindowPids() {
  const pids = new Set();

  // Strategy 1: title match via PowerShell Get-Process (fast, all Windows versions)
  try {
    const ps = `Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${RELAY_WINDOW_TITLE}*' } | ForEach-Object { $_.Id }`;
    const stdout = require('child_process').execSync(
      `powershell -NoProfile -Command "${ps}"`,
      { encoding: 'utf8', timeout: 2000 }
    );
    stdout.trim().split(/\s+/).map(Number).filter(n => n > 0).forEach(p => pids.add(p));
  } catch {}

  // Strategy 2: command-line URL match via Get-CimInstance
  // Replaces wmic which was removed in Windows 11 22H2+
  if (phonePageUrl) {
    try {
      const urlFragment = phonePageUrl.replace(/^https?:\/\//, '').split('?')[0];
      const ps = `Get-CimInstance Win32_Process -Filter "name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${urlFragment}*' } | Select-Object -ExpandProperty ProcessId`;
      const stdout = require('child_process').execSync(
        `powershell -NoProfile -Command "${ps}"`,
        { encoding: 'utf8', timeout: 2000 }
      );
      stdout.trim().split(/\s+/).map(Number).filter(n => n > 0).forEach(p => pids.add(p));
    } catch {}
  }

  return [...pids];
}

async function startPhoneMic() {
  if (!phonePageUrl) {
    console.warn('[PhoneMic] No phonePageUrl configured -- check .env RELAY_URL');
    return;
  }

  // Guard 1: a previous call is still in the middle of spawning.
  if (phoneMicLaunching) {
    console.log('[PhoneMic] Launch already in progress -- skipping duplicate call');
    return;
  }

  // Guard 2: we have a live child process handle.
  if (phoneMicProcess && phoneMicProcess.exitCode === null) {
    console.log('[PhoneMic] Already running (pid', phoneMicProcess.pid, ')');
    return;
  }

  // Guard 3: a relay window exists from a previous run (orphan or manual open).
  // Kill it first so we always start clean rather than stacking windows.
  const orphanPids = getRelayWindowPids();
  if (orphanPids.length > 0) {
    console.log('[PhoneMic] Found existing relay window(s):', orphanPids, '-- killing before relaunch');
    killRelayPids(orphanPids);
    // Short pause so the OS has time to release the window before we reopen.
    await new Promise(r => setTimeout(r, 400));
  }

  phoneMicLaunching = true;

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

  // Lock released as soon as the process is actually alive (or failed).
  phoneMicProcess.on('spawn', () => {
    phoneMicLaunching = false;
    console.log('[PhoneMic] Edge spawned (pid', phoneMicProcess && phoneMicProcess.pid, ')');
  });

  phoneMicProcess.on('error', (err) => {
    console.error('[PhoneMic] Failed to launch Edge:', err.message);
    phoneMicProcess = null;
    phoneMicLaunching = false;
  });

  phoneMicProcess.on('exit', (code) => {
    console.log('[PhoneMic] Edge exited with code', code);
    phoneMicProcess = null;
    phoneMicLaunching = false;
  });
}

// Kill a list of PIDs synchronously so callers (will-quit, quit-app) can be
// sure the windows are gone before the Electron process itself exits.
function killRelayPids(pids) {
  for (const pid of pids) {
    try {
      require('child_process').execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', timeout: 3000 });
      console.log('[Cleanup] Killed relay Edge pid', pid);
    } catch (e) {
      console.warn('[Cleanup] taskkill failed for pid', pid, e.message);
    }
  }
}

// Synchronously stop the phone mic child process AND any orphaned relay windows.
// Edge uses a process-pre-launch model — the PID from spawn may not be the
// actual window process, so we always run the orphan scan (title/URL match)
// as the reliable kill path. The fast PID kill is attempted first but never
// shortcuts the scan.
function stopPhoneMicSync() {
  cleanupDone = true; // signal will-quit to skip redundant cleanup
  if (phoneMicProcess) {
    const pid = phoneMicProcess.pid;
    phoneMicProcess = null;
    phoneMicLaunching = false;
    // Fast PID-based kill — may miss the real window process
    try {
      require('child_process').execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', timeout: 3000 });
      console.log('[PhoneMic] Edge killed by PID (pid', pid, ')');
    } catch (e) {
      console.warn('[PhoneMic] taskkill error for pid', pid, e.message);
    }
  }
  // Orphan scan by title/URL — catches the actual Edge window even when
  // the spawned PID is stale or handed off to a child process.
  killOrphanedRelayWindows();
}

function killOrphanedRelayWindows() {
  const pids = getRelayWindowPids();
  if (pids.length > 0) killRelayPids(pids);
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
  stopPhoneMicSync();
  return { success: true };
});

ipcMain.handle('toggle-phone-mic', async () => {
  const running = !!(phoneMicProcess && phoneMicProcess.exitCode === null);
  if (running) { stopPhoneMicSync(); return { success: true, state: 'stopped' }; }
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

// Authoritative mute-state query — renderer calls this on startup and after
// reconnecting the relay socket so it can sync relayPaused without waiting
// for the next Alt+Z toggle.
ipcMain.handle('get-relay-paused', () => {
  return { paused: isMicMuted };
});

// ── REQUIRED PRELOAD ADDITIONS ──────────────────────────────────────────────
// The renderer expects these two entries in contextBridge.exposeInMainWorld:
//
//   onRelayPause:  (cb) => ipcRenderer.on('relay-pause',  (_e) => cb()),
//   onRelayResume: (cb) => ipcRenderer.on('relay-resume', (_e) => cb()),
//   getRelayPaused: ()  => ipcRenderer.invoke('get-relay-paused'),
//
// Without them the renderer's onRelayPause/onRelayResume listeners in init()
// are no-ops and the renderer-side relayPaused flag never gets set.
// ────────────────────────────────────────────────────────────────────────────

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

// Graceful quit: kill Edge FIRST (so taskkill completes before Node exits),
// THEN destroy the overlay and quit. Edge kill is fast when PID is known (~50ms).
ipcMain.handle('quit-app', async () => {
  // 1. Kill Edge relay window synchronously — must finish before app.quit() fires
  stopPhoneMicSync();

  // 2. Now it's safe to destroy the window and quit
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
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
  // Run orphan cleanup async so it doesn't delay window creation on startup.
  // Uses PowerShell so even 2s timeout won't block the UI from appearing.
  setImmediate(() => killOrphanedRelayWindows());
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

  globalShortcut.register('CommandOrControl+M', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('global-ctrl-m');
    }
  });
});

app.on('will-quit', () => {
  // Covers task-manager kill / OS X Cmd+Q — quit-app IPC sets cleanupDone first
  // so we don't run a redundant (and slow) orphan scan after a clean quit.
  if (!cleanupDone) {
    stopPhoneMicSync();
  }
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
