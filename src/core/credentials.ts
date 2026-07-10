import type { Config } from '../config.js';

/** A request can authenticate only when the complete Avito account tuple is present. */
export function hasConfiguredCredentials(
  config: Pick<Config, 'clientId' | 'clientSecret' | 'profileId'>,
): boolean {
  return Boolean(config.clientId && config.clientSecret && config.profileId !== undefined);
}
