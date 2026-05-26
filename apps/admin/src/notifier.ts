import { RedisConfigBus } from "@ai-gateway/config-runtime";

/**
 * Lazy singleton — Redis is optional, gracefully no-op when REDIS_URL absent.
 * Each mutation calls notifyConfigChange() to wake up the proxy via pub/sub.
 */
let _bus: RedisConfigBus | null = null;

function getBus(): RedisConfigBus | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (!_bus) {
    const tenantSlug = process.env.TENANT_SLUG ?? "default";
    _bus = new RedisConfigBus({ url, tenantSlug });
  }
  return _bus;
}

export async function notifyConfigChange(actor?: string): Promise<void> {
  const bus = getBus();
  if (!bus) return;
  try {
    await bus.publish(actor ?? "admin-api");
  } catch {
    // Doorbell failure is non-fatal — slow-poll will pick up the change.
  }
}

export async function closeBus(): Promise<void> {
  if (_bus) {
    await _bus.close().catch(() => {});
    _bus = null;
  }
}
