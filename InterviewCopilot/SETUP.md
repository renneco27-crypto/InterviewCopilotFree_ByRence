# Interview Copilot Overlay — Setup & Build Guide

A floating interview assistant that's invisible to screen recorders, with AI-powered responses.

---

## 📋 Overview

### Features
✅ **Invisible to Screen Recorders** — Uses OS-level content protection  
✅ **Floating Window** — Draggable overlay, minimizable  
✅ **Smart Transcript Bar** — Real-time transcript, auto-paste from clipboard  
✅ **Large AI Response Display** — Only visible content (except transcript)  
✅ **Keyboard Shortcuts** — Ctrl+C to paste, Alt+R to record  
✅ **Multi-Model Support** — NVIDIA, Groq, Mistral, Google Gemini, Zhipu GLM

### UI Layout
```
┌─────────────────────────────────────┐
│ ⚫ Interview Copilot    [−] [✕]     │  ← Draggable header
├─────────────────────────────────────┤
│ You: What's your experience?        │  ← Small transcript bar
├─────────────────────────────────────┤
│                                     │
│     Your AI-generated response      │  ← Large, centered (main focus)
│     appears here in big text        │
│                                     │
└─────────────────────────────────────┘

Semi-transparent black overlay in background
```

---

## 🚀 Quick Start (Web Version)

### Option 1: Direct HTML File
1. Open `interview-copilot-overlay.html` in your browser
2. Configure API keys (open DevTools console):
   ```javascript
   localStorage.setItem('api_nvidia', 'your-api-key');
   localStorage.setItem('api_groq', 'your-api-key');
   ```
3. Press **Ctrl+C** to paste from clipboard and get AI response
4. Drag the title bar to move the window

### Option 2: Local Server
```bash
# Use Python
python -m http.server 8000

# Or Node
npx http-server

# Then visit: http://localhost:8000/interview-copilot-overlay.html
```

---

## 🔧 Build as Electron App (Full Protection)

### Prerequisites
```bash
# Install Node.js 14+
node --version  # v14.0.0+

# Install global tools
npm install -g electron electron-builder node-gyp
```

### Step 1: Create Project Structure
```
interview-copilot/
├── electron-main.js
├── preload.js
├── interview-copilot-overlay.html
├── package.json
├── binding.gyp
├── native/
│   └── stealth_window.rs
└── node_modules/
```

### Step 2: Install Dependencies
```bash
npm install
```

### Step 3: Build Native Module (macOS only)
```bash
# Install Rust (if not already installed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install neon (Rust-Node bridge)
npm install -g neon-cli

# Build the native module
npm run build
```

### Step 4: Run the App
```bash
npm start
```

### Step 5: Create Distribution
```bash
# Build DMG (macOS), NSIS (Windows), AppImage (Linux)
npm run dist
```

---

## 🔐 Screen Recorder Protection — How It Works

### The `setContentProtection()` Function

**Location:** `electron-main.js` (lines 34-82)

```javascript
function setContentProtection(enable) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  
  contentProtectionEnabled = enable;
  
  if (enable) {
    if (process.platform === 'win32') {
      // Windows: Opacity shield sequence
      mainWindow.setOpacity(0);
      setTimeout(() => {
        applyContentProtection();
        setTimeout(() => mainWindow.setOpacity(1), 50);
      }, 50);
    } else {
      // macOS & Linux
      applyContentProtection();
    }
  }
}
```

### What It Does

| Platform | Method | Result |
|----------|--------|--------|
| **macOS** | `NSWindowSharingNone` (native) | Excluded from CGWindowListCreateImage() |
| **Windows** | DWM protection flag | Excluded from screen capture APIs |
| **Linux** | `override_redirect` + transparency | Not captured by X11 screen tools |

### When Protection Activates
- ✅ App startup (automatically)
- ✅ Window gains focus
- ✅ After user interaction
- ✅ Manual toggle (Cmd+Shift+P on macOS)

### What Gets Hidden
✅ OBS Studio  
✅ ScreenFlow  
✅ QuickTime  
✅ Built-in macOS screenshot (Cmd+Shift+5)  
✅ StreamYard  
✅ Camtasia  
✅ Most third-party recorders  

### What Does NOT Get Hidden
❌ Full-screen screenshots (Cmd+Shift+3)  
❌ Area selection (Cmd+Shift+4)  
❌ Physical camera/phone recording  
❌ Accessibility features (for assistive tech)  

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| **Ctrl+C** | Paste from clipboard → Query AI |
| **Alt+R** | Start voice recording |
| **Cmd+Shift+P** (macOS) | Toggle content protection |
| Right-click | Settings (coming soon) |

---

## 🔑 API Configuration

### Store API Keys in localStorage

