/**
 * OGraf Preview Server
 *
 * Express server serving:
 *   - /render — full-resolution OGraf graphic (loaded by offscreen renderer)
 *   - /       — control panel with play/stop/update and fill+key preview
 *   - /api/*  — template listing, manifest info, NDI stats
 *
 * WebSocket for real-time communication between panels.
 */

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { loadOGrafPackage, generateHostPage } from './engine/ograf-loader';

const PORT = 4000;

// ── Express App ──────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// WebSocket server for control communication
const wss = new WebSocketServer({ server });

// Connected clients
const clients = new Set<WebSocket>();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[WS] Client connected (total: ${clients.size})`);

  ws.on('message', (data, isBinary) => {
    if (isBinary) return; // Binary frames no longer processed here

    const msg = JSON.parse(data.toString());
    // Broadcast to all other clients
    for (const client of clients) {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(msg));
      }
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WS] Client disconnected (total: ${clients.size})`);
  });
});

// ── Templates directory ─────────────────────────────────────
const projectRoot = path.join(__dirname, '..');
const templatesDir = path.join(projectRoot, 'templates');
app.use('/templates', express.static(templatesDir));

// Scan templates folder for available OGraf packages
function scanTemplates(): Array<{ id: string; name: string; folder: string }> {
  const results: Array<{ id: string; name: string; folder: string }> = [];
  if (!fs.existsSync(templatesDir)) return results;
  for (const entry of fs.readdirSync(templatesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(templatesDir, entry.name);
    const manifestFile = fs.readdirSync(dir).find(f => f.endsWith('.ograf.json'));
    if (!manifestFile) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, manifestFile), 'utf-8'));
      results.push({ id: entry.name, name: manifest.name || entry.name, folder: entry.name });
    } catch { /* skip broken manifests */ }
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

// Watch templates folder for new/removed templates
let cachedTemplates = scanTemplates();
console.log(`[Templates] Found ${cachedTemplates.length} template(s): ${cachedTemplates.map(t => t.name).join(', ')}`);

fs.watch(templatesDir, { persistent: false }, (eventType, filename) => {
  const updated = scanTemplates();
  if (JSON.stringify(updated) !== JSON.stringify(cachedTemplates)) {
    cachedTemplates = updated;
    console.log(`[Templates] ♻ Rescanned — ${cachedTemplates.length} template(s): ${cachedTemplates.map(t => t.name).join(', ')}`);
    // Notify all control panel clients
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'templates-updated', templates: cachedTemplates }));
      }
    }
  }
});

function resolveTemplateDir(graphicName: string): string {
  const dir = path.join(templatesDir, graphicName);
  if (fs.existsSync(dir)) return dir;
  throw new Error(`Template "${graphicName}" not found in templates/`);
}

// ── Render page (graphic output) ─────────────────────────────
app.get('/render', (req, res) => {
  const graphicPath = (req.query.graphic as string) || 'lower-third';
  try {
    const packageDir = resolveTemplateDir(graphicPath);
    const pkg = loadOGrafPackage(packageDir);
    const hostPage = generateRenderPage(pkg);
    res.type('html').send(hostPage);
  } catch (err: any) {
    res.status(500).send(`Error loading graphic: ${err.message}`);
  }
});

// ── API: list available templates ───────────────────────────
app.get('/api/templates', (req, res) => {
  res.json(cachedTemplates);
});

