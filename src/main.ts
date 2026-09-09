/**
 * OGraf Renderer — Electron Ana Süreç
 * Coded by Murat Demirci
 *
 * Mimari:
 *   1. Express server → kontrol paneli + OGraf render sayfası
 *   2. Offscreen BrowserWindow → render sayfasını görünmez pencerede yükler
 *   3. Paint event → ham BGRA piksel buffer → Fill+Key ayrımı → NDI çıkış
 */

import { app, BrowserWindow, nativeImage } from 'electron';
import { WebSocket } from 'ws';
import * as path from 'path';
import * as fs from 'fs';

const PORT = 4000;

// ── NDI ────────────────────────────────────────────────────
let ndi: any = null;
let ndiFillHandle = -1;
let ndiKeyHandle = -1;
const NDI_WIDTH = 1920;
const NDI_HEIGHT = 1080;
const NDI_FPS_N = 25000;
const NDI_FPS_D = 1000;

// NDI Runtime DLL'ini PATH'e ekle
// DIPNOT: NDI SDK path'i şimdilik hardcoded Windows yolu.
// İleride: (1) cross-platform destek için platform detection ekle,
// (2) config dosyasından oku, veya (3) NDI_RUNTIME_DIR_V6 env var yeterli olabilir.
const ndiRuntimeDir = process.env.NDI_RUNTIME_DIR_V6 || 'C:\\Program Files\\NDI\\NDI 6 Runtime\\v6';
if (fs.existsSync(ndiRuntimeDir)) {
  process.env.PATH = ndiRuntimeDir + ';' + (process.env.PATH || '');
}

try {
  const ndiAddonPath = path.join(__dirname, '..', 'src', 'ndi-addon', 'build', 'Release', 'ograf_ndi.node');
  ndi = require(ndiAddonPath);
  // İki ayrı NDI kanal: Fill ve Key
  ndiFillHandle = ndi.createSender('OGraf Fill', NDI_WIDTH, NDI_HEIGHT, NDI_FPS_N, NDI_FPS_D);
  ndiKeyHandle = ndi.createSender('OGraf Key', NDI_WIDTH, NDI_HEIGHT, NDI_FPS_N, NDI_FPS_D);
  console.log(`[NDI] Fill+Key sender oluşturuldu — ${ndi.version()} — ${NDI_WIDTH}×${NDI_HEIGHT}@${NDI_FPS_N / NDI_FPS_D}fps`);
} catch (err: any) {
  console.log(`[NDI] Kullanılamıyor: ${err.message}`);
}

// ── Electron ───────────────────────────────────────────────
// NOT: Offscreen rendering için hardware acceleration kapatılmalı.
// İleride GPU-accelerated offscreen rendering desteklenirse bu satır kaldırılabilir.
// Alternatif: --disable-gpu flag'i ile de yapılabilir ama bu daha güvenli.
app.disableHardwareAcceleration();

let offscreenWin: BrowserWindow | null = null;

