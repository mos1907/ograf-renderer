/**
 * Electron ana süreç - offscreen render + NDI çıkış
 * Murat Demirci
 */

import { app, BrowserWindow, nativeImage } from 'electron';
import { WebSocket } from 'ws';
import * as path from 'path';
import * as fs from 'fs';

const PORT = 4000;

// NDI
let ndi: any = null;
let ndiFillHandle = -1;
let ndiKeyHandle = -1;
const NDI_WIDTH = 1920;
const NDI_HEIGHT = 1080;
const NDI_FPS_N = 25000;
const NDI_FPS_D = 1000;

// NDI runtime'ı PATH'e ekle - şimdilik windows path'i hardcoded, ileride config'e taşınacak
const ndiRuntimeDir = process.env.NDI_RUNTIME_DIR_V6 || 'C:\\Program Files\\NDI\\NDI 6 Runtime\\v6';
if (fs.existsSync(ndiRuntimeDir)) {
  process.env.PATH = ndiRuntimeDir + ';' + (process.env.PATH || '');
}

try {
  const ndiAddonPath = path.join(__dirname, '..', 'src', 'ndi-addon', 'build', 'Release', 'ograf_ndi.node');
  ndi = require(ndiAddonPath);
  ndiFillHandle = ndi.createSender('OGraf Fill', NDI_WIDTH, NDI_HEIGHT, NDI_FPS_N, NDI_FPS_D);
  ndiKeyHandle = ndi.createSender('OGraf Key', NDI_WIDTH, NDI_HEIGHT, NDI_FPS_N, NDI_FPS_D);
  console.log(`[NDI] Fill+Key sender — ${ndi.version()} — ${NDI_WIDTH}×${NDI_HEIGHT}@${NDI_FPS_N / NDI_FPS_D}fps`);
} catch (err: any) {
  console.log(`[NDI] Kullanılamıyor: ${err.message}`);
}

// offscreen rendering için HW accel kapalı olmalı
app.disableHardwareAcceleration();

let offscreenWin: BrowserWindow | null = null;

function startOffscreenRenderer() {
  offscreenWin = new BrowserWindow({
    width: NDI_WIDTH,
    height: NDI_HEIGHT,
    show: false,
    transparent: true,      // key için şart
    backgroundColor: '#00000000',
    webPreferences: {
      offscreen: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  offscreenWin.webContents.setFrameRate(NDI_FPS_N / NDI_FPS_D);

  // preview throttle - her frame'i panele yollamaya gerek yok
  // buraya bir ara tekrar bakicam, belki requestAnimationFrame ile yapilir daha duzgun
  let lastPreviewTime = 0;
  const PREVIEW_INTERVAL = 100;

  // buffer'ları bir kere ayır, her frame'de yeniden allocate etme
  const pixelCount = NDI_WIDTH * NDI_HEIGHT;
  const fillBuf = Buffer.alloc(pixelCount * 4);
  const keyBuf = Buffer.alloc(pixelCount * 4);

  offscreenWin.webContents.on('paint', (_event, _dirty, image) => {
    const bitmap = image.getBitmap();
    const size = image.getSize();
    if (size.width !== NDI_WIDTH || size.height !== NDI_HEIGHT) return;
    if (!ndi || ndiFillHandle < 0) return;

    // fill/key split - saf JS, ~8MB/frame. burada cok ugrastim, sorun olursa native addon'a tasiriz
    for (let i = 0; i < pixelCount * 4; i += 4) {
      const b = bitmap[i], g = bitmap[i + 1], r = bitmap[i + 2], a = bitmap[i + 3];

      fillBuf[i]     = b;
      fillBuf[i + 1] = g;
      fillBuf[i + 2] = r;
      fillBuf[i + 3] = 255;

      keyBuf[i]     = a;
      keyBuf[i + 1] = a;
      keyBuf[i + 2] = a;
      keyBuf[i + 3] = 255;
    }

    ndi.sendFrame(ndiFillHandle, fillBuf);
    ndi.sendFrame(ndiKeyHandle, keyBuf);

    // kontrol paneline preview
    const now = Date.now();
    if (now - lastPreviewTime < PREVIEW_INTERVAL) return;
    lastPreviewTime = now;
    if (!internalWs || internalWs.readyState !== WebSocket.OPEN) return;

    try {
      // nativeImage ile downscale - pahalı ama throttle var, şimdilik idare eder
      const pw = 320, ph = 180;
      const fillImg = nativeImage.createFromBitmap(Buffer.from(fillBuf), { width: NDI_WIDTH, height: NDI_HEIGHT });
      const keyImg = nativeImage.createFromBitmap(Buffer.from(keyBuf), { width: NDI_WIDTH, height: NDI_HEIGHT });

      const fillJpeg = fillImg.resize({ width: pw, height: ph }).toJPEG(60);
      const keyJpeg = keyImg.resize({ width: pw, height: ph }).toJPEG(60);

      internalWs.send(JSON.stringify({
        type: 'fill-key',
        fill: 'data:image/jpeg;base64,' + fillJpeg.toString('base64'),
        key: 'data:image/jpeg;base64,' + keyJpeg.toString('base64'),
      }));
    } catch {}
  });

  // chromium offscreen'de sadece DOM degisince paint oluyor,
  // invalidate() ile zorla repaint tetikliyoruz - workaround ama stabil
  // buna tekrar bir goz atacam, belki MutationObserver ile daha temiz olur
  const frameInterval = 1000 / (NDI_FPS_N / NDI_FPS_D);
  setInterval(() => {
    if (offscreenWin && !offscreenWin.isDestroyed()) {
      offscreenWin.webContents.invalidate();
    }
  }, frameInterval);
}

function loadGraphic(graphic: string) {
  if (!offscreenWin || offscreenWin.isDestroyed()) return;
  offscreenWin.loadURL(`http://localhost:${PORT}/render?graphic=${encodeURIComponent(graphic)}`);
  console.log(`[NDI] Grafik yükleniyor: ${graphic}`);
}

// express server'a ws ile bağlan, template değişikliklerini dinle
let internalWs: WebSocket | null = null;

function connectToServer() {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  internalWs = ws;
  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'load-graphic' && msg.graphic) {
        loadGraphic(msg.graphic);
      }
    } catch {}
  });
  ws.on('error', () => { internalWs = null; });
  ws.on('close', () => {
    internalWs = null;
    setTimeout(connectToServer, 1000); // reconnect - bi ara exponential backoff eklenicek
  });
}

