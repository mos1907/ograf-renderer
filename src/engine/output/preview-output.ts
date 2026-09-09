/**
 * Preview Output — WebSocket üzerinden browser'a frame gönderir
 *
 * Decklink olmadan test etmek için:
 * Frame'leri canvas'a çizer, fill+key ayrımını görselleştirir
 */

import { OutputPort } from '../render-pipeline';
import { FrameData } from '../frame-queue';

export class PreviewOutput implements OutputPort {
  name = 'preview';
  private onFrame: ((frame: FrameData) => void) | null = null;
  private width = 0;
  private height = 0;

  async initialize(width: number, height: number, fps: number): Promise<void> {
    this.width = width;
    this.height = height;
    console.log(`[Preview] Initialized: ${width}x${height} @ ${fps}fps`);
  }

  async sendFrame(frame: FrameData): Promise<void> {
    if (this.onFrame) {
      this.onFrame(frame);
    }
  }

  async close(): Promise<void> {
    this.onFrame = null;
    console.log('[Preview] Closed');
  }

  /** Register a callback for frame updates */
  setFrameCallback(cb: (frame: FrameData) => void): void {
    this.onFrame = cb;
  }
}
