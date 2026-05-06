/**
 * Spotui sidecar — a Vite dev plugin that adds `/api/*` endpoints for
 * cookie-based auth + (later) proxying internal Spotify endpoints.
 *
 * The whole thing runs in Vite's dev-server Node process, so it has none of
 * the CORS / same-origin restrictions a browser does. The SPA at
 * `127.0.0.1:8888` calls these endpoints; the sidecar attaches the user's
 * `sp_dc` cookie and talks to Spotify on their behalf.
 *
 * Phase 1: auth only. Pathfinder / connect-state / dealer / lyrics arrive
 * in later phases (see WEB_PLAN.md).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

import {
  clearHandler,
  discoverHandler,
  pasteHandler,
  statusHandler,
  tokenHandler,
} from './routes/auth.js'
import {
  connectNextHandler,
  connectPauseHandler,
  connectPlayHandler,
  connectPrevHandler,
  connectQueueHandler,
  connectRepeatHandler,
  connectSeekHandler,
  connectShuffleHandler,
  connectTransferHandler,
  connectVolumeHandler,
  friendsHandler,
  jamGetHandler,
  jamLeaveHandler,
  jamStartHandler,
  libraryAlbumsHandler,
  libraryPlaylistsHandler,
  libraryTracksHandler,
  lyricsHandler,
  pathfinderHandler,
  playlistTracksHandler,
  searchHandler,
  stateStreamHandler,
} from './routes/proxy.js'

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

interface Route {
  path: string
  method: 'GET' | 'POST' | 'DELETE'
  handler: Handler
}

const ROUTES: Route[] = [
  { path: '/api/auth/status', method: 'GET', handler: statusHandler },
  { path: '/api/auth/discover', method: 'POST', handler: discoverHandler },
  { path: '/api/auth/paste', method: 'POST', handler: pasteHandler },
  { path: '/api/auth/clear', method: 'DELETE', handler: clearHandler },
  { path: '/api/auth/token', method: 'GET', handler: tokenHandler },
  { path: '/api/proxy/pathfinder', method: 'POST', handler: pathfinderHandler },
  { path: '/api/proxy/search', method: 'GET', handler: searchHandler },
  { path: '/api/proxy/library/playlists', method: 'GET', handler: libraryPlaylistsHandler },
  { path: '/api/proxy/library/albums', method: 'GET', handler: libraryAlbumsHandler },
  { path: '/api/proxy/library/tracks', method: 'GET', handler: libraryTracksHandler },
  { path: '/api/proxy/playlist', method: 'GET', handler: playlistTracksHandler },
  { path: '/api/proxy/state/stream', method: 'GET', handler: stateStreamHandler },
  { path: '/api/proxy/lyrics', method: 'GET', handler: lyricsHandler },
  { path: '/api/proxy/connect/play', method: 'POST', handler: connectPlayHandler },
  { path: '/api/proxy/connect/pause', method: 'POST', handler: connectPauseHandler },
  { path: '/api/proxy/connect/next', method: 'POST', handler: connectNextHandler },
  { path: '/api/proxy/connect/prev', method: 'POST', handler: connectPrevHandler },
  { path: '/api/proxy/connect/seek', method: 'POST', handler: connectSeekHandler },
  { path: '/api/proxy/connect/volume', method: 'POST', handler: connectVolumeHandler },
  { path: '/api/proxy/connect/shuffle', method: 'POST', handler: connectShuffleHandler },
  { path: '/api/proxy/connect/repeat', method: 'POST', handler: connectRepeatHandler },
  { path: '/api/proxy/connect/queue', method: 'POST', handler: connectQueueHandler },
  { path: '/api/proxy/connect/transfer', method: 'POST', handler: connectTransferHandler },
  { path: '/api/proxy/friends', method: 'GET', handler: friendsHandler },
  { path: '/api/proxy/jam', method: 'GET', handler: jamGetHandler },
  { path: '/api/proxy/jam/start', method: 'POST', handler: jamStartHandler },
  { path: '/api/proxy/jam/leave', method: 'POST', handler: jamLeaveHandler },
]

export function spotuiSidecar(): Plugin {
  return {
    name: 'spotui-sidecar',
    apply: 'serve', // dev only; production preview is out of scope for now
    configureServer(server) {
      for (const route of ROUTES) {
        server.middlewares.use(route.path, (req, res, next) => {
          if (req.method !== route.method) {
            // Let other middlewares (or the 404 fallback) handle it. Don't
            // 405 — Connect's chain will produce a sensible answer.
            next()
            return
          }
          // We `await` inside a promise so the handler can throw cleanly.
          void (async () => {
            try {
              await route.handler(req, res)
            } catch (e) {
              if (!res.headersSent) {
                res.statusCode = 500
                res.setHeader('Content-Type', 'application/json')
                res.end(
                  JSON.stringify({
                    error: e instanceof Error ? e.message : String(e),
                  }),
                )
              } else {
                console.error('[spotui] sidecar handler threw after headers:', e)
              }
            }
          })()
        })
      }

      // Lightweight liveness check so we can tell from the SPA whether the
      // sidecar is loaded at all.
      server.middlewares.use('/api/health', (req, res, next) => {
        if (req.method !== 'GET') return next()
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true, name: 'spotui-sidecar' }))
      })

      console.log(
        '[spotui] sidecar mounted: ' +
          '/api/auth/{status,discover,paste,clear,token} + ' +
          '/api/proxy/{pathfinder,search,library/{playlists,albums,tracks},playlist/:id/items,state/stream,lyrics/:id,connect/{play,pause,next,prev,seek,volume,shuffle,repeat,queue,transfer},friends,jam,jam/{start,leave}} + ' +
          '/api/health',
      )
    },
  }
}

export default spotuiSidecar
