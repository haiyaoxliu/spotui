/**
 * Spotify Connect state + command transport. Lets the sidecar drive
 * playback via the same internal endpoint the web player uses
 * (`gue1-spclient.spotify.com/connect-state/v1`) instead of the public
 * Web API. Direct port of `openclaw/spogo` `internal/spotify/connect_*.go`.
 *
 * The dance:
 *   1. Open `wss://dealer.spotify.com/` to get a `Spotify-Connection-Id`.
 *      We piggy-back on the persistent dealer client when it's already
 *      open (always true when at least one SSE subscriber exists);
 *      otherwise we spin a one-shot connection.
 *   2. Register a hidden virtual device via
 *      `POST track-playback/v1/devices`. Hidden so it doesn't pollute
 *      the user's Spotify Connect picker.
 *   3. PUT `connect-state/v1/devices/hobs_{deviceID}` with the
 *      connection-id header → response is the cluster state (devices,
 *      player_state, active_device_id).
 *   4. POST `connect-state/v1/player/command/from/{X}/to/{Y}` to send
 *      commands. `X` is the registered (hidden) device, `Y` is the
 *      currently active device that we're driving.
 *
 * Reuses the bearer + client-token + clientVersion from `./session.ts`.
 */

import crypto from 'node:crypto'
import os from 'node:os'

import WebSocket from 'ws'

import type { CookieReadResult } from '../cookies/index.js'
import { getDealer } from './dealer.js'
import { getSessionAuth, type SessionAuth } from './session.js'
import { getToken } from './token.js'
import { toCookieHeader } from '../cookies/types.js'

const CONNECT_STATE_BASE =
  'https://gue1-spclient.spotify.com/connect-state/v1'
const TRACK_PLAYBACK_BASE =
  'https://gue1-spclient.spotify.com/track-playback/v1'
const DEALER_URL = 'wss://dealer.spotify.com/'
const REGISTRATION_TTL_MS = 10 * 60 * 1000
const APP_PLATFORM = 'WebPlayer'
const SEC_CH_UA =
  '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"'

interface ConnectSession {
  deviceId: string
  connectionId: string | null
  connectionIdAt: number
  registeredAt: number
}

const session: ConnectSession = {
  deviceId: '',
  connectionId: null,
  connectionIdAt: 0,
  registeredAt: 0,
}

interface ConnectStateResponse {
  player_state?: PlayerStateRaw
  devices?: Record<string, ConnectDevice>
  active_device_id?: string
}

interface PlayerStateRaw {
  play_origin?: { device_identifier?: string }
}

interface ConnectDevice {
  is_active?: boolean
  is_currently_playing?: boolean
  is_active_device?: boolean
}

export interface PlayArgs {
  /** Context URI (playlist / album / artist / show / collection). */
  contextUri?: string
  /** Track URI inside the context to start at. */
  offsetUri?: string
  /** Single track URI when there is no surrounding context. */
  uri?: string
  /** Optional post-play seek. */
  positionMs?: number
}

/** Public surface — what the route layer calls. */
export interface ConnectClient {
  state(read: CookieReadResult): Promise<ConnectStateResponse>
  play(read: CookieReadResult, args?: PlayArgs): Promise<void>
  pause(read: CookieReadResult): Promise<void>
  next(read: CookieReadResult): Promise<void>
  previous(read: CookieReadResult): Promise<void>
  seek(read: CookieReadResult, positionMs: number): Promise<void>
  volume(read: CookieReadResult, percent: number): Promise<void>
  shuffle(read: CookieReadResult, state: boolean): Promise<void>
  repeat(
    read: CookieReadResult,
    mode: 'off' | 'track' | 'context',
  ): Promise<void>
  queueAdd(read: CookieReadResult, uri: string): Promise<void>
  transfer(
    read: CookieReadResult,
    targetDeviceId: string,
    play: boolean,
  ): Promise<void>
}

export const connectClient: ConnectClient = {
  state,
  play,
  pause,
  next,
  previous,
  seek,
  volume,
  shuffle,
  repeat,
  queueAdd,
  transfer,
}

// ---- state pull --------------------------------------------------------

async function state(read: CookieReadResult): Promise<ConnectStateResponse> {
  const auth = await getSessionAuth(read)
  const connectionId = await ensureConnectionId(read)
  await ensureRegistered(read, auth, connectionId)
  const url = `${CONNECT_STATE_BASE}/devices/hobs_${session.deviceId}`
  const body = {
    member_type: 'CONNECT_STATE',
    device: {
      device_info: {
        capabilities: {
          can_be_player: false,
          hidden: true,
          needs_full_player_state: true,
        },
      },
    },
  }
  const res = await fetch(url, {
    method: 'PUT',
    headers: connectHeaders(auth, connectionId),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`connect state ${res.status}: ${truncate(text)}`)
  }
  return (await res.json()) as ConnectStateResponse
}

// ---- registration ------------------------------------------------------

