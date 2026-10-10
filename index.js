/**
 * Agent Alerts — host half.
 *
 * The feature is browser-side: only the page can raise a native notification or
 * play a sound, because the Harness Host runs as an Electron *child process*
 * (`lib/main.js` spawns `dsh-desktop-host` with Node), where `Notification` does
 * not exist.
 *
 * The Host owns the two things the page cannot do for itself:
 *
 *   1. Read a sound file off disk. The page has no filesystem, so a
 *      user-configured path is only useful if the Host resolves it.
 *   2. Persist the preferences. `Config` below is the settings schema, and
 *      `dsh-settings` derives its namespace from this row's Loader id
 *      (`agent-alerts`), so the page reaches the same values through
 *      `ctx.configForms.get('agent-alerts')` and writes land in the profile's
 *      `cordis.patch.yml` beside every other Host-backed preference.
 *
 * `.volatile()` is required, not decorative: only volatile fields are exposed to
 * the page's settings scope and accepted on write. Without it the schema has no
 * volatile field and the namespace does not appear at all.
 *
 * The sound route is deliberately the *only* way the frame reaches the bytes.
 * It reads a path out of this plugin's own config — it never accepts a path from
 * the request — so it cannot be turned into a general file-read primitive by
 * anything that can make a same-origin request.
 *
 * @module dsh-plugin-agent-alerts
 */

import { readFileSync, statSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

/** This module's directory, used to resolve the sibling `assets/` tree. */
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Route prefix.
 *
 * Derived from the package name rather than from the Loader row id, so renaming
 * the row cannot silently orphan the route the page is calling.
 */
const ROUTE = '/api/agent-alerts'

/**
 * The two bundled sounds, keyed by the moment they announce.
 *
 * `approval` has no entry of its own: it is the same "the agent is blocked on
 * you" case as a question, so it shares `question`. That is why the second
 * setting below is named for the question rather than for the pair.
 */
const BUNDLED = {
  'turn-end': join(HERE, 'assets', 'duo_finish.mp3'),
  question: join(HERE, 'assets', 'duo_question.mp3'),
}

/** Media type per extension, so a user's `.wav` is not served as `mpeg`. */
const MEDIA_TYPES = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.wave': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
}

/**
 * Cap on a user-supplied sound.
 *
 * The bytes are read into memory and handed to a media element, so an
 * accidental album must fail loudly instead of stalling the page.
 */
const MAX_BYTES = 16 * 1024 * 1024

/**
 * Live settings.
 *
 * Every field is a choice the user is allowed to change while the app runs;
 * none of them is technical enough to belong in a hand-edited file only.
 *
 * `quietWhenFocused` defaults to true because a notification for something
 * already on screen is noise — but the *sound* still plays, which is what makes
 * the plugin useful while the window is visible but in the background.
 */
export const Config = z.object({
  turnEnd: z.boolean().default(true).volatile().description('Alert when an agent finishes a turn.'),
  question: z.boolean().default(true).volatile().description('Alert when an agent asks you a question.'),
  approval: z.boolean().default(true).volatile().description('Alert when an agent needs your approval to run a tool.'),
  sound: z.boolean().default(true).volatile().description('Play a sound with the alert.'),
  notification: z.boolean().default(true).volatile().description('Show a desktop notification.'),
  quietWhenFocused: z.boolean().default(true).volatile().description('Skip the notification while the Harness window is focused. The sound still plays.'),
  volume: z.number().default(0.8).min(0).max(1).step(0.05).volatile().description('Sound volume, 0 to 1.'),
  turnEndSound: z.string().default('').volatile().description('Your own sound for a finished turn. Empty uses the bundled one.'),
  questionSound: z.string().default('').volatile().description('Your own sound for a question or an approval. Empty uses the bundled one.'),
})

/** Required Host services: `webServer` carries the route, `connection` gates it. */
export const inject = ['webServer', 'connection']

/**
 * Read one config member.
 *
 * A `.volatile()` member arrives as a live reference with its own `get()`, not
 * as a plain value, so reading it once at mount time would freeze the setting at
 * whatever it was when the plugin loaded. Every read therefore goes through
 * here, at the moment the value is needed.
 *
 * @param reference - Config member, possibly a live settings reference.
 * @param fallback - Value to use when the member is absent.
 * @returns The current value.
 */
