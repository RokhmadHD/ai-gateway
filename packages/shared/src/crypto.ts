/**
 * Provider-credential envelope encryption.
 *
 * Sprint 2b placeholder: secrets stored as `plain:<base64>`. The format is
 * intentionally tagged so a future migration can identify and re-encrypt
 * legacy rows once a real KMS-managed DEK is wired up.
 *
 * TODO(security): swap for libsodium secretbox + KMS data-key envelope
 * before exposing the admin API on the public internet.
 */

const PLAIN_PREFIX = "plain:";

export function encryptSecret(plaintext: string): string {
  return `${PLAIN_PREFIX}${Buffer.from(plaintext, "utf8").toString("base64")}`;
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PLAIN_PREFIX)) {
    throw new Error(
      `unsupported secret format: expected "plain:" prefix (got "${stored.slice(0, 8)}…"). ` +
        "Re-seed or run encryption migration.",
    );
  }
  return Buffer.from(stored.slice(PLAIN_PREFIX.length), "base64").toString(
    "utf8",
  );
}