// ── API: return manifest info (schema, name, defaults) ──────
app.get('/api/manifest', (req, res) => {
  const graphicPath = (req.query.graphic as string) || 'lower-third';
  try {
    const packageDir = resolveTemplateDir(graphicPath);
    const pkg = loadOGrafPackage(packageDir);
    res.json({
      name: pkg.manifest.name,
      schema: pkg.manifest.schema || {},
      defaults: pkg.defaultData,
      stepCount: pkg.manifest.stepCount || 1,
      customActions: pkg.manifest.customActions || [],
      description: pkg.manifest.description || '',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: NDI stats — provider set by Electron main process ──
let ndiStatsProvider: (() => any) | null = null;
export function setNdiStatsProvider(fn: () => any) { ndiStatsProvider = fn; }

app.get('/api/ndi', (_req, res) => {
  if (ndiStatsProvider) return res.json(ndiStatsProvider());
  res.json({ available: false });
});

// ── Control panel page ───────────────────────────────────────
app.get('/', (req, res) => {
  res.type('html').send(getControlPanelHTML());
});

// ── Export for use by Electron main process ────────────────
export { server, wss, clients };

export function startServer(port: number = PORT): Promise<void> {
  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log('');
      console.log('╔══════════════════════════════════════════════════╗');
      console.log('║         OGraf Renderer v0.1                     ║');
      console.log('╠══════════════════════════════════════════════════╣');
      console.log(`║  Control Panel:  http://localhost:${port}          ║`);
      console.log(`║  Render Output:  http://localhost:${port}/render   ║`);
      console.log('╠══════════════════════════════════════════════════╣');
      console.log('║  OGraf v1 spec compliant                        ║');
      console.log('╚══════════════════════════════════════════════════╝');
      console.log('');
      resolve();
    });
  });
}

// Auto-start when run directly (node dist/preview-server.js)
if (require.main === module) {
  startServer();
  process.on('SIGINT', () => {
    console.log('\n[Server] Shutting down...');
    process.exit(0);
  });
}

// ── HTML Generators ──────────────────────────────────────────

function generateRenderPage(pkg: any): string {
  // All templates are served from /templates/
  const folderName = path.basename(pkg.packageDir);
  const moduleUrl = `/templates/${folderName}/${pkg.manifest.main}`;
  const baseUrl = `/templates/${folderName}/`;

  // Generate a valid custom element tag name from the manifest id
  // GUID ids like "96123dd7-..." need to be converted to valid tag names
  const rawId = pkg.manifest.id;
  const isValidTagName = /^[a-z][a-z0-9]*-[a-z0-9-]*$/.test(rawId);
  const tagName = isValidTagName ? rawId : `ograf-graphic-${rawId.replace(/[^a-z0-9-]/gi, '').substring(0, 20).toLowerCase()}`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>OGraf Render — ${pkg.manifest.name}</title>
  <base href="${baseUrl}">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      background: transparent;
    }
    #ograf-host {
      display: block;
      width: 100%;
      height: 100%;
    }
  </style>
