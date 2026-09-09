/**
 * Decklink Output — Blackmagic Decklink SDI çıkış placeholder'ı
 * Coded by Murat Demirci
 *
 * TODO:
 *   - Decklink SDK sarmalayan native addon yaz
 *   - Scheduled playback + pre-roll tamponlama
 *   - Fill+Key ayrı çıkışlarda
 *   - Genlock / referans senkronizasyonu
 */

import { OutputPort } from '../render-pipeline';
import { FrameData } from '../frame-queue';

export class DecklinkOutput implements OutputPort {
  name = 'decklink';

  constructor(
    private deviceIndex: number = 0,
    private keyerMode: 'disabled' | 'internal' | 'external' = 'disabled'
  ) {}

  async initialize(width: number, height: number, fps: number): Promise<void> {
    console.log(`[Decklink] Cihaz ${this.deviceIndex}: ${width}x${height} @ ${fps}fps (keyer: ${this.keyerMode})`);
    console.log(`[Decklink] Henüz implement edilmedi — Decklink SDK bağlı değil`);
  }

  async sendFrame(_frame: FrameData): Promise<void> {
    // TODO: RGBA → BGRA dönüşüm, ScheduleVideoFrame, Fill+Key ayrımı
  }

  async close(): Promise<void> {
    console.log(`[Decklink] Kapatıldı`);
  }
}