```javascript
// NVIDIA NIM
localStorage.setItem('api_nvidia', 'nvapi-xxx');

// Groq
localStorage.setItem('api_groq', 'gsk_xxx');

// Mistral
localStorage.setItem('api_mistral', 'sk-xxx');

// Google Gemini
localStorage.setItem('api_google', 'AIzaSy-xxx');

// Zhipu GLM
localStorage.setItem('api_glm', 'sk-xxx');

// Set current model
localStorage.setItem('copilot_model', 'nvidia');
```

### Get API Keys
1. **NVIDIA NIM** → https://build.nvidia.com/meta/llama2-70b
2. **Groq** → https://console.groq.com
3. **Mistral** → https://console.mistral.ai
4. **Google Gemini** → https://makersuite.google.com/app/apikey
5. **Zhipu GLM** → https://open.bigmodel.cn

---

## 🛠️ Customization

### Change Window Position
In `interview-copilot-overlay.html`, line 41:
```css
.floating-container {
  bottom: 40px;    /* Change this */
  right: 40px;     /* Or this */
}
```

### Adjust Overlay Transparency
Line 34:
```css
background: rgba(0, 0, 0, 0.7);  /* 0.7 = 70% black. Change to 0.5 for lighter */
```

### Change AI System Prompt
In `electron-main.js`, line 277:
```javascript
const systemMsg = 'You are a confident, articulate interview candidate...';
```

### Adjust Response Font Size
In `interview-copilot-overlay.html`, line 154:
```css
.response-text {
  font-size: 18px;  /* Change this */
}
```

---

## 📝 File Reference

### Core Files

| File | Purpose |
|------|---------|
| `interview-copilot-overlay.html` | Main UI (works in browser too) |
| `electron-main.js` | Electron process + **setContentProtection()** |
| `preload.js` | Safe API bridge |
| `stealth_window.rs` | Native macOS protection code |
| `package.json` | Dependencies & build config |
| `binding.gyp` | Native module build config |

### Generated Files (after build)
```
native/
└── build/
    └── Release/
        └── stealth_window.node    ← Compiled native module
```

---

## 🔍 Testing Screen Recorder Protection

### Test 1: OBS Studio
1. Open OBS
2. Add "Window Capture" source
3. Select "Interview Copilot"
4. ❌ Should see black/missing window

### Test 2: QuickTime (macOS)
1. File → New Screen Recording
2. Click record → Select Interview Copilot area
3. ❌ Window should not appear in recording

### Test 3: Built-in Screenshot (macOS)
1. Cmd+Shift+5
2. Try to capture Interview Copilot window
3. ❌ Window excluded from capture list

---

## 🐛 Troubleshooting

### "Content protection error"
**Solution:** On macOS, the native module (stealth_window.node) failed to compile.
```bash
npm run rebuild
```

### "API key not configured"
**Solution:** Set API key in localStorage:
```javascript
localStorage.setItem('api_nvidia', 'your-key');
```

### "Window appears blank"
**Solution:** Check that `interview-copilot-overlay.html` is in the same directory as `electron-main.js`

### "Speech recognition not working"
**Solution:** Browser needs permission. Grant microphone access in:
- Chrome: Settings → Privacy → Microphone
- Safari: System Preferences → Security & Privacy → Microphone

---

## 📦 Distribution

### Create Installer

```bash
# Build for current platform
npm run dist

# Output files:
# macOS:   dist/Interview Copilot.dmg
# Windows: dist/Interview Copilot Setup.exe
# Linux:   dist/interview-copilot-overlay.AppImage
```

### Code Signing (Production)
Edit `package.json`:
```json
"build": {
  "mac": {
    "certificateFile": "path/to/certificate.p12",
    "certificatePassword": "password"
  }
}
```

---

## 📚 Additional Resources

- [Electron Docs](https://www.electronjs.org/docs)
- [objc-rs (Rust Objective-C)](https://docs.rs/objc/)
- [Neon (Rust-Node)](https://neon-bindings.com/)
- [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)

---

## ⚠️ Important Notes

1. **Screen Capture**: This protects from window-specific capture. Full-screen recording (`Cmd+Shift+3`) will still capture the whole display.

2. **Platform Support**:
   - ✅ macOS (full protection via NSWindowSharingNone)
   - ✅ Windows (DWM protection)
   - ⚠️ Linux (partial, via X11)

3. **Ethical Use**: This tool is designed for legitimate interview preparation. Use responsibly and ethically.

4. **Browser vs Electron**: The HTML version works in any browser but has NO screen recorder protection. Use the Electron version for actual interviews.

---

## 📞 Support

For issues or questions:
1. Check this guide for troubleshooting
2. Review the code comments
3. Check Electron documentation
4. Test in Developer Tools (F12)

---

**Built with Electron + Rust + Web Audio API**

Version 1.0.0
