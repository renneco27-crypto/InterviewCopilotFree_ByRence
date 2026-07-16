const { app, BrowserWindow, ipcMain, Menu, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, execFile, spawn } = require('child_process');

let mainWindow;
let contentProtectionEnabled = false;

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

// Process handle for the Edge --app window we spawned.
let phoneMicProcess = null;

/**
 * Resolve the Edge executable path.
 * Tries the standard install locations; falls back to PATH.
 */
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

// Window title used by the relay page — Edge --app windows use <title> as the
// window title, so "Interview Mic" (from phone.html) is what we search for.
const RELAY_WINDOW_TITLE = 'Interview Mic';

/**
 * Check via PowerShell whether an Edge --app window with our relay page title
 * is already open. Returns a Promise<boolean>.
 */
function relayWindowAlreadyOpen() {
  return new Promise((resolve) => {
    // Get-Process msedge | Where MainWindowTitle matches our title
    const ps = `(Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${RELAY_WINDOW_TITLE}*' }).Count -gt 0`;
    exec(`powershell -NoProfile -Command "${ps}"`, (err, stdout) => {
      if (err) { resolve(false); return; }
      resolve(stdout.trim().toLowerCase() === 'true');
    });
  });
}

/**
 * Close the relay window cleanly via PowerShell by sending WM_CLOSE to the
 * window with our title, rather than force-killing the entire Edge process tree.
 * Falls back to taskkill on the tracked PID if the window title search fails.
 */
function closeRelayWindow(pid) {
  const ps = `
    Add-Type -TypeDefinition @'
    using System;
    using System.Runtime.InteropServices;
    public class Win32 {
      [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
      [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
      [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
      [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
      public delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);
    }
'@ -ErrorAction SilentlyContinue
    $found = $false
    [Win32]::EnumWindows([Win32+EnumWindowsProc]{
      param($h, $lp)
      if (-not [Win32]::IsWindowVisible($h)) { return $true }
      $sb = New-Object System.Text.StringBuilder 256
      [Win32]::GetWindowText($h, $sb, 256) | Out-Null
      if ($sb.ToString() -like '*${RELAY_WINDOW_TITLE}*') {
        [Win32]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
        $found = $true
        return $false
      }
      return $true
    }, [IntPtr]::Zero) | Out-Null
    $found
  `.trim().replace(/\n\s*/g, '; ');

  exec(`powershell -NoProfile -Command "${ps}"`, (err, stdout) => {
    const closed = !err && stdout.trim().toLowerCase() === 'true';
    if (!closed && pid) {
      // Fallback: taskkill the specific PID we spawned
      exec(`taskkill /F /PID ${pid}`, (e) => {
        if (e) console.error('[PhoneMic] taskkill fallback error:', e.message);
      });
    } else {
      console.log('[PhoneMic] Relay window closed via WM_CLOSE');
    }
  });
}

async function startPhoneMic() {
  if (!phonePageUrl) {
    console.warn('[PhoneMic] No phonePageUrl configured — check .env RELAY_URL');
    return;
  }

  // If our tracked process is still alive, window is already open — skip.
  if (phoneMicProcess && phoneMicProcess.exitCode === null) {
    console.log('[PhoneMic] Already running (pid', phoneMicProcess.pid, ') — skipping open');
    return;
  }

  // Also check for a relay window that was opened outside our process tracking
  // (e.g. user opened it manually, or Electron restarted without closing it).
  const alreadyOpen = await relayWindowAlreadyOpen();
  if (alreadyOpen) {
    console.log('[PhoneMic] Relay window already open — skipping open');
    return;
  }

  // Append ?autostart=1 so the relay page starts the mic automatically
  // once its WebSocket is open — no click simulation needed.
  const url = phonePageUrl + (phonePageUrl.includes('?') ? '&' : '?') + 'autostart=1';
  console.log('[PhoneMic] Launching Edge --app:', url);

  const edgePath = getEdgePath();

  phoneMicProcess = spawn(edgePath, [
    `--app=${url}`,
    '--new-window',
    '--no-first-run',
    '--disable-extensions',
  ], {
    detached: false,
    stdio:    'ignore',
  });

  phoneMicProcess.on('error', (err) => {
    console.error('[PhoneMic] Failed to launch Edge:', err.message);
    phoneMicProcess = null;
  });

  phoneMicProcess.on('exit', (code) => {
    console.log('[PhoneMic] Edge process exited with code', code);
    phoneMicProcess = null;
  });
}

function stopPhoneMic() {
  const pid = phoneMicProcess ? phoneMicProcess.pid : null;
  phoneMicProcess = null;
  // Close the window gracefully — sends WM_CLOSE so Edge can clean up,
  // falls back to taskkill on the tracked PID if the title search misses.
  closeRelayWindow(pid);
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
  return { success: true, alreadyRunning: !!(phoneMicProcess && phoneMicProcess.exitCode === null) };
});

ipcMain.handle('stop-phone-mic', () => {
  stopPhoneMic();
  return { success: true };
});

ipcMain.handle('toggle-phone-mic', async () => {
  const running = !!(phoneMicProcess && phoneMicProcess.exitCode === null);
  if (running) { stopPhoneMic(); return { success: true, state: 'stopped' }; }
  else          { await startPhoneMic(); return { success: true, state: 'starting' }; }
});

// ──────────────────────────────────────────────────────────────────────
// APP LIFECYCLE
// ──────────────────────────────────────────────────────────────────────

app.commandLine.appendSwitch('enable-features', 'WebSpeech');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream', 'false');
app.commandLine.appendSwitch('allow-http-screen-capture');

app.on('ready', () => {
  createWindow();
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
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

module.exports = { setContentProtection, reassertContentProtection };
