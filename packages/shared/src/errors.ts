/**
 * Domain errors shared across the proxy + admin API.
 */

export class ConfigNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigNotFoundError";
  }
}

export class ProviderNotConfiguredError extends Error {
  constructor(public slug: string) {
    super(`provider not configured: ${slug}`);
    this.name = "ProviderNotConfiguredError";
  }
}

export class NoActiveKeysError extends Error {
  constructor(public providerSlug: string) {
    super(`no active keys for provider: ${providerSlug}`);
    this.name = "NoActiveKeysError";
  }
}