</head>
<body>
  <div id="ograf-host"></div>

  <script type="module">
    const tagName = '${tagName}';
    const manifestId = '${rawId}';

    // Import the module
    const mod = await import('${moduleUrl}');

    // If the module exports a default class (Ferryman-style), register it
    if (mod.default && typeof mod.default === 'function' && !customElements.get(tagName)) {
      customElements.define(tagName, mod.default);
    }

    // Wait for the custom element to be defined (either by us or by the module itself)
    const actualTag = customElements.get(tagName) ? tagName : manifestId;
    const resolvedTag = customElements.get(actualTag) ? actualTag : tagName;

    // Create the graphic element
    const host = document.getElementById('ograf-host');
    const ws = new WebSocket('ws://' + location.host);
    const defaultData = ${JSON.stringify(pkg.defaultData)};
    let currentData = { ...defaultData };

    await customElements.whenDefined(resolvedTag);

    // Create (or recreate) a fresh graphic element
    async function createGraphic() {
      host.innerHTML = '';
      const g = document.createElement(resolvedTag);
      g.style.display = 'block';
      g.style.width = '100%';
      g.style.height = '100%';
      host.appendChild(g);
      // API detection:
      // - Native OGraf: has playAction/stopAction but no load() (e.g. scoreboard)
      // - Ferryman: has load() + playAction/stopAction (e.g. headline)
      // - Simple: has play/stop/update (e.g. lower-third)
      const hasOGrafActions = typeof g.playAction === 'function';
      const hasFerrymanLoad = typeof g.load === 'function';

      if (hasFerrymanLoad && hasOGrafActions) {
        await g.load({ data: currentData, renderType: 'realtime' });
        console.log('[OGraf] Ferryman graphic loaded');
        return { el: g, ferryman: true, native: false };
      } else if (hasOGrafActions) {
        // Native OGraf — updateAction sets initial data
        if (typeof g.updateAction === 'function') {
          await g.updateAction({ data: currentData, skipAnimation: true });
        }
        console.log('[OGraf] Native OGraf graphic ready');
        return { el: g, ferryman: false, native: true };
      } else {
        g.update?.(currentData);
        return { el: g, ferryman: false, native: false };
      }
    }

    let gfx = await createGraphic();

    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);

      // Template switch: reload with the new graphic
      if (msg.type === 'load-graphic' && msg.graphic) {
        location.href = '/render?graphic=' + encodeURIComponent(msg.graphic);
        return;
      }

      if (gfx.ferryman || gfx.native) {
        // OGraf action-based API (both Ferryman and native)
        switch (msg.type) {
          case 'play':
            gfx.el.playAction().catch(()=>{});
            break;
          case 'stop':
            await gfx.el.stopAction().catch(()=>{});
            if (gfx.ferryman) {
              // Ferryman needs full recreate after stop
              gfx = await createGraphic();
              console.log('[OGraf] Ferryman graphic recreated');
            }
            break;
          case 'next':
            gfx.el.playAction().catch(()=>{});
            break;
          case 'update':
            currentData = { ...currentData, ...msg.data };
            gfx.el.updateAction({ data: msg.data }).catch(()=>{});
            break;
          case 'custom':
            if (gfx.el.customAction) {
              gfx.el.customAction({ id: msg.actionId }).catch(()=>{});
            }
            break;
        }
      } else {
        switch (msg.type) {
          case 'play':   gfx.el?.play?.();           break;
          case 'stop':   gfx.el?.stop?.();           break;
          case 'next':   gfx.el?.next?.();           break;
          case 'update': gfx.el?.update?.(msg.data); break;
        }
      }
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'render-ready', graphic: resolvedTag }));
    };

    // Fill+Key preview is generated by Electron main process (paint event)
    // and sent via WebSocket — no capture needed in the render page.
  </script>