function read(reference, fallback) {
  if (reference === undefined || reference === null) return fallback
  if (typeof reference?.get === 'function') return reference.get()
  return reference
}

/**
 * Reuse the connection service's own admission fence.
 *
 * Returns `null` when the request is admitted, or a numeric HTTP status when it
 * is not. A missing or unrecognisable admission contract refuses rather than
 * treating "unknown" as "admitted" — this route serves bytes off the user's
 * disk, which is exactly where that distinction matters.
 *
 * @param connection - The `ctx.connection` service.
 * @param req - The incoming request.
 * @returns `null` when admitted, otherwise the rejection status.
 */
function admissionOf(connection, req) {
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
 * Resolve one moment to a file on disk.
 *
 * @param kind - `turn-end` or `question`.
 * @param config - The plugin's live config.
 * @returns `{ path, source }`, where `source` is `bundled` or `custom`.
 */
function resolveSound(kind, config) {
  const configured = String(read(kind === 'turn-end' ? config.turnEndSound : config.questionSound, '') ?? '').trim()
  if (configured === '') return { path: BUNDLED[kind], source: 'bundled' }
  return { path: configured, source: 'custom' }
}

/**
 * Inspect one moment's resolved sound without sending it.
 *
 * The settings page shows this, which is the difference between "my sound is not
 * playing" and "my path has a typo in it".
 *
 * @param kind - `turn-end` or `question`.
 * @param config - The plugin's live config.
 * @returns A JSON-safe description.
 */
function describeSound(kind, config) {
  const { path, source } = resolveSound(kind, config)
  try {
    const info = statSync(path)
    if (!info.isFile()) return { kind, source, ok: false, error: 'not-a-file', path }
    if (info.size > MAX_BYTES) return { kind, source, ok: false, error: 'too-large', bytes: info.size, path }
    return { kind, source, ok: true, bytes: info.size, path, mediaType: MEDIA_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream' }
  } catch (error) {
    return { kind, source, ok: false, error: String(error?.code ?? error?.message ?? error), path }
  }
}

/**
 * Mount the sound route and the status route.
 *
 * @param ctx - Host context carrying `webServer` and `connection`.
 * @param config - See {@link Config}; volatile members are live references.
 */
export function apply(ctx, config = {}) {
  const json = (res, status, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  const plain = (res, status, text) => {
    res.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    })
    res.end(text)
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/sound`,
        handler: (req, res) => {
          const refusal = admissionOf(ctx.connection, req)
          if (refusal !== null) {
            plain(res, refusal, 'refused')
            return
          }

          const url = new URL(req.url ?? '/', 'http://dsh.invalid')
          const requested = url.searchParams.get('kind')
          // `approval` and `question` are the same moment for this plugin — "the
          // agent is blocked on you" — and share one sound. Anything else falls
          // back to the turn-end sound rather than 404-ing: a stale page must
          // still be able to play *something*.
          const kind = requested === 'question' || requested === 'approval' ? 'question' : 'turn-end'
          const { path } = resolveSound(kind, config)
          const described = describeSound(kind, config)
          if (described.ok !== true) {
            plain(res, described.error === 'too-large' ? 413 : 404, `unreadable: ${String(described.error)}`)
            return
          }

          let bytes
          try {
            bytes = readFileSync(path)
          } catch (error) {
            plain(res, 500, `unreadable: ${String(error?.code ?? error?.message ?? error)}`)
            return
          }

          res.writeHead(200, {
            'content-type': described.mediaType,
            'content-length': bytes.length,
            // The user can point the setting at a different file at any moment;
            // a cached body would keep announcing the old one.
            'cache-control': 'no-store',
          })
          res.end(req.method === 'HEAD' ? undefined : bytes)
        },
      }),
    'agent-alerts: sound route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/status`,
        handler: (req, res) => {
          const refusal = admissionOf(ctx.connection, req)
          if (refusal !== null) {
            plain(res, refusal, 'refused')
            return
          }
          json(res, 200, {
            sounds: [describeSound('turn-end', config), describeSound('question', config)],
            maxBytes: MAX_BYTES,
          })
        },
      }),
    'agent-alerts: status route',
  )
}