async function ensureConnectionId(read: CookieReadResult): Promise<string> {
  // Reuse the persistent dealer's connection-id if it's open and recent.
  const dealer = getDealer()
  const fromDealer = dealer.connectionIdOrNull()
  if (fromDealer && dealer.isConnected()) {
    session.connectionId = fromDealer
    session.connectionIdAt = Date.now()
    return fromDealer
  }
  // Cached one-shot value still good?
  if (
    session.connectionId &&
    Date.now() - session.connectionIdAt < REGISTRATION_TTL_MS
  ) {
    return session.connectionId
  }
  const fresh = await getConnectionIdOnce(read)
  session.connectionId = fresh
  session.connectionIdAt = Date.now()
  return fresh
}

async function getConnectionIdOnce(read: CookieReadResult): Promise<string> {
  const tok = await getToken(read)
  const url = `${DEALER_URL}?access_token=${encodeURIComponent(tok.accessToken)}`
  return new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    })
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('dealer one-shot timed out'))
    }, 10_000)
    ws.on('message', (data) => {
      try {
        const obj = JSON.parse(
          typeof data === 'string' ? data : (data as Buffer).toString('utf8'),
        ) as { headers?: Record<string, string> }
        const headers = obj.headers ?? {}
        for (const [k, v] of Object.entries(headers)) {
          if (k.toLowerCase() === 'spotify-connection-id' && typeof v === 'string') {
            clearTimeout(timer)
            ws.close(1000, 'got connection-id')
            resolve(v)
            return
          }
        }
      } catch {
        /* skip non-JSON frames */
      }
    })
    ws.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function ensureRegistered(
  read: CookieReadResult,
  auth: SessionAuth,
  connectionId: string,
): Promise<void> {
  if (!session.deviceId) {
    session.deviceId = randomHex(40)
  }
  if (Date.now() - session.registeredAt < REGISTRATION_TTL_MS) {
    return
  }
  const { osName, osVersion } = runtimeOs()
  const body = {
    device: {
      device_id: session.deviceId,
      device_type: 'computer',
      brand: 'spotify',
      model: 'web_player',
      name: 'spotui',
      is_group: false,
      metadata: {},
      platform_identifier: `web_player ${osName} ${osVersion};spotui`,
      capabilities: {
        change_volume: true,
        supports_file_media_type: true,
        enable_play_token: true,
        play_token_lost_behavior: 'pause',
        disable_connect: false,
        audio_podcasts: true,
        video_playback: true,
        manifest_formats: [
          'file_ids_mp3',
          'file_urls_mp3',
          'file_ids_mp4',
          'manifest_ids_video',
        ],
      },
    },
    outro_endcontent_snooping: false,
    connection_id: connectionId,
    client_version: auth.clientVersion,
    volume: 65535,
  }
  const res = await fetch(`${TRACK_PLAYBACK_BASE}/devices`, {
    method: 'POST',
    headers: connectHeaders(auth, connectionId, true),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`register device ${res.status}: ${truncate(text)}`)
  }
  session.registeredAt = Date.now()

  // Adding cookie attachment to track-playback registration:
  // some Spotify infra checks the cookie on registration. We attach
  // implicitly via the bearer + client-token; raw cookie isn't required.
  void read
}

// ---- command sender ----------------------------------------------------

interface FromTo {
  from: string
  to: string
}

async function fromTo(read: CookieReadResult): Promise<FromTo> {
  const cluster = await state(read)
  const playerOrigin = cluster.player_state?.play_origin?.device_identifier ?? ''
  const activeFromState = cluster.active_device_id ?? ''
  const detected = detectActive(cluster.devices)
  const to = activeFromState || detected
  if (!to) throw new Error('no active Spotify Connect device')
  const from = playerOrigin || session.deviceId
  if (!from) throw new Error('no source device id (sidecar not registered)')
  return { from, to }
}

function detectActive(devices: Record<string, ConnectDevice> | undefined): string {
  if (!devices) return ''
  for (const [id, d] of Object.entries(devices)) {
    if (d.is_active || d.is_currently_playing || d.is_active_device) return id
  }
  return ''
}

