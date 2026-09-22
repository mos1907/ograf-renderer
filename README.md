# OGraf Renderer

Broadcast grafik render motoru. EBU OGraf v1 template'lerini alıp Fill+Key NDI olarak çıkış verir.

Electron'un offscreen rendering özelliğiyle Chromium'dan direkt BGRA piksel alıyoruz, sonra fill/key ayırıp iki ayrı NDI stream olarak gönderiyoruz. Kontrol paneli Express üzerinde çalışıyor, template'ler otomatik algılanıyor.

## Kurulum

Node.js 18+, [NDI SDK v6](https://ndi.video/download-ndi-sdk/) ve [NDI Runtime v6](https://ndi.video/download-ndi-runtime/) gerekli.

```bash
npm install
cd src/ndi-addon && npx node-gyp rebuild && cd ../..
npm start
```

`http://localhost:4000` kontrol paneli, NDI tarafında "OGraf Fill" ve "OGraf Key" olarak görünür.

## Nasıl çalışıyor

Electron offscreen BrowserWindow açıyor (1920x1080, görünmez). Template o pencerede render ediliyor. Her paint event'te BGRA buffer geliyor, biz de fill (RGB opak) ve key (alpha→luma) olarak ayırıp NDI'dan yolluyoruz.

```
Electron
├── Express :4000 (panel + render sayfası)
└── Offscreen BrowserWindow
    └── paint event → BGRA → fill/key split → NDI
```

## Template ekleme

`templates/` klasörüne OGraf paketi at, otomatik algılanır:

```
templates/my-graphic/
├── graphic.ograf.json   (manifest)
└── graphic.mjs          (web component)
```

Üç farklı API destekleniyor: Ferryman (load+playAction), native OGraf (playAction/stopAction) ve basit (play/stop/update).

## Grafik oluşturma

Template'leri birkaç farklı yolla oluşturabilirsiniz:

**After Effects yolu:** AE'de tasarla → Bodymovin ile Lottie JSON export → [Ferryman](https://streamshapers.com)'da OGraf paketi oluştur

**OGraf Studio:** [ZeroDensity'nin açık kaynak editörü](https://github.com/zerodensity/ograf-studio). Browser'da çalışıyor, doğrudan OGraf paketi export ediyor. Lottie animasyonları, vektör düzenleme, AI desteği var. After Effects lisansı gerektirmiyor.

**Elle yazım:** Vanilla HTML/CSS/JS ile Web Component yaz, play/stop/update metodlarını tanımla.

Detaylı pipeline için: [Pipeline Overview](https://mos1907.github.io/ograf-renderer/pipeline.html)

## Scriptler

- `npm start` — derle + Electron ile çalıştır (NDI aktif)
- `npm run preview` — sadece Express server (NDI yok)
- `npm run build` — TypeScript derle

## Yapılacaklar

- Decklink SDI çıkış (native addon)
- ST 2110 çıkış
- [MOS Gateway](https://github.com/mos1907/MosOnGo) entegrasyonu — iNews/ENPS/Octopus rundown'larından grafik tetikleme
- Çoklu kanal desteği
- GPI tetikleme
- Playlist/sıralı playout

## Linkler

- [EBU OGraf Spec](https://ograf.ebu.io/)
- [NDI SDK](https://ndi.video/download-ndi-sdk/)
- [OGraf Studio](https://github.com/zerodensity/ograf-studio)
- [StreamShapers Ferryman](https://streamshapers.com)

## Lisans

MIT
