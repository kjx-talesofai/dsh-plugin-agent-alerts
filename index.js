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

import { execFile } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import z from '@deepseek-ai/schemastery'

const execFileAsync = promisify(execFile)

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
 * The system-notification fallback.
 *
 * The banner a page raises is the honest one — it carries the Harness name and
 * icon, and clicking it is what opens the session — but it depends on the
 * *operating system* having granted this application permission, and that grant
 * can be left undetermined in a way the page cannot observe: `permission`
 * reports `granted` because that is Electron's own gate, not macOS's. When that
 * happens the page constructs notifications forever and none is ever displayed.
 *
 * This fallback goes around it: the Host asks the system to notify on its
 * behalf, through an identity macOS has already registered. The banner is then
 * attributed to Script Editor rather than to the Harness, which is why it is a
 * choice rather than the default.
 *
 * The script reads its text from `argv`, never from interpolation, and the two
 * arguments are preceded by `--` so that option parsing stops before them. Both
 * halves are required. Without `--`, a title beginning with `-` is consumed by
 * `getopt` as another `-e` option: the text silently never reaches `argv`, and
 * what the argument *does* become depends on whether the two scripts happen to
 * concatenate into something that compiles. That is an accident, not a defence,
 * and an earlier revision of this file shipped without it.
 */
const OSASCRIPT = '/usr/bin/osascript'

/** Reads `argv`, so nothing user-supplied is ever parsed as script. */
const NOTIFY_SCRIPT = 'on run argv\n  display notification (item 2 of argv) with title (item 1 of argv)\nend run'

/** How much of a notification request the Host will read. */
const MAX_NOTIFY_BYTES = 4096

/**
 * Live settings.
 *
 * Every field is a choice the user is allowed to change while the app runs;
 * none of them is technical enough to belong in a hand-edited file only.
 *
 * `quietWhenFocused` defaults to **false**, and that default was changed after
 * shipping: it was true on the reasoning that a notification for something
 * already on screen is noise. The reasoning is still fine, but the setting cost
 * more than it bought — a user who leaves it on sees the sound fire and no
 * banner, cannot tell that this switch is the reason, and concludes the whole
 * notification path is broken. It did exactly that here. Alerting by default and
 * letting the user opt into quiet is the safer way round.
 */
export const Config = z.object({
  turnEnd: z.boolean().default(true).volatile().description('Alert when an agent finishes a turn.'),
  question: z.boolean().default(true).volatile().description('Alert when an agent asks you a question.'),
  approval: z.boolean().default(true).volatile().description('Alert when an agent needs your approval to run a tool.'),
  sound: z.boolean().default(true).volatile().description('Play a sound with the alert.'),
  notifyMode: z
    .union(['off', 'banner', 'system'])
    .default('banner')
    .volatile()
    .description('How to notify: off, a banner from the app, or the system fallback.'),
  quietWhenFocused: z.boolean().default(false).volatile().description('Skip the notification while the Harness window is focused. The sound still plays.'),
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
  // A configured path is checked against the media-type table rather than served
  // blind. Without this the route reads the first 16 MB of *any* file whose path
  // can be written into the settings — and the settings are writable from the
  // page — which would make it a general file reader wearing a sound route's
  // clothes. The claim is only true if it is enforced.
  if (source === 'custom' && MEDIA_TYPES[extname(path).toLowerCase()] === undefined) {
    return { kind, source, ok: false, error: 'not-an-audio-file', path }
  }
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

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/notify`,
        handler: async (req, res) => {
          const refusal = admissionOf(ctx.connection, req)
          if (refusal !== null) {
            plain(res, refusal, 'refused')
            return
          }
          if (req.method !== 'POST') {
            plain(res, 405, 'method-not-allowed')
            return
          }
          if (process.platform !== 'darwin') {
            json(res, 501, { ok: false, error: 'system-notifications-are-macos-only' })
            return
          }

          let payload
          try {
            payload = JSON.parse(await readBody(req, MAX_NOTIFY_BYTES))
          } catch (error) {
            json(res, 400, { ok: false, error: String(error?.message ?? error) })
            return
          }

          const title = trimTo(payload?.title, 200)
          const text = trimTo(payload?.body, 400)
          try {
            // `--` is load-bearing: it is the difference between "the text is
            // argv" and "the text is whatever getopt decides it is".
            await execFileAsync(OSASCRIPT, ['-e', NOTIFY_SCRIPT, '--', title, text], { timeout: 5000, maxBuffer: 64 * 1024 })
            json(res, 200, { ok: true })
          } catch (error) {
            json(res, 502, { ok: false, error: String(error?.message ?? error) })
          }
        },
      }),
    'agent-alerts: system notification route',
  )
}

/**
 * Read a bounded request body.
 *
 * @param req - The incoming request.
 * @param limit - Byte ceiling; beyond it the request is destroyed.
 * @returns The decoded body.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (error === undefined) resolve(value)
      else reject(error)
    }
    req.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > limit) {
        finish(new Error('body-too-large'))
        req.destroy?.()
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => finish(undefined, Buffer.concat(chunks).toString('utf8')))
    req.on('error', (error) => finish(error))
    // An aborted POST emits neither `end` nor `error`. Without these the promise
    // and its handler outlive the request, once per abandoned call.
    req.on('aborted', () => finish(new Error('request-aborted')))
    req.on('close', () => finish(new Error('request-aborted')))
  })
}

/**
 * Flatten and cap one line of notification text.
 *
 * @param value - Untrusted value from the request.
 * @param limit - Maximum length.
 * @returns A single-line string, possibly empty.
 */
function trimTo(value, limit) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > limit ? text.slice(0, limit) : text
}
