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

      console.log('[spotui] sidecar mounted: /api/auth/{status,discover,paste,clear,token} + /api/health')
    },
  }
}

export default spotuiSidecar