async function sendCommand(
  read: CookieReadResult,
  command: Record<string, unknown>,
): Promise<void> {
  const { from, to } = await fromTo(read)
  const auth = await getSessionAuth(read)
  const connectionId = await ensureConnectionId(read)
  const url = `${CONNECT_STATE_BASE}/player/command/from/${from}/to/${to}`
  const res = await fetch(url, {
    method: 'POST',
    headers: connectHeaders(auth, connectionId, true),
    body: JSON.stringify({ command }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`connect command ${res.status}: ${truncate(text)}`)
  }
}

// ---- per-command surface ----------------------------------------------

async function play(read: CookieReadResult, args: PlayArgs = {}): Promise<void> {
  const { contextUri, offsetUri, uri, positionMs } = args
  // No args: resume current playback.
  if (!contextUri && !offsetUri && !uri) {
    await sendCommand(read, baseCommand('resume'))
    return
  }
  const command = baseCommand('play')
  // Pick a context. Prefer explicit contextUri; fall back to a track URI
  // wrapped in `context://` so connect-state has somewhere to anchor.
  const ctxUri = contextUri ?? offsetUri ?? uri
  if (ctxUri) {
    command.context = { uri: ctxUri, url: `context://${ctxUri}` }
  }
  // Decide the start position. If offsetUri is set, jump to that track
  // inside the context. If a single track URI was passed and there's no
  // separate context, also use it as skip_to so we land on that track.
  const startTrack = offsetUri ?? (uri && uri !== contextUri ? uri : null)
  if (startTrack) {
    command.options = { skip_to: { track_uri: startTrack } }
  }
  if (typeof positionMs === 'number' && positionMs > 0) {
    // Connect-state's play accepts seek_to in options; layer it on rather
    // than firing a separate seek so playback starts at the right spot.
    const opts = (command.options as Record<string, unknown> | undefined) ?? {}
    opts.seek_to = positionMs
    command.options = opts
  }
  await sendCommand(read, command)
}

async function pause(read: CookieReadResult): Promise<void> {
  await sendCommand(read, baseCommand('pause'))
}

async function next(read: CookieReadResult): Promise<void> {
  await sendCommand(read, baseCommand('skip_next'))
}

async function previous(read: CookieReadResult): Promise<void> {
  await sendCommand(read, baseCommand('skip_prev'))
}

async function seek(read: CookieReadResult, positionMs: number): Promise<void> {
  const command = baseCommand('seek_to')
  command.value = Math.max(0, Math.floor(positionMs))
  await sendCommand(read, command)
}

async function volume(read: CookieReadResult, percent: number): Promise<void> {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)))
  const { from, to } = await fromTo(read)
  const auth = await getSessionAuth(read)
  const connectionId = await ensureConnectionId(read)
  // Volume uses a different endpoint shape: `/connect/volume/from/X/to/Y`
  // rather than the player-command pipe.
  const url = `${CONNECT_STATE_BASE}/connect/volume/from/${from}/to/${to}`
  const res = await fetch(url, {
    method: 'PUT',
    headers: connectHeaders(auth, connectionId, true),
    body: JSON.stringify({ volume: Math.round((clamped / 100) * 65535) }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`connect volume ${res.status}: ${truncate(text)}`)
  }
}

async function shuffle(read: CookieReadResult, state: boolean): Promise<void> {
  const command = baseCommand('set_shuffling_context')
  command.value = state
  await sendCommand(read, command)
}

async function repeat(
  read: CookieReadResult,
  mode: 'off' | 'track' | 'context',
): Promise<void> {
  const command = baseCommand('set_options')
  command.repeating_track = mode === 'track'
  command.repeating_context = mode === 'context'
  await sendCommand(read, command)
}

async function queueAdd(read: CookieReadResult, uri: string): Promise<void> {
  const command = baseCommand('add_to_queue')
  command.track = { uri }
  await sendCommand(read, command)
}

async function transfer(
  read: CookieReadResult,
  targetDeviceId: string,
  shouldPlay: boolean,
): Promise<void> {
  const auth = await getSessionAuth(read)
  const connectionId = await ensureConnectionId(read)
  const cluster = await state(read)
  const fromId =
    cluster.player_state?.play_origin?.device_identifier ||
    cluster.active_device_id ||
    session.deviceId
  if (!fromId) throw new Error('no source device id for transfer')
  const url = `${CONNECT_STATE_BASE}/connect/transfer/from/${fromId}/to/${targetDeviceId}`
  const res = await fetch(url, {
    method: 'POST',
    headers: connectHeaders(auth, connectionId, true),
    body: JSON.stringify({
      transfer_options: { restore_paused: shouldPlay ? 'resume' : 'pause' },
      command_id: randomHex(32),
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`connect transfer ${res.status}: ${truncate(text)}`)
  }
}

// ---- helpers -----------------------------------------------------------

function baseCommand(endpoint: string): Record<string, unknown> {
  return {
    endpoint,
    logging_params: { command_id: randomHex(32) },
  }
}

function connectHeaders(
  auth: SessionAuth,
  connectionId: string,
  withContentType = false,
): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${auth.accessToken}`,
    'client-token': auth.clientToken,
    'app-platform': APP_PLATFORM,
    'spotify-app-version': auth.clientVersion,
    'X-Spotify-Connection-Id': connectionId,
    Origin: 'https://open.spotify.com',
    Referer: 'https://open.spotify.com/',
    'Sec-CH-UA': SEC_CH_UA,
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"macOS"',
  }
  if (withContentType) h['Content-Type'] = 'application/json'
  return h
}

function randomHex(size: number): string {
  return crypto.randomBytes(Math.ceil(size / 2)).toString('hex').slice(0, size)
}

function runtimeOs(): { osName: string; osVersion: string } {
  switch (os.platform()) {
    case 'darwin':
      return { osName: 'macos', osVersion: 'unknown' }
    case 'win32':
      return { osName: 'windows', osVersion: 'unknown' }
    default:
      return { osName: 'linux', osVersion: 'unknown' }
  }
}

function truncate(s: string): string {
  return s.length > 200 ? `${s.slice(0, 200)}...` : s
}

// Cookie-based session is implicit via the bearer; this function is here
// in case we later need raw cookie attachment (e.g. for endpoints that
// double-check the jar). Leaving the import path intact.
export { toCookieHeader as _cookieHeaderForConnect }
