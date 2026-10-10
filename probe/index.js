/**
 * Agent Alerts Probe — host half.
 *
 * A throwaway Phase 0 diagnostic. The Host side exists for exactly one reason:
 * the real plugin intends to hand the packaged `mp3` bytes to the page over a
 * `ctx.webServer` route, and it is not decidable by reading the shipped bundles
 * whether a profile-installed bundle's route is reachable from the desktop
 * page at all.
 *
 * The desktop page's origin is the custom scheme `dsh-app://app`. Everything
 * that is not a static document path is forwarded to the Host's own HTTP
 * server together with the Host cookie (`lib/main.js`: `forwardWebRequest(
 * request, hostUrl, hostCookie)`), so a same-origin `fetch('/api/...')` from
 * the page should land here. "Should" is the whole problem: the route also has
 * to pass the same admission gate every other Host route uses, and a probe that
 * only reports "the bytes did not arrive" cannot distinguish a routing failure
 * from an admission failure.
 *
 * Hence three routes rather than one:
 *
 *   `/api/agent-alerts-probe/ping`        always 200; reports what admission saw
 *   `/api/agent-alerts-probe/sound`       the real design: admission-gated
 *   `/api/agent-alerts-probe/sound-open`  ungated, so audio stays testable
 *
 * The probe reads the two sounds from the plugin package's own `assets/`
 * directory rather than from an absolute user path, so the committed tree
 * carries no personal filesystem path.
 *
 * Nothing here ships.
 *
 * @module dsh-plugin-agent-alerts-probe
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Directory of this module, used to resolve the sibling `assets/` tree. */
const HERE = dirname(fileURLToPath(import.meta.url))

/** The two probes' sound files, keyed by the `kind` query parameter. */
const SOUNDS = {
  finish: join(HERE, '..', 'assets', 'duo_finish.mp3'),
  question: join(HERE, '..', 'assets', 'duo_question.mp3'),
}

/**
 * Required Host services.
 *
 * `webServer` carries the routes. `connection` is what the real plugin intends
 * to gate them with; it is a hard dependency here too so that a composition
 * without it fails loudly rather than silently serving an ungated route.
 */
export const inject = ['webServer', 'connection']

/**
 * Reuse the connection service's own admission fence.
 *
 * Returns `null` when the request is admitted, or a numeric HTTP status when it
 * is not. A missing or unrecognisable admission contract refuses rather than
 * treating "unknown" as "admitted" — the same posture the Tailscale plugin
 * takes, because a file-serving route is exactly where that matters.
 *
 * @param ctx - Host context carrying `connection`.
 * @param req - The incoming request.
 * @returns `null` when admitted, otherwise the rejection status.
 */
function admissionOf(ctx, req) {
  const connection = ctx.connection
  if (typeof connection?.admit === 'function') {
    let admission
    try {
      admission = connection.admit(req)
    } catch {
      return 503
    }
    if (admission !== null && typeof admission === 'object' && typeof admission.then === 'function') return 503
    if (admission === undefined || admission === null || typeof admission !== 'object') return 503
    if (!('rejection' in admission)) return null
    return typeof admission.rejection === 'number' ? admission.rejection : 403
  }
  if (typeof connection?.isAuthenticated === 'function') return connection.isAuthenticated(req) ? null : 401
  return 503
}

/**
 * Mount the probe's three routes.
 *
 * @param ctx - Host context carrying `webServer` and `connection`.
 */
export function apply(ctx) {
  const json = (res, status, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/agent-alerts-probe/ping',
        handler: (req, res) => {
          const decision = admissionOf(ctx, req)
          json(res, 200, {
            ok: true,
            // The two facts that separate "the route is unreachable" from
            // "the route is reachable but refuses this caller".
            admitted: decision === null,
            rejection: decision,
            sawCookie: typeof req.headers.cookie === 'string' && req.headers.cookie.length > 0,
            admitContract: typeof ctx.connection?.admit,
            origin: req.headers.origin ?? null,
            host: req.headers.host ?? null,
          })
        },
      }),
    'agent-alerts-probe: ping route',
  )

  const serveSound = (req, res, gated) => {
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const kind = url.searchParams.get('kind') ?? 'finish'
    if (gated) {
      const decision = admissionOf(ctx, req)
      if (decision !== null) {
        res.writeHead(decision, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('refused')
        return
      }
    }
    const path = SOUNDS[kind]
    if (path === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('unknown kind')
      return
    }
    let bytes
    try {
      bytes = readFileSync(path)
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`unreadable: ${String(error?.message ?? error)}`)
      return
    }
    res.writeHead(200, {
      'content-type': 'audio/mpeg',
      'content-length': bytes.length,
      'cache-control': 'no-store',
    })
    res.end(req.method === 'HEAD' ? undefined : bytes)
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/agent-alerts-probe/sound',
        handler: (req, res) => serveSound(req, res, true),
      }),
    'agent-alerts-probe: gated sound route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/agent-alerts-probe/sound-open',
        handler: (req, res) => serveSound(req, res, false),
      }),
    'agent-alerts-probe: open sound route',
  )
}
