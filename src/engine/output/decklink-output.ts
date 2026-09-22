// Decklink SDI cikis - henuz implement edilmedi
// TODO: native addon, scheduled playback, fill+key, genlock
// ndi bittikten sonra buna baslanicak, bi hayli is var

import { OutputPort } from '../render-pipeline';
import { FrameData } from '../frame-queue';

export class DecklinkOutput implements OutputPort {
  name = 'decklink';

  constructor(
    private deviceIndex: number = 0,
    private keyerMode: 'disabled' | 'internal' | 'external' = 'disabled'
  ) {}

  async initialize(width: number, height: number, fps: number): Promise<void> {
    console.log(`[Decklink] ${this.deviceIndex}: ${width}x${height}@${fps}fps keyer:${this.keyerMode}`);
    console.log(`[Decklink] TODO: SDK bağlı değil`);
  }

  async sendFrame(_frame: FrameData): Promise<void> {}

  async close(): Promise<void> {
    console.log(`[Decklink] kapatıldı`);
  }
}