</body>
</html>`;
}

function getControlPanelHTML(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>OGraf Renderer — Control Panel</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', system-ui, sans-serif;
      background: #1a1a2e;
      color: #e0e0e0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    header {
      background: linear-gradient(135deg, #16213e, #0f3460);
      padding: 20px 30px;
      border-bottom: 2px solid #0078d7;
    }
    header h1 {
      font-size: 24px;
      font-weight: 600;
    }
    header h1 span { color: #00bcf2; }
    header p {
      font-size: 13px;
      color: #888;
      margin-top: 4px;
    }

    .main {
      display: grid;
      grid-template-columns: 1fr 400px;
      gap: 20px;
      padding: 20px;
      flex: 1;
    }

    .preview-section {
      background: #16213e;
      border-radius: 8px;
      overflow: hidden;
    }
    .preview-header {
      padding: 12px 16px;
      background: #0f3460;
      font-size: 13px;
      font-weight: 600;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .preview-tabs {
      display: flex;
      gap: 2px;
    }
    .preview-tab {
      padding: 4px 12px;
      border-radius: 4px;
      background: rgba(255,255,255,0.05);
      cursor: pointer;
      font-size: 12px;
      border: none;
      color: #888;
    }
    .preview-tab.active {
      background: #0078d7;
      color: white;
    }
    .preview-frame {
      position: relative;
      width: 100%;
      padding-bottom: 56.25%; /* 16:9 */
      background: #000;
      overflow: hidden;
    }
    .preview-frame .graphic-host {
      position: absolute;
      top: 0;
      left: 0;
      width: 1920px;
      height: 1080px;
      transform-origin: 0 0;
      /* Scale will be set by JS based on container size */
    }
    .preview-frame.checkerboard {
      background-image:
        linear-gradient(45deg, #333 25%, transparent 25%),
        linear-gradient(-45deg, #333 25%, transparent 25%),
        linear-gradient(45deg, transparent 75%, #333 75%),
        linear-gradient(-45deg, transparent 75%, #333 75%);
      background-size: 20px 20px;
      background-position: 0 0, 0 10px, 10px -10px, -10px 0;
    }

    .control-section {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .panel {
      background: #16213e;
      border-radius: 8px;
      overflow: hidden;
    }
    .panel-header {
      padding: 12px 16px;
      background: #0f3460;
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .panel-body {
      padding: 16px;
    }

    .transport-controls {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
    }
    .transport-btn {
      padding: 14px 8px;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
      text-transform: uppercase;
    }
    .transport-btn:hover { filter: brightness(1.15); }
    .transport-btn:active { transform: scale(0.97); }
    .btn-play { background: #27ae60; color: white; }
    .btn-stop { background: #c0392b; color: white; }
    .btn-next { background: #2980b9; color: white; }
    .btn-update { background: #8e44ad; color: white; }

    .btn-custom { background: #e67e22; color: white; }
    .btn-var { background: #e74c3c; color: white; font-size: 12px; }
    .btn-preset { background: #2c3e50; color: #ecf0f1; font-size: 12px; }
    .btn-preset:hover { background: #34495e; }

    .number-control {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .number-control input {
      text-align: center;
      flex: 1;
    }
    .number-btn {
      width: 36px;
      height: 38px;
      border: 1px solid #2a3a5c;
      border-radius: 4px;
      background: #0d1b36;
      color: white;
      font-size: 18px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .number-btn:hover { background: #1a2d50; }
    .number-btn.plus { color: #27ae60; }
    .number-btn.minus { color: #e74c3c; }

    .preset-row {
      display: flex;
      gap: 4px;
      margin-top: 4px;
    }
    .preset-btn {
      flex: 1;
      padding: 4px 6px;
      border: 1px solid #2a3a5c;
      border-radius: 3px;
      background: #0d1b36;
      color: #888;
      font-size: 11px;
      cursor: pointer;
      text-align: center;
    }
    .preset-btn:hover { background: #1a2d50; color: #00bcf2; }

    .data-field {
      margin-bottom: 12px;
    }
    .data-field label {
      display: block;
      font-size: 12px;
      color: #888;
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .data-field input {
      width: 100%;
      padding: 10px 12px;
      background: #0d1b36;
      border: 1px solid #2a3a5c;
      border-radius: 4px;
      color: white;
      font-size: 15px;
      outline: none;
    }
    .data-field input:focus {
      border-color: #0078d7;
    }

    .stats {
      font-family: 'Consolas', monospace;
      font-size: 12px;
      color: #666;
    }
    .stats div {
      padding: 3px 0;
      display: flex;
      justify-content: space-between;
    }
    .stats .value { color: #00bcf2; }

    .fill-key-preview {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 2px;
    }
    .fill-key-preview .label {
      text-align: center;
      padding: 4px;
      font-size: 11px;
      color: #666;
      text-transform: uppercase;
    }
    .fill-key-preview canvas {
      width: 100%;
      background: #000;
      border-radius: 4px;
    }
  </style>
</head>
<body>
  <header>
    <h1><span>OGraf</span> Renderer</h1>
    <p>EBU OGraf v1 compliant — Fill+Key NDI output — Coded by Murat Demirci</p>
  </header>

  <div class="main">
    <!-- Preview -->
    <div class="preview-section">
      <div class="preview-header">
        <span>OUTPUT PREVIEW</span>
        <div class="preview-tabs">
          <button class="preview-tab active" data-bg="checkerboard">Alpha</button>
          <button class="preview-tab" data-bg="black">Black</button>
          <button class="preview-tab" data-bg="green">Green</button>
        </div>
      </div>
      <div class="preview-frame checkerboard" id="previewFrame">
        <iframe src="/render?graphic=lower-third" id="renderFrame" style="position:absolute;top:0;left:0;width:1920px;height:1080px;border:none;transform-origin:0 0;"></iframe>
      </div>
    </div>

    <!-- Controls -->
    <div class="control-section">
      <!-- Transport (dynamic) -->
      <div class="panel">
        <div class="panel-header">Transport</div>
        <div class="panel-body" id="transportPanel">
          <div class="transport-controls" id="transportButtons">
            <button class="transport-btn btn-play" onclick="send('play')">▶ Play</button>
            <button class="transport-btn btn-stop" onclick="send('stop')">■ Stop</button>
            <button class="transport-btn btn-next" onclick="send('next')">▸ Next</button>
            <button class="transport-btn btn-update" onclick="sendUpdate()">↻ Update</button>
          </div>
        </div>
      </div>

      <!-- Graphic Selector -->
      <div class="panel">
        <div class="panel-header">Graphic <span id="templateCount" style="color:#00bcf2;font-weight:400;"></span></div>
        <div class="panel-body">
          <div class="data-field">
            <label>Template</label>
            <select id="graphicSelect" style="width:100%;padding:10px;background:#0d1b36;border:1px solid #2a3a5c;border-radius:4px;color:white;font-size:14px;" onchange="loadGraphic(this.value)">
              <option value="">Loading...</option>
            </select>
          </div>
          <p style="color:#555;font-size:11px;margin-top:8px;">📁 Drop OGraf packages into <code style="color:#00bcf2;">templates/</code> folder — auto-detected</p>
        </div>
      </div>

      <!-- Data (dynamically generated from manifest schema) -->
      <div class="panel">
        <div class="panel-header">Graphic Data</div>
        <div class="panel-body" id="dataFields">
          <p style="color:#666;font-size:13px;">Select a template to see data fields</p>
        </div>
      </div>

      <!-- Fill+Key Preview -->
      <div class="panel">
        <div class="panel-header">Fill + Key</div>
        <div class="panel-body">
          <div class="fill-key-preview">
            <div>
              <div class="label">Fill (RGB)</div>
              <canvas id="fillCanvas" width="320" height="180"></canvas>
            </div>
            <div>
              <div class="label">Key (Alpha)</div>
              <canvas id="keyCanvas" width="320" height="180"></canvas>
            </div>
          </div>
        </div>
      </div>

      <!-- Pipeline Stats -->
      <div class="panel">
        <div class="panel-header">Pipeline Stats</div>
        <div class="panel-body stats" id="pipelineStats">
          <div><span>Status</span><span class="value">Ready</span></div>
          <div><span>Resolution</span><span class="value">1920×1080</span></div>
          <div><span>Frame Rate</span><span class="value">25 fps</span></div>
          <div><span>Buffer</span><span class="value">4 frames</span></div>
          <div><span>Output</span><span class="value">Preview + NDI</span></div>
          <div><span>NDI</span><span class="value" id="ndiStatus" style="color:#888">Checking...</span></div>
          <div><span>NDI Sent</span><span class="value" id="ndiSent">0</span></div>
          <div><span>NDI Connections</span><span class="value" id="ndiConns">0</span></div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const ws = new WebSocket('ws://' + location.host);
    ws.onopen = () => console.log('[Control] Connected');

    function send(type) {
      ws.send(JSON.stringify({ type }));
    }

    function sendCustomAction(actionId) {
      ws.send(JSON.stringify({ type: 'custom', actionId }));
      // Auto-sync: if action matches a score field, update the UI too
      const scoreMap = {
        'goal-home': 'homeScore',
        'goal-away': 'awayScore'
      };
      const scoreField = scoreMap[actionId];
      if (scoreField) {
        const input = document.querySelector('[data-key="' + scoreField + '"]');
        if (input) {
          input.value = parseInt(input.value || 0) + 1;
        }
      }
    }

    // +/- buttons for number fields
    function adjField(key, delta, min, max) {
      const input = document.querySelector('[data-key="' + key + '"]');
      if (!input) return;
      let val = parseInt(input.value || 0) + delta;
      if (val < min) val = min;
      if (val > max) val = max;
      input.value = val;
      sendUpdate();
    }

    // Preset value for a field
    function setField(key, value) {
      const input = document.querySelector('[data-key="' + key + '"]');
      if (!input) return;
      input.value = value;
      sendUpdate();
    }

    function sendUpdate() {
      const data = {};
      document.querySelectorAll('#dataFields input, #dataFields textarea').forEach(input => {
        const key = input.dataset.key;
        if (!key || key.endsWith('-text')) return; // skip color text mirrors
        const fieldType = input.dataset.fieldType;
        if (fieldType === 'integer') {
          data[key] = parseInt(input.value) || 0;
        } else {
          data[key] = input.value;
        }
      });
      ws.send(JSON.stringify({ type: 'update', data }));
    }

    // Scale iframe to fit preview
    function scaleIframe() {
      const frame = document.getElementById('previewFrame');
      const iframe = document.getElementById('renderFrame');
      if (!frame || !iframe) return;
      const scale = frame.clientWidth / 1920;
      iframe.style.transform = 'scale(' + scale + ')';
    }
    scaleIframe();
    window.addEventListener('resize', scaleIframe);
    new ResizeObserver(scaleIframe).observe(document.getElementById('previewFrame'));

    // Build dynamic transport buttons + data fields from manifest
    async function buildUI(graphicName) {
      const dataContainer = document.getElementById('dataFields');
      const transportContainer = document.getElementById('transportButtons');
      dataContainer.innerHTML = '<p style="color:#666;font-size:13px;">Loading...</p>';

      try {
        const resp = await fetch('/api/manifest?graphic=' + encodeURIComponent(graphicName));
        const info = await resp.json();

        // ── Transport buttons ──────────────────────────
        let btns = '<button class="transport-btn btn-play" onclick="send(&quot;play&quot;)">▶ Play</button>';
        btns += '<button class="transport-btn btn-stop" onclick="send(&quot;stop&quot;)">■ Stop</button>';

        // Next button (only if stepCount > 1)
        if (info.stepCount > 1) {
          btns += '<button class="transport-btn btn-next" onclick="send(&quot;next&quot;)">▸ Next <span style="font-size:11px;opacity:0.7;">(' + info.stepCount + ' steps)</span></button>';
        }

        btns += '<button class="transport-btn btn-update" onclick="sendUpdate()">↻ Update</button>';

        // Custom actions from manifest
        if (info.customActions && info.customActions.length > 0) {
          info.customActions.forEach(action => {
            btns += '<button class="transport-btn btn-custom" onclick="sendCustomAction(&quot;' + action.id + '&quot;)" title="' + (action.description || '') + '">⚡ ' + action.name + '</button>';
            // Add VAR (undo) button for goal actions
            if (action.id.startsWith('goal-')) {
              const side = action.id.replace('goal-', '');
              const scoreKey = side + 'Score';
              btns += '<button class="transport-btn btn-var" onclick="adjField(&quot;' + scoreKey + '&quot;,-1,0,Infinity)" title="VAR: Cancel ' + action.name + '">🔴 VAR ' + side.charAt(0).toUpperCase() + side.slice(1) + '</button>';
            }
          });
        }

        transportContainer.innerHTML = btns;
        // Adjust grid based on button count
        const btnCount = transportContainer.querySelectorAll('button').length;
        transportContainer.style.gridTemplateColumns = btnCount <= 4 ? 'repeat(4, 1fr)' : 'repeat(3, 1fr)';

        // ── Data fields ────────────────────────────────
        if (!info.schema || !info.schema.properties) {
          dataContainer.innerHTML = '<p style="color:#666;font-size:13px;">No data fields</p>';
          return;
        }
        const props = info.schema.properties;
        const keys = Object.keys(props).sort((a, b) => (props[a].order ?? 999) - (props[b].order ?? 999));
        dataContainer.innerHTML = '';

        for (const key of keys) {
          const prop = props[key];
          const label = prop.label || key;
          const defaultVal = info.defaults?.[key] ?? prop.default ?? '';
          const div = document.createElement('div');
          div.className = 'data-field';

          let inputHtml = '';
          if (prop.gddType === 'color-rrggbb') {
            // Color picker
            inputHtml = '<div style="display:flex;gap:8px;align-items:center;">' +
              '<input type="color" data-key="' + key + '" data-field-type="string" value="' + defaultVal + '" style="width:50px;height:38px;border:1px solid #2a3a5c;border-radius:4px;background:#0d1b36;cursor:pointer;">' +
              '<input type="text" data-key="' + key + '-text" value="' + defaultVal + '" style="flex:1;" oninput="this.previousElementSibling.value=this.value" readonly>' +
              '</div>';
          } else if (prop.type === 'integer' || prop.type === 'number') {
            // Number input with +/- buttons
            const min = prop.minimum !== undefined ? ' min="' + prop.minimum + '"' : '';
            const max = prop.maximum !== undefined ? ' max="' + prop.maximum + '"' : '';
            const minVal = prop.minimum ?? -Infinity;
            const maxVal = prop.maximum ?? Infinity;
            inputHtml = '<div class="number-control">' +
              '<button class="number-btn minus" onclick="adjField(&quot;' + key + '&quot;,-1,' + minVal + ',' + maxVal + ')">−</button>' +
              '<input type="number" data-key="' + key + '" data-field-type="integer" value="' + defaultVal + '"' + min + max + '>' +
              '<button class="number-btn plus" onclick="adjField(&quot;' + key + '&quot;,1,' + minVal + ',' + maxVal + ')">+</button>' +
              '</div>';
            // Add presets for minute-like fields
            if (key === 'minute' || key.includes('minute')) {
              inputHtml += '<div class="preset-row">' +
                '<button class="preset-btn" onclick="setField(&quot;' + key + '&quot;,0)">0′</button>' +
                '<button class="preset-btn" onclick="setField(&quot;' + key + '&quot;,45)">45′</button>' +
                '<button class="preset-btn" onclick="setField(&quot;' + key + '&quot;,90)">90′</button>' +
                '</div>';
            }
          } else if (prop.gddType === 'multi-line') {
            inputHtml = '<textarea data-key="' + key + '" data-field-type="string" rows="3" style="width:100%;padding:10px 12px;background:#0d1b36;border:1px solid #2a3a5c;border-radius:4px;color:white;font-size:15px;outline:none;resize:vertical;font-family:inherit;">' + String(defaultVal).replace(/</g, '&lt;') + '</textarea>';
          } else {
            const maxLen = prop.maxLength ? ' maxlength="' + prop.maxLength + '"' : '';
            inputHtml = '<input type="text" data-key="' + key + '" data-field-type="string" value="' + String(defaultVal).replace(/"/g, '&quot;') + '"' + maxLen + '>';
          }

          div.innerHTML = '<label>' + label + (prop.description ? ' <span style="color:#555;font-size:11px;font-weight:400;">(' + prop.description + ')</span>' : '') + '</label>' + inputHtml;
          dataContainer.appendChild(div);
        }

        // Color picker sync: when color input changes, update text display
        dataContainer.querySelectorAll('input[type="color"]').forEach(colorInput => {
          colorInput.addEventListener('input', () => {
            const textInput = colorInput.nextElementSibling;
            if (textInput) textInput.value = colorInput.value;
          });
        });

        // Auto-update: debounce on typing
        let debounceTimer;
        dataContainer.querySelectorAll('input, textarea').forEach(input => {
          input.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendUpdate(); });
          input.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(sendUpdate, 500);
          });
        });
      } catch (err) {
        dataContainer.innerHTML = '<p style="color:#c0392b;font-size:13px;">Error loading schema</p>';
      }
    }

    // Graphic selector
    function loadGraphic(name) {
      document.getElementById('renderFrame').src = '/render?graphic=' + name;
      // Tell any standalone /render windows to switch template too
      ws.send(JSON.stringify({ type: 'load-graphic', graphic: name }));
      buildUI(name);
    }

    // Populate template dropdown from API
    async function loadTemplateList() {
      try {
        const resp = await fetch('/api/templates');
        const templates = await resp.json();
        const select = document.getElementById('graphicSelect');
        const currentVal = select.value;
        select.innerHTML = '';
        templates.forEach(t => {
          const opt = document.createElement('option');
          opt.value = t.id;
          opt.textContent = t.name;
          select.appendChild(opt);
        });
        // Restore previous selection or pick first
        if (currentVal && templates.some(t => t.id === currentVal)) {
          select.value = currentVal;
        } else if (templates.length > 0) {
          select.value = templates[0].id;
          loadGraphic(templates[0].id);
        }
        document.getElementById('templateCount').textContent = '(' + templates.length + ')';
      } catch(e) { console.error('Failed to load templates', e); }
    }

    // Listen for template folder changes via WebSocket
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'templates-updated') {
        console.log('[Control] Templates updated!', msg.templates);
        loadTemplateList();
      }
    });

    // Initial load
    loadTemplateList().then(() => {
      const select = document.getElementById('graphicSelect');
      if (select.value) buildUI(select.value);
    });

    // Preview background toggle
    document.querySelectorAll('.preview-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.preview-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const frame = document.getElementById('previewFrame');
        frame.className = 'preview-frame';
        const bg = tab.dataset.bg;
        if (bg === 'checkerboard') frame.classList.add('checkerboard');
        else if (bg === 'green') frame.style.background = '#00ff00';
        else frame.style.background = '#000';
      });
    });

    // ── Fill + Key display (receives frames from render page via WS) ──
    const fillCanvas = document.getElementById('fillCanvas');
    const keyCanvas = document.getElementById('keyCanvas');
    const fillCtx = fillCanvas.getContext('2d');
    const keyCtx = keyCanvas.getContext('2d');

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'fill-key') {
          // Draw fill image
          const fillImg = new Image();
          fillImg.onload = () => fillCtx.drawImage(fillImg, 0, 0, 320, 180);
          fillImg.src = msg.fill;
          // Draw key image
          const keyImg = new Image();
          keyImg.onload = () => keyCtx.drawImage(keyImg, 0, 0, 320, 180);
          keyImg.src = msg.key;
        }
      } catch(e) {}
    });

    // NDI stats polling
    async function pollNdiStats() {
      try {
        const resp = await fetch('/api/ndi');
        const info = await resp.json();
        const statusEl = document.getElementById('ndiStatus');
        const sentEl = document.getElementById('ndiSent');
        const connsEl = document.getElementById('ndiConns');
        if (!info.available) {
          statusEl.textContent = 'Not available';
          statusEl.style.color = '#c0392b';
        } else {
          statusEl.textContent = info.width + '×' + info.height + ' @ ' + info.fps + 'fps';
          statusEl.style.color = info.connections > 0 ? '#27ae60' : '#00bcf2';
          sentEl.textContent = info.framesSent.toLocaleString();
          connsEl.textContent = info.connections + (info.tally?.onProgram ? ' (PGM)' : info.tally?.onPreview ? ' (PVW)' : '');
        }
      } catch(e) {}
    }
    pollNdiStats();
    setInterval(pollNdiStats, 2000);

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      switch(e.key) {
        case 'F1': e.preventDefault(); window.send('play'); break;
        case 'F2': e.preventDefault(); window.send('stop'); break;
        case 'F3': e.preventDefault(); window.send('next'); break;
        case 'F4': e.preventDefault(); window.sendUpdate(); break;
      }
    });
  </script>
</body>
</html>`;
}