function startOffscreenRenderer() {
  offscreenWin = new BrowserWindow({
    width: NDI_WIDTH,
    height: NDI_HEIGHT,
    show: false,           // Pencere görünmez — sadece piksel üretimi için
    transparent: true,     // Transparan arka plan — key için şart
    backgroundColor: '#00000000',
    webPreferences: {
      offscreen: true,     // Chromium offscreen modu
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  offscreenWin.webContents.setFrameRate(NDI_FPS_N / NDI_FPS_D);

  // Fill+Key önizleme: her frame değil, ~100ms'de bir gönder (performans için)
  let lastPreviewTime = 0;
  const PREVIEW_INTERVAL = 100;

  // Fill+Key buffer'ları önceden ayır (GC baskısını azalt)
  const pixelCount = NDI_WIDTH * NDI_HEIGHT;
  const fillBuf = Buffer.alloc(pixelCount * 4);
  const keyBuf = Buffer.alloc(pixelCount * 4);

  // Chromium her frame çizdiğinde bu event tetiklenir
  // Ham BGRA piksel buffer'ı alıyoruz — ekran yakalama değil, doğrudan render çıktısı
  offscreenWin.webContents.on('paint', (_event, _dirty, image) => {
    const bitmap = image.getBitmap(); // BGRA formatında ham piksel verisi
    const size = image.getSize();
    if (size.width !== NDI_WIDTH || size.height !== NDI_HEIGHT) return;
    if (!ndi || ndiFillHandle < 0) return;

    // BGRA buffer'dan Fill ve Key ayır
    // DIPNOT: Bu döngü her frame'de ~8M piksel işliyor (1920×1080×4 byte).
    // Şu an saf JS ile yapıyoruz — performans yeterliyse dokunma.
    // İleride sorun olursa: (1) WASM ile SIMD optimizasyonu, (2) GPU compute shader,
    // veya (3) native addon'a taşıyıp C++ tarafında split yapılabilir.
    for (let i = 0; i < pixelCount * 4; i += 4) {
      const b = bitmap[i], g = bitmap[i + 1], r = bitmap[i + 2], a = bitmap[i + 3];

      // Fill: RGB grafik siyah zemin üzerinde, tam opak
      fillBuf[i]     = b;
      fillBuf[i + 1] = g;
      fillBuf[i + 2] = r;
      fillBuf[i + 3] = 255;

      // Key: alpha kanalı grayscale olarak (beyaz = görünür, siyah = şeffaf)
      keyBuf[i]     = a;
      keyBuf[i + 1] = a;
      keyBuf[i + 2] = a;
      keyBuf[i + 3] = 255;
    }

    // Her iki kanala ayrı ayrı gönder
    ndi.sendFrame(ndiFillHandle, fillBuf);
    ndi.sendFrame(ndiKeyHandle, keyBuf);

    // Kontrol paneline önizleme gönder (throttled)
    const now = Date.now();
    if (now - lastPreviewTime < PREVIEW_INTERVAL) return;
    lastPreviewTime = now;
    if (!internalWs || internalWs.readyState !== WebSocket.OPEN) return;

    try {
      // DIPNOT: Preview için her seferinde nativeImage oluşturup resize ediyoruz.
      // Bu pahalı bir işlem ama throttle (100ms) sayesinde ~10fps ile sınırlı.
      // İleride: (1) Sharp/canvas ile daha hızlı downscale, (2) WebGL preview,
      // veya (3) ayrı bir worker thread'e taşınabilir.
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

  // DIPNOT: Chromium offscreen modda sadece DOM değiştiğinde paint event fırlatır.
  // invalidate() ile zorla repaint tetikliyoruz — bu bir workaround.
  // İleride Chromium'un "continuous painting" API'si stabilleşirse
  // veya requestAnimationFrame tabanlı bir mekanizma bulunursa bu timer kaldırılabilir.
  // Şimdilik bu yöntem stabil çalışıyor ve frame timing tutarlı.
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

// Express server'a WebSocket ile bağlan — template değişikliklerini dinle
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
    setTimeout(connectToServer, 1000); // Bağlantı koparsa tekrar dene
  });
}

app.whenReady().then(async () => {
  // Express server'ı başlat
  const previewServer = require('./preview-server');

  // NDI istatistiklerini Express API'ye bağla
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

  // NDI offscreen renderer'ı başlat
  if (ndiFillHandle >= 0) {
    startOffscreenRenderer();
    loadGraphic('lower-third');
    connectToServer();
    console.log(`[NDI] Offscreen renderer aktif — Fill+Key — ${NDI_WIDTH}×${NDI_HEIGHT}@${NDI_FPS_N / NDI_FPS_D}fps`);

    // Periyodik istatistik logla
    setInterval(() => {
      if (!ndi || ndiFillHandle < 0) return;
      const s = ndi.getStats(ndiFillHandle);
      console.log(`[NDI] Gönderilen: ${s.framesSent} | Düşen: ${s.framesDropped} | Fill bağlantı: ${ndi.getConnections(ndiFillHandle)} | Key bağlantı: ${ndi.getConnections(ndiKeyHandle)}`);
    }, 10000);
  }

  // Kontrol panelini görünür pencerede aç
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
