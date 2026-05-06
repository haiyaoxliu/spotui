import os from 'node:os'

/** Coarse OS label used in Spotify's `js_sdk_data` payload. Real values
 *  aren't required (Spotify accepts unknowns); we report them best-effort
 *  so server-side logs there reflect roughly what hardware minted the
 *  client-token. */
export function runtimeOs(): { osName: string; osVersion: string } {
  switch (os.platform()) {
    case 'darwin':
      return { osName: 'macos', osVersion: 'unknown' }
    case 'win32':
      return { osName: 'windows', osVersion: 'unknown' }
    default:
      return { osName: 'linux', osVersion: 'unknown' }
  }
}
