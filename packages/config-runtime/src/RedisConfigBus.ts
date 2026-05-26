import { EventEmitter } from "node:events";
import { Redis } from "ioredis";

/**
 * Pub/sub bus for config-change events. The proxy (subscriber) wakes up the
 * moment the admin API (publisher) commits a change to Postgres — no polling
 * lag, no extra DB load.
 *
 * Channel convention: `ai-gateway:config:<tenant-slug>`.
 *
 * Wire format (JSON):
 *   { v: 1, kind: "config:updated", at: <iso-string>, by?: "<actor>" }
 *
 * The payload is intentionally tiny — subscribers always re-read the full
 * snapshot from Postgres anyway. Treat this as a doorbell, not a delivery.
 */

export interface ConfigUpdateMessage {
  v: 1;
  kind: "config:updated";
  at: string;
  by?: string;
}

export interface RedisConfigBusOptions {
  url: string;
  tenantSlug: string;
}

export class RedisConfigBus extends EventEmitter {
  private subscriber: Redis | null = null;
  private publisher: Redis | null = null;
  private readonly url: string;
  private readonly channel: string;
  private closed = false;

  constructor(opts: RedisConfigBusOptions) {
    super();
    this.url = opts.url;
    this.channel = `ai-gateway:config:${opts.tenantSlug}`;
  }

  channelName(): string {
    return this.channel;
  }

  async subscribe(): Promise<void> {
    if (this.subscriber || this.closed) return;
    this.subscriber = new Redis(this.url, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
    });
    this.subscriber.on("error", (err) => this.emit("error", err));
    await this.subscriber.connect();
    await this.subscriber.subscribe(this.channel);
    this.subscriber.on("message", (ch, raw) => {
      if (ch !== this.channel) return;
      try {
        const msg = JSON.parse(raw) as ConfigUpdateMessage;
        this.emit("update", msg);
      } catch (err) {
        this.emit("error", err);
      }
    });
  }

  async publish(by?: string): Promise<number> {
    if (!this.publisher) {
      this.publisher = new Redis(this.url, {
        lazyConnect: true,
        maxRetriesPerRequest: 2,
      });
      this.publisher.on("error", (err) => this.emit("error", err));
      await this.publisher.connect();
    }
    const payload: ConfigUpdateMessage = {
      v: 1,
      kind: "config:updated",
      at: new Date().toISOString(),
      by,
    };
    return this.publisher.publish(this.channel, JSON.stringify(payload));
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([
      this.subscriber?.quit(),
      this.publisher?.quit(),
    ]);
    this.subscriber = null;
    this.publisher = null;
  }
}
