import { createTransportError } from './errors.js';
import type { PeerId, TransportFrame, TransportLayer } from './types.js';

export interface CompositeTransportOptions {
  readonly primary: TransportLayer;
  readonly fallback?: TransportLayer;
  readonly maxRetries?: number;
}

/**
 * Transport decorator that tries the primary link, falls back to a secondary
 * link (e.g. Wi-Fi Direct -> Bluetooth LE) and retries transient failures.
 */
export class CompositeTransport implements TransportLayer {
  readonly localPeerId: PeerId;
  private readonly primary: TransportLayer;
  private readonly fallback?: TransportLayer;
  private readonly maxRetries: number;
  private readonly handlers: Array<(frame: TransportFrame) => void> = [];

  constructor(options: CompositeTransportOptions) {
    this.primary = options.primary;
    this.fallback = options.fallback;
    this.maxRetries = options.maxRetries ?? 2;
    this.localPeerId = options.primary.localPeerId;

    this.primary.onFrame((frame) => this.broadcast(frame));
    this.fallback?.onFrame((frame) => this.broadcast(frame));
  }

  async sendFrame(frame: TransportFrame): Promise<void> {
    const links = this.fallback ? [this.primary, this.fallback] : [this.primary];
    let lastError: unknown;

    for (const link of links) {
      for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
        try {
          await link.sendFrame(frame);
          return;
        } catch (error) {
          lastError = error;
        }
      }
    }

    throw createTransportError(
      'all-links-failed',
      `All transport links failed for peer ${frame.to}`,
      lastError
    );
  }

  onFrame(handler: (frame: TransportFrame) => void): void {
    this.handlers.push(handler);
  }

  async close(): Promise<void> {
    this.handlers.length = 0;
    await this.primary.close();
    await this.fallback?.close();
  }

  private broadcast(frame: TransportFrame): void {
    for (const handler of [...this.handlers]) {
      handler(frame);
    }
  }
}
