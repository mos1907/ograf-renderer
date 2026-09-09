/**
 * Frame Queue — üretici-tüketici tampon kuyruğu
 * Coded by Murat Demirci
 *
 * Renderer frame üretir → kuyruğa koyar → output tüketir
 * Kuyruk dolarsa en eski frame atılır, boşsa son frame tekrarlanır.
 */

export interface FrameData {
  buffer: Buffer | Uint8Array;
  width: number;
  height: number;
  timestamp: number;
}

export interface FrameQueueStats {
  buffered: number;
  capacity: number;
  droppedFrames: number;
  lateFrames: number;
  totalFrames: number;
}

export class FrameQueue {
  private queue: FrameData[] = [];
  private lastFrame: FrameData | null = null;
  private stats: FrameQueueStats;

  constructor(private capacity: number = 4) {
    this.stats = {
      buffered: 0,
      capacity: this.capacity,
      droppedFrames: 0,
      lateFrames: 0,
      totalFrames: 0,
    };
  }

  /** Frame'i kuyruğa ekle. Kuyruk doluysa en eskiyi at. */
  push(frame: FrameData): void {
    this.queue.push(frame);
    this.stats.totalFrames++;
    while (this.queue.length > this.capacity) {
      this.queue.shift();
      this.stats.droppedFrames++;
    }
    this.stats.buffered = this.queue.length;
  }

  /** Kuyruktan frame al. Boşsa son frame'i tekrarla. */
  pop(): FrameData | null {
    if (this.queue.length > 0) {
      this.lastFrame = this.queue.shift()!;
      this.stats.buffered = this.queue.length;
      return this.lastFrame;
    }
    this.stats.lateFrames++;
    return this.lastFrame;
  }

  peekLast(): FrameData | null {
    return this.lastFrame;
  }

  hasFrames(): boolean {
    return this.queue.length > 0;
  }

  getStats(): Readonly<FrameQueueStats> {
    return { ...this.stats };
  }

  /** Kuyruğu boş frame'lerle doldur (pre-roll tamponlama). */
  preroll(width: number, height: number): void {
    const emptyBuffer = new Uint8Array(width * height * 4);
    for (let i = 0; i < this.capacity; i++) {
      this.push({ buffer: emptyBuffer, width, height, timestamp: Date.now() });
    }
  }

  flush(): void {
    this.queue = [];
    this.stats.buffered = 0;
  }
}
