import type { Client } from './client.js'

let defaultClient: Client | undefined

/**
 * The default {@link Client}: the one the module-level `counter`,
 * `duration` and `value` handles send through. `createClient` registers
 * every client it returns here unless called with `setAsDefault: false`.
 */
export function getDefaultClient(): Client | undefined {
  return defaultClient
}

/**
 * Sets the default client, replacing any earlier one; pass `undefined` to
 * clear it (module-level handles then do nothing). Mostly for tests and for
 * apps that build a client with `setAsDefault: false`.
 */
export function setDefaultClient(client: Client | undefined): void {
  defaultClient = client
}
