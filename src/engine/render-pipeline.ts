/**
 * Render Pipeline — renderer ile çıkış portlarını bağlar
 * Coded by Murat Demirci
 *
 * Akış: BrowserWindow (Chromium) → FrameQueue → Output (preview / decklink / NDI)
 * Fill+Key: RGBA frame → RGB fill + alpha-as-luma key
 */

import { FrameQueue, FrameData } from './frame-queue';

export interface OutputPort {
  name: string;
  initialize(width: number, height: number, fps: number): Promise<void>;
  sendFrame(frame: FrameData): Promise<void>;
  close(): Promise<void>;
}

export interface FillKeyPair {
  fill: FrameData;
  key: FrameData;
}

export interface PipelineConfig {
  width: number;
  height: number;
  fps: number;
  bufferDepth: number;
}

export class RenderPipeline {
  private frameQueue: FrameQueue;
  private outputs: OutputPort[] = [];
  private running = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private config: PipelineConfig;
  private scheduledTime = 0;
  private frameCount = 0;

  constructor(config: PipelineConfig) {
    this.config = config;
    this.frameQueue = new FrameQueue(config.bufferDepth);
  }

  addOutput(output: OutputPort): void {
    this.outputs.push(output);
  }

  getFrameQueue(): FrameQueue {
    return this.frameQueue;
  }

  async start(): Promise<void> {
    if (this.running) return;

    for (const output of this.outputs) {
      await output.initialize(this.config.width, this.config.height, this.config.fps);
    }

    // Pre-roll tamponlama — çıkış başlamadan önce kuyruğu doldur
    this.frameQueue.preroll(this.config.width, this.config.height);
    this.running = true;
    this.scheduledTime = Date.now();

    // DIPNOT: setInterval ile frame timing yapıyoruz — JS timer'ları ±2ms sapabilir.
    // İleride: (1) worker_threads + MessagePort ile daha hassas timing,
    // (2) native addon'da high-resolution timer, veya (3) NDI clock'a bağlanma denenebilir.
    const frameDurationMs = 1000 / this.config.fps;
    this.intervalId = setInterval(() => this.tick(), frameDurationMs);

    console.log(`[Pipeline] Başladı: ${this.config.width}x${this.config.height} @ ${this.config.fps}fps`);
    console.log(`[Pipeline] Tampon derinliği: ${this.config.bufferDepth}, Çıkışlar: ${this.outputs.map((o) => o.name).join(', ')}`);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    for (const output of this.outputs) {
      await output.close();
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    const frame = this.frameQueue.pop();
    if (!frame) return;

    this.frameCount++;

    // Geç frame tespiti — zamanlamadan sapma kontrolü
    const now = Date.now();
    const expectedTime = this.scheduledTime + (this.frameCount * 1000) / this.config.fps;
    if (now - expectedTime > (1000 / this.config.fps) * 1.5) {
      console.warn(`[Pipeline] Geç frame tespit edildi`);
    }

    // Tüm çıkışlara paralel gönder
    await Promise.all(this.outputs.map((output) => output.sendFrame(frame)));
  }

  /** RGBA frame'den Fill (RGB, opak) + Key (alpha grayscale) ayır. */
  static splitFillKey(frame: FrameData): FillKeyPair {
    const pixelCount = frame.width * frame.height;
    const fillBuffer = new Uint8Array(pixelCount * 4);
    const keyBuffer = new Uint8Array(pixelCount * 4);

    for (let i = 0; i < pixelCount; i++) {
      const idx = i * 4;

      // Fill: orijinal RGB, alpha = 255
      fillBuffer[idx]     = frame.buffer[idx];
      fillBuffer[idx + 1] = frame.buffer[idx + 1];
      fillBuffer[idx + 2] = frame.buffer[idx + 2];
      fillBuffer[idx + 3] = 255;

      // Key: alpha değeri luma key olarak
      const alpha = frame.buffer[idx + 3];
      keyBuffer[idx]     = alpha;
      keyBuffer[idx + 1] = alpha;
      keyBuffer[idx + 2] = alpha;
      keyBuffer[idx + 3] = 255;
    }

    return {
      fill: { buffer: fillBuffer, width: frame.width, height: frame.height, timestamp: frame.timestamp },
      key: { buffer: keyBuffer, width: frame.width, height: frame.height, timestamp: frame.timestamp },
    };
  }

  getStats() {
    return { running: this.running, frameCount: this.frameCount, queue: this.frameQueue.getStats(), outputs: this.outputs.map((o) => o.name) };
  }
}
