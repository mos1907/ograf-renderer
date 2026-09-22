// Frame kuyruğu - üretici/tüketici pattern
// Murat Demirci

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

  push(frame: FrameData): void {
    this.queue.push(frame);
    this.stats.totalFrames++;
    // kuyruk doluysa en eskiyi at
    while (this.queue.length > this.capacity) {
      this.queue.shift();
      this.stats.droppedFrames++;
    }
    this.stats.buffered = this.queue.length;
  }

  pop(): FrameData | null {
    if (this.queue.length > 0) {
      this.lastFrame = this.queue.shift()!;
      this.stats.buffered = this.queue.length;
      return this.lastFrame;
    }
    // kuyruk boşsa son frame'i tekrarla
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

  // boş frame'lerle doldur (pre-roll)
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