app.whenReady().then(async () => {
  const previewServer = require('./preview-server');

  if (ndi && ndiFillHandle >= 0) {
    previewServer.setNdiStatsProvider(() => ({
      available: true,
      width: NDI_WIDTH, height: NDI_HEIGHT,
      fps: NDI_FPS_N / NDI_FPS_D,
      fill: { connections: ndi.getConnections(ndiFillHandle), tally: ndi.getTally(ndiFillHandle), ...ndi.getStats(ndiFillHandle) },
      key: { connections: ndi.getConnections(ndiKeyHandle), tally: ndi.getTally(ndiKeyHandle), ...ndi.getStats(ndiKeyHandle) },
    }));
  }

  await previewServer.startServer(PORT);

  if (ndiFillHandle >= 0) {
    startOffscreenRenderer();
    loadGraphic('lower-third');
    connectToServer();
    console.log(`[NDI] Offscreen renderer aktif — Fill+Key — ${NDI_WIDTH}×${NDI_HEIGHT}@${NDI_FPS_N / NDI_FPS_D}fps`);

    setInterval(() => {
      if (!ndi || ndiFillHandle < 0) return;
      const s = ndi.getStats(ndiFillHandle);
      console.log(`[NDI] Sent: ${s.framesSent} | Drop: ${s.framesDropped} | Fill conn: ${ndi.getConnections(ndiFillHandle)} | Key conn: ${ndi.getConnections(ndiKeyHandle)}`);
    }, 10000);
  }

  const controlWindow = new BrowserWindow({
    width: 1280, height: 800,
    title: 'OGraf Renderer',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  controlWindow.loadURL(`http://localhost:${PORT}`);
});

app.on('window-all-closed', () => {
  if (ndi) {
    if (ndiFillHandle >= 0) ndi.destroySender(ndiFillHandle);
    if (ndiKeyHandle >= 0) ndi.destroySender(ndiKeyHandle);
  }
  app.quit();
});

process.on('SIGINT', () => {
  if (ndi) {
    if (ndiFillHandle >= 0) ndi.destroySender(ndiFillHandle);
    if (ndiKeyHandle >= 0) ndi.destroySender(ndiKeyHandle);
  }
  app.quit();
});
