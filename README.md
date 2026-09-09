# OGraf Renderer

EBU OGraf v1 compliant broadcast graphics renderer with NDI output. Renders HTML/CSS/JS graphic templates at 1080p25 and outputs Fill+Key over NDI — the same architecture used by professional broadcast graphics engines.

## Features

- **NDI Fill+Key output** — two separate NDI streams (Fill and Key) at 1920×1080@25fps
- **Electron offscreen rendering** — headless Chromium captures frames via paint event, no screen capture hacks
- **Template hot-reload** — drop OGraf packages into `templates/` and they appear instantly
- **Web control panel** — transport controls, data fields, and fill+key preview generated from manifest schema
- **Three OGraf API modes** — Ferryman (load + playAction), native OGraf (playAction), and simple (play/stop/update)
- **Native NDI addon** — C++ N-API wrapper around NDI SDK v6 with dedicated send thread and frame queue

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [NDI SDK v6](https://ndi.video/download-ndi-sdk/) (for NDI output)
- [NDI Runtime v6](https://ndi.video/download-ndi-runtime/) (on receiving machines)

## Quick Start

```bash
npm install
npm start
```

This starts:
- Express server on `http://localhost:4000` (control panel + render page)
- Electron offscreen renderer capturing frames at 25fps
- NDI Fill+Key senders visible as **"OGraf Fill"** and **"OGraf Key"** in any NDI receiver

## NDI Output

The renderer outputs two separate NDI streams, matching the Fill+Key workflow used in broadcast:

| Stream | Content |
|--------|---------|
| **OGraf Fill** | RGB graphic composited on black, fully opaque |
| **OGraf Key** | Alpha channel as grayscale luma key (white = visible, black = transparent) |

Connect both to your mixer's Fill+Key inputs to overlay graphics with proper transparency.

### Building the NDI Addon

The native addon needs to be compiled once after cloning:

```bash
cd src/ndi-addon
npx node-gyp rebuild
```

Requires NDI SDK v6 installed at `C:\Program Files\NDI\NDI 6 SDK` (Windows).

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Electron Main Process                                   │
│                                                         │
│  ┌──────────────┐    ┌─────────────────────────────┐    │
│  │ Express      │    │ Offscreen BrowserWindow      │    │
│  │ Server       │◄───│ (1920×1080, headless)        │    │
│  │ :4000        │    │                              │    │
│  │              │    │ paint event                   │    │
│  │ /render ─────┼───►│   ├─► BGRA pixel buffer      │    │
│  │ /  (panel)   │    │   │                          │    │
│  │ /api/*       │    │   ├─► Fill (RGB on black)     │──►│ NDI "OGraf Fill"
│  └──────────────┘    │   │                          │    │
│                      │   └─► Key (alpha as luma)     │──►│ NDI "OGraf Key"
│                      └─────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

## Creating Templates

See the [Pipeline Overview](https://mos1907.github.io/ograf-renderer/pipeline.html) for the full workflow from After Effects to the templates folder.

### Adding a Template

Copy any OGraf-compliant package folder into `templates/`:

```
templates/
├── lower-third/
│   ├── graphic.ograf.json   ← manifest
│   └── graphic.mjs          ← web component
├── ograf-example-headline/
└── ograf-example-scoreboard/
```

Templates are detected automatically via file watching — no restart needed.

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Build + run with Electron (NDI output active) |
| `npm run preview` | Build + run Express server only (no NDI, no Electron) |
| `npm run build` | Compile TypeScript |

## TODO

- [ ] Blackmagic Decklink SDI output (native addon wrapping Decklink SDK)
- [ ] ST 2110 output
- [ ] Multiple channel support (simultaneous graphics on different NDI streams)
- [ ] Audio pass-through
- [ ] GPI trigger input
- [ ] Playlist / rundown integration

## Resources

- [EBU OGraf Specification](https://ograf.ebu.io/)
- [NDI SDK](https://ndi.video/download-ndi-sdk/)
- [StreamShapers Ferryman](https://streamshapers.com)
- [Lottie / Bodymovin](https://airbnb.io/lottie/)

## License

MIT
