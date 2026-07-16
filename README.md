# Interview Copilot

Real-time interview assistant that runs as a transparent, always-on-top Electron overlay. Captures your microphone (and optional system audio), transcribes speech using Web Speech API, and queries AI models for suggested answers — all while keeping the window hidden from screen recorders.

## Features

- **Voice recording** — Local mic capture with optional system audio loopback via `getDisplayMedia`
- **Speech-to-text** — Real-time transcription using `webkitSpeechRecognition` with interim results
- **AI-assisted answers** — Queries NVIDIA NIM, Groq, Mistral, or OpenRouter when a question is detected
- **Phone relay** — Launches Edge as a standalone `--app` window to capture phone call audio through a WebSocket relay
- **Global push-to-mute** — `Alt+Z` toggles mute system-wide (works even when overlay is unfocused)
- **Shortcuts** — `Alt+R` toggles recording, `Ctrl+M` pastes clipboard + queries AI, `Ctrl+Q/J/K` opens panels
- **Content protection** — Uses `BrowserWindow.setContentProtection()` to block screen capture
- **Context management** — Save/load/delete context snippets and include them with AI queries

## Relay Server Setup

This project requires a connection to the **relaytest** repository to function correctly. 

### 1. Hosting on Render
The relay repository must be actively hosted on [Render](https://render.com/).

* **Relay URL:** `yourwebsite.onrender.com`

### 2. Environment Variables (`.env`)
You must configure a shared secret key exchange to authenticate your local clients (like the Electron overlay or Edge phone) with the hosted relay server.

Configure the identical `RELAY_SECRET` in **two places**:

1. **Your Local `.env` File:**
2. **OnRender Dashboard:**
Under your service's **Environment Variables**, add:
* `RELAY_SECRET` = `your-64-char-hex-secret-here`

> 🔑 **Security Note:** The `RELAY_SECRET` must be a pre-agreed 256-bit, 64-character hex string (e.g., generated via `openssl rand -hex 32`). When clients connect to the relay via WebSocket (`wss://yourwebsite.onrender.com?role=electron&secret=...`), the server validates this incoming secret. If they match, the client is authenticated to send/receive transcripts; otherwise, the connection is rejected.
## Architecture

```
Edge (--app) ──mic──> WebSocket Relay <──electron──> Electron Overlay
                                                           │
                                                    Local mic capture
                                                    (getUserMedia + loopback)
                                                           │
                                                    webkitSpeechRecognition
                                                           │
                                                    AI model (NVIDIA/Groq/etc.)
```

## Setup

1. Install dependencies:
   ```
   pnpm install
   ```

2. Create `.env` in the project root:
   ```
   RELAY_URL=wss://your-relay-server.onrender.com
   RELAY_SECRET=your-secret
   ```

3. Configure API keys in the overlay UI (Ctrl+Q to open model panel).

4. Start:
   ```
   pnpm start
   ```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt+R` | Toggle voice recording |
| `Alt+Z` | Toggle mute (global) |
| `Ctrl+Q` | Model selection panel |
| `Ctrl+J` | Code input panel |
| `Ctrl+K` | Context management panel |
| `Ctrl+M` | Paste clipboard + query AI |
| `Esc` | Close active panel |

## Build

```
pnpm run dist
```

Produces installer packages for Windows (NSIS), macOS (DMG), and Linux (AppImage).
