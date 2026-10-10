/**
 * Agent Alerts — test suite.
 *
 * Four properties make this suite worth running on a bare checkout:
 *
 *   1. The browser half is evaluated as a **script** under a small hooks
 *      runtime, never imported, so the one dependency the package declares
 *      (`@deepseek-ai/schemastery`, needed only to state the settings schema)
 *      does not have to be installed for the suite to pass.
 *   2. The Host half is read as **text**. Its exports are asserted from the
 *      source, which is what keeps the two halves in step without a build step
 *      or a shared module.
 *   3. The hooks runtime is real enough to re-render: the settings page reads
 *      the filesystem verdict asynchronously, and a harness whose `useState` is
 *      inert would only ever test a fossil of the first render.
 *   4. The behaviours that matter are consequences of ordering — a first
 *      sighting is not a transition, a settled turn is confirmed before it is
 *      announced, two sources reporting one question are one alert — and each is
 *      driven here rather than described.
 *
 * @module dsh-plugin-agent-alerts/test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/** The Host half as text: the suite must never need its dependency installed. */
const HOST_SOURCE = readFileSync(join(ROOT, 'index.js'), 'utf8')
const CLIENT_SOURCE = readFileSync(join(ROOT, 'client.js'), 'utf8')

/** The settle window the browser half holds a finished turn for. */
const SETTLE_MS = 1500

/** Let queued microtasks settle. */
const tick = () => new Promise((resolve) => setImmediate(resolve))

//#region a hooks runtime small enough to read

/**
 * A React stand-in with real hook storage.
 *
 * `useState` persists per component identity, `useEffect` compares dependencies
 * the way React does, and a state change schedules another pass over the same
 * root. A render pass expands every function component into host elements, so
 * the tree a test inspects never re-invokes a component body and can never
 * disturb the hook store it came from.
 *
 * @returns The React object and the mounting surface.
 */
function createRuntime() {
  const hooks = new Map()
  const pendingEffects = []
  const effectRecords = new Map()
  const cleanups = []
  let currentType = null
  let cursor = 0
  let root = null
  let tree = null
  let scheduled = false

  /**
   * Run `body` with the hook cursor scoped to one mounted instance.
   *
   * The key is the instance's position in the tree, not its component type: two
   * `TextRow` fields are two instances of one type, and keying them by type
   * would make them share a slot and re-render against each other forever.
   */
  function withHooks(key, body) {
    const previousType = currentType
    const previousCursor = cursor
    currentType = key
    cursor = 0
    try {
      return body()
    } finally {
      currentType = previousType
      cursor = previousCursor
    }
  }

  /** The hook slot list for the component currently rendering. */
  function slotsFor() {
    const existing = hooks.get(currentType)
    if (existing !== undefined) return existing
    const created = []
    hooks.set(currentType, created)
    return created
  }

  /** Schedule one more pass over the same root, coalescing bursts. */
  function schedule() {
    if (scheduled || root === null) return
    scheduled = true
    Promise.resolve().then(() => {
      scheduled = false
      if (root !== null) render(root)
    })
  }

  const React = {
    createElement(type, props, ...children) {
      const next = { ...(props ?? {}) }
      if (children.length > 0) next.children = children.length > 1 ? children : children[0]
      return { $$element: true, type, props: next }
    },
    useState(initial) {
      const slots = slotsFor()
      const index = cursor
      cursor += 1
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        const value = typeof next === 'function' ? next(slots[index]) : next
        // React bails out on an identical value; without the same guard an
        // effect that re-reads an unchanged snapshot would render forever.
        if (Object.is(slots[index], value)) return
        slots[index] = value
        schedule()
      }
      return [slots[index], set]
    },
    useRef(initial) {
      const slots = slotsFor()
      const index = cursor
      cursor += 1
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useReducer(reducer, initial) {
      const [value, set] = React.useState(initial)
      return [value, (action) => set(reducer(value, action))]
    },
    useEffect(effect, deps) {
      const slots = slotsFor()
      const index = cursor
      cursor += 1
      pendingEffects.push({ type: currentType, index, effect, deps, slot: slots, key: `${index}` })
    },
  }

  /** Expand one element into host elements, running function component bodies. */
  function expand(element, path = 'root', depth = 0) {
    if (depth > 80 || element === null || element === undefined || typeof element === 'boolean') return null
    if (typeof element === 'string' || typeof element === 'number') return element
    if (Array.isArray(element)) return element.map((child, index) => expand(child, `${path}.${index}`, depth + 1))
    if (element.$$element !== true) return null
    if (typeof element.type === 'function') {
      const produced = withHooks(path, () => element.type(element.props))
      return expand(produced, `${path}>`, depth + 1)
    }
    return { ...element, props: { ...element.props, children: expand(element.props?.children, path, depth + 1) } }
  }

  /** Run every effect whose dependencies changed, in render order. */
  function flushEffects() {
    const batch = pendingEffects.splice(0, pendingEffects.length)
    for (const entry of batch) {
      const record = effectRecords.get(entry.type)?.[entry.index]
      const previousDeps = record?.deps
      const changed =
        entry.deps === undefined ||
        previousDeps === undefined ||
        entry.deps.length !== previousDeps.length ||
        entry.deps.some((dep, index) => !Object.is(dep, previousDeps[index]))
      if (!changed) continue
      if (typeof record?.cleanup === 'function') {
        try {
          record.cleanup()
        } catch (error) {
          console.error('effect cleanup threw', error)
        }
      }
      const cleanup = entry.effect()
      const byType = effectRecords.get(entry.type) ?? []
      byType[entry.index] = { deps: entry.deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }
      effectRecords.set(entry.type, byType)
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    }
  }

  /** Render one root element and return the expanded tree. */
  function render(element) {
    root = element
    currentType = null
    cursor = 0
    pendingEffects.length = 0
    tree = expand(element)
    flushEffects()
    return tree
  }

  return {
    React,
    cleanups,
    render,
    current: () => tree,
  }
}

/** Flatten the text of an already-expanded tree. */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return textOf(node.props?.children)
}

/** Collect the host elements of an expanded tree that satisfy a predicate. */
function findIn(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return found
  if (typeof node === 'string' || typeof node === 'number') return found
  if (Array.isArray(node)) {
    for (const child of node) findIn(child, predicate, found)
    return found
  }
  if (predicate(node)) found.push(node)
  findIn(node.props?.children, predicate, found)
  return found
}

//#endregion

//#region environments

/**
 * Build the browser globals the client half expects.
 *
 * Time is controlled: the settle window, the suppression window, and the laziest
 * possible bug — whether the timer fired before or after the re-check — are all
 * decidable only with a clock the test owns.
 *
 * @param options - Environment tweaks.
 * @returns The environment handle.
 */
function browserEnvironment(options = {}) {
  const record = { notifications: [], instances: [], played: [], fetches: [], posts: [], styles: [], focusCalls: 0 }
  const runtime = createRuntime()

  let clock = 1_700_000_000_000
  let nextTimerId = 1
  const timers = new Map()

  const DateStub = function DateStub(...args) {
    return new Date(...args)
  }
  DateStub.now = () => clock

  class FakeNotification {
    constructor(title, opts) {
      record.notifications.push({ title, options: opts ?? {}, closed: false })
      record.instances.push(this)
      this.index = record.notifications.length - 1
      this.onclick = null
      this.onshow = null
      this.onerror = null
      this.onclose = null
      setTimeout(() => {
        try {
          this.onshow?.()
        } catch {
          /* a test handler may throw; the fake must not */
        }
      }, 0)
    }
    close() {
      record.notifications[this.index].closed = true
      if (typeof this.onclose === 'function') this.onclose()
    }
  }

  class FakeAudio {
    constructor(url) {
      this.src = String(url)
      this.readyState = 4
      this.duration = 1.5
      this.error = null
      this.preload = 'none'
      this.volume = 1
      this.currentTime = 0
    }
    addEventListener() {}
    removeEventListener() {}
    load() {}
    pause() {}
    play() {
      record.played.push({ src: this.src, volume: this.volume })
      return Promise.resolve()
    }
  }

  const context = {
    console,
    setTimeout: (callback, delay = 0) => {
      const id = nextTimerId
      nextTimerId += 1
      timers.set(id, { at: clock + Number(delay), callback })
      return id
    },
    clearTimeout: (id) => {
      timers.delete(id)
    },
    setInterval: (callback) => {
      const id = nextTimerId
      nextTimerId += 1
      timers.set(id, { at: clock, callback, repeating: true })
      return id
    },
    clearInterval: (id) => {
      timers.delete(id)
    },
    Date: DateStub,
    URL,
    JSON,
    Object,
    Array,
    Number,
    String,
    Boolean,
    Math,
    Promise,
    Error,
    Map,
    Set,
    fetch: async (url, init) => {
      record.fetches.push(String(url))
      if (init?.method === 'POST') {
        record.posts.push({ url: String(url), body: String(init.body ?? '') })
        if (options.notifyFails === true) return { ok: false, status: 401, text: async () => 'refused', json: async () => ({}) }
      }
      if (String(url).includes('/status')) {
        if (options.statusFails === true) throw new Error('status route unreachable')
        return { ok: true, status: 200, json: async () => ({ sounds: options.sounds ?? [] }), text: async () => '{}', arrayBuffer: async () => new ArrayBuffer(8) }
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}', arrayBuffer: async () => new ArrayBuffer(2048) }
    },
    document: {
      visibilityState: options.visibilityState ?? 'visible',
      hasFocus: () => options.hasFocus ?? true,
      head: { appendChild: (node) => record.styles.push(node) },
      querySelector: () => null,
      createElement: (tag) => ({ tag, attributes: {}, setAttribute(key, value) { this.attributes[key] = value }, remove() {} }),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    window: {
      location: { origin: 'dsh-app://app' },
      addEventListener: () => {},
      removeEventListener: () => {},
      focus: () => {
        record.focusCalls += 1
      },
    },
  }
  if (options.notification !== false) context.Notification = FakeNotification
  context.globalThis = context
  context.Audio = FakeAudio
  context.window.Audio = FakeAudio
  context.window.Notification = context.Notification
  Object.assign(context.window, { focus: context.window.focus })

  let definition
  context.window.__ModuleLoader__ = { load: (value) => { definition = value } }

  vm.createContext(context)
  new vm.Script(CLIENT_SOURCE, { filename: 'client.js' }).runInContext(context)
  assert.ok(definition !== undefined, 'client.js must register through window.__ModuleLoader__')

  const exports_ = definition.factory((name) => {
    if (name === 'react') return runtime.React
    throw new Error(`unexpected require(${JSON.stringify(name)})`)
  })

  return {
    record,
    runtime,
    exports: exports_,
    /** Move the clock and run every timer that becomes due, in order. */
    advance(ms) {
      const target = clock + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((left, right) => left[1].at - right[1].at)
        if (due.length === 0) break
        const [id, timer] = due[0]
        if (timer.repeating !== true) timers.delete(id)
        else timer.at = clock + ms + 1
        clock = Math.max(clock, timer.at)
        timer.callback()
      }
      clock = target
    },
  }
}

/**
 * Build a Client context stub.
 *
 * @param services - Service table keyed by name.
 * @returns The stub context and its record.
 */
function clientContext(services = {}) {
  const record = { slotInjections: [], registrations: [], effectLabels: [], disposers: [], localeRegistrations: [], requested: [], missing: [], opened: [] }

  let dictionaries
  const translate = (key, params) => {
    record.requested.push(key)
    const template = dictionaries?.en?.[key]
    if (template === undefined) {
      record.missing.push(key)
      return key
    }
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
  }

  const ctx = {
    get: (name) => services[name],
    on: () => () => {},
    effect: (callback, label) => {
      record.effectLabels.push(label)
      const dispose = callback()
      const disposer = () => {
        if (typeof dispose === 'function') dispose()
      }
      record.disposers.push(disposer)
      return disposer
    },
    locale: {
      register: (ns, dicts) => {
        dictionaries = dicts
        record.localeRegistrations.push({ ns, dicts })
        return () => {}
      },
      bind: () => translate,
      resolveText: (text) => text,
    },
    slots: {
      inject: (key, callback) => {
        record.slotInjections.push(key)
        const dispose = callback()
        return () => {
          if (typeof dispose === 'function') dispose()
        }
      },
      register: (options, component) => {
        record.registrations.push({ options, component })
        return () => {}
      },
    },
    uiWorkspace: {
      openSession: (id) => {
        record.opened.push(id)
      },
    },
  }
  // Cordis injects a service as a property of the context as well as through
  // `ctx.get`. A stub with only `get` would make `ctx.sessions.scopeOf(...)`
  // silently resolve to nothing, and a test of that path would pass by silence.
  for (const [name, service] of Object.entries(services)) {
    if (!(name in ctx)) ctx[name] = service
  }
  return { ctx, record }
}

/**
 * A `configForms` stub with one controller and a settable snapshot.
 *
 * @param initial - Initial Config value.
 * @returns The service, the recorded writes, and a publisher.
 */
function configFormsStub(initial = {}) {
  const listeners = new Set()
  let snapshot = { status: 'ready', value: initial, revision: 1, writable: true }
  const writes = []
  const form = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (field, value) => {
      writes.push({ field, value })
      snapshot = { ...snapshot, value: { ...snapshot.value, [field]: value }, revision: snapshot.revision + 1 }
      for (const listener of listeners) listener()
      return Promise.resolve(true)
    },
    mutate: (ops) => {
      writes.push({ ops })
      return Promise.resolve(true)
    },
  }
  return {
    service: { get: () => form, describe: () => ({ getSnapshot: () => ({ view: { namespaces: [{ ns: 'agent-alerts' }] } }) }) },
    writes,
    publish(value) {
      snapshot = { ...snapshot, value, revision: snapshot.revision + 1 }
      for (const listener of listeners) listener()
    },
  }
}

/** A `uiSession.sessionStatus` stub the test drives by hand. */
function sessionStatusStub() {
  const listeners = []
  let snapshot = new Map()
  return {
    service: {
      sessionStatus: {
        subscribe: (listener) => {
          listeners.push(listener)
          return () => {
            const index = listeners.indexOf(listener)
            if (index !== -1) listeners.splice(index, 1)
          }
        },
        getSnapshot: () => snapshot,
      },
    },
    publish(next) {
      snapshot = next instanceof Map ? next : new Map(Object.entries(next))
      for (const listener of listeners) listener()
    },
    listeners,
  }
}

/**
 * A session list snapshot, for title and origin lookups.
 *
 * `scopeOf` is the application's own agent → session mapping, and the forwarded
 * events need it to name a session at all; without it that source stays silent
 * and a test of it would pass for the wrong reason.
 */
function sessionsStub(rows = {}, carrierSession = Object.keys(rows)[0]) {
  return {
    list: { getSnapshot: () => ({ ids: Object.keys(rows), byId: rows, phase: 'ready' }), subscribe: () => () => {} },
    scopeOf: () => carrierSession,
  }
}

//#endregion

//#region Host half, read as text

/** Every `Config` key the Host half declares, in declaration order. */
function hostConfigKeys() {
  const block = HOST_SOURCE.split('export const Config = z.object({')[1]?.split('})')[0]
  assert.ok(block !== undefined, 'the Host half must declare a Config schema')
  return [...block.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1])
}

/** The route prefix the Host half registers. */
function hostRoute() {
  const match = /const ROUTE = '([^']+)'/.exec(HOST_SOURCE)
  assert.ok(match !== null, 'the Host half must declare a ROUTE')
  return match[1]
}

/** The route prefix the browser half calls. */
function clientRoute() {
  const match = /const ROUTE = '([^']+)'/.exec(CLIENT_SOURCE)
  assert.ok(match !== null, 'the browser half must declare a ROUTE')
  return match[1]
}

/**
 * Evaluate the Host half with stubbed imports.
 *
 * The file is ESM with three package imports, and one of them
 * (`@deepseek-ai/schemastery`) is the package's only dependency — which a bare
 * checkout does not have. Stripping the imports and running the body with
 * `z`, the filesystem, and the path helpers injected keeps the suite
 * dependency-free while still executing the real handlers.
 *
 * @param options - `fs` overrides for the read paths.
 * @returns `{ Config, apply, inject, volatileCount, routes }`.
 */
function loadHostHalf(options = {}) {
  const fs = {
    readFileSync: options.readFileSync ?? (() => Buffer.from('bundled-bytes')),
    statSync: options.statSync ?? (() => ({ isFile: () => true, size: 12 })),
  }
  let volatileCount = 0
  const field = () => {
    const api = {
      meta: {},
      default: (value) => {
        api.meta.default = value
        return api
      },
      volatile: () => {
        volatileCount += 1
        return api
      },
      min: () => api,
      max: () => api,
      step: () => api,
      description: () => api,
    }
    return api
  }
  const z = {
    object: (shape) => shape,
    boolean: field,
    number: field,
    string: field,
    // `z.union([...literals])` is how the surrounding code declares an enum, so
    // the stub keeps the option list where an assertion can reach it.
    union: (options) => {
      const api = field()
      api.options = options
      return api
    },
  }

  const execFile =
    options.execFile ??
    ((file, args, opts, callback) => {
      callback(null, { stdout: '', stderr: '' })
    })

  const body = HOST_SOURCE
    .replace(/^import .*$/gm, '')
    // `import.meta` is a module-only form and a `vm.Script` is not a module;
    // the directory is the only thing the Host half uses it for.
    .replace(/^const HERE = .*$/m, "const HERE = '/plugin'")
    .replace(/^export /gm, '')
    .concat('\n__host.Config = Config; __host.apply = apply; __host.inject = inject;\n')

  const context = {
    console,
    z,
    execFile,
    promisify,
    process: { platform: options.platform ?? 'darwin' },
    readFileSync: fs.readFileSync,
    statSync: fs.statSync,
    dirname,
    join,
    extname,
    Buffer,
    URL,
    JSON,
    Object,
    Reflect,
    Array,
    Number,
    String,
    Boolean,
    Math,
    Promise,
    Error,
    Map,
    Set,
    __host: {},
  }
  context.globalThis = context
  vm.createContext(context)
  new vm.Script(body, { filename: 'index.js' }).runInContext(context)
  const host = context.__host
  assert.ok(typeof host.apply === 'function', 'the Host half must export apply')

  /** Mount it and collect the registered routes. */
  const mountHost = (connection = { admit: () => ({}) }) => {
    const routes = new Map()
    host.apply(
      {
        connection,
        webServer: {
          register: (route) => {
            routes.set(route.path, route)
            return () => routes.delete(route.path)
          },
        },
        effect: (callback) => {
          const dispose = callback()
          return () => {
            if (typeof dispose === 'function') dispose()
          }
        },
      },
      options.config ?? {},
    )
    return routes
  }

  return { Config: host.Config, apply: host.apply, inject: host.inject, volatileCount, mountHost }
}

/**
 * Drive one registered route the way Node's HTTP server would, awaiting an
 * asynchronous handler and feeding it a body.
 *
 * @param routes - The route table from `mountHost`.
 * @param path - Route path.
 * @param url - Request URL.
 * @param options - `method`, `headers`, and `body`.
 * @returns `{ status, headers, body }`.
 */
async function callRouteAsync(routes, path, url, options = {}) {
  const chunks = []
  const state = { status: 0, headers: null }
  const res = {
    writeHead(status, responseHeaders) {
      state.status = status
      state.headers = responseHeaders
    },
    end(body) {
      if (body !== undefined) chunks.push(Buffer.from(body))
    },
  }
  const body = options.body
  const req = {
    url,
    method: options.method ?? 'POST',
    headers: options.headers ?? {},
    // Listeners are registered in order by the reader, so dispatching on
    // registration is enough to look like a request that already arrived.
    on(event, handler) {
      if (event === 'data' && body !== undefined) handler(Buffer.from(body))
      if (event === 'end') handler()
      return req
    },
    destroy() {},
  }
  await routes.get(path).handler(req, res)
  return { ...state, body: Buffer.concat(chunks) }
}

/** Drive one registered route the way Node's HTTP server would. */
function callRoute(routes, path, url, headers = {}, method = 'GET') {
  const chunks = []
  const state = { status: 0, headers: null }
  const res = {
    writeHead(status, responseHeaders) {
      state.status = status
      state.headers = responseHeaders
    },
    end(body) {
      if (body !== undefined) chunks.push(Buffer.from(body))
    },
  }
  routes.get(path).handler({ url, method, headers }, res)
  return { ...state, body: Buffer.concat(chunks) }
}

//#endregion

test('the Host half declares a settings schema and a route prefix', () => {
  const host = loadHostHalf()
  // The stub returns the shape itself; the real `schemastery` returns a Schema
  // whose `dict` is the shape. Reading both keeps the assertion honest under
  // either, and it is checked against the live library in the README's terms.
  const shape = host.Config.dict ?? host.Config
  assert.deepEqual(Object.keys(shape), hostConfigKeys(), 'the evaluated schema and the source must agree')

  // The shipped default is a product decision, not an implementation detail: it
  // was `true` once, and the cost was a user watching the sound fire with no
  // banner and no way to learn that this switch was why.
  assert.equal(shape.quietWhenFocused.meta.default, false, 'the shipped default alerts rather than going quiet')
  assert.equal(shape.notifyMode.meta.default, 'banner')
  assert.equal(host.volatileCount, hostConfigKeys().length, 'every Config field must be volatile, not just most of them')

  const keys = hostConfigKeys()
  assert.deepEqual(keys, [
    'turnEnd',
    'question',
    'approval',
    'sound',
    'notifyMode',
    'quietWhenFocused',
    'volume',
    'turnEndSound',
    'questionSound',
  ])

  // Only volatile fields are exposed to the page and accepted on write; without
  // it the namespace never appears at all.
  const block = HOST_SOURCE.split('export const Config = z.object({')[1].split('})')[0]
  assert.equal([...block.matchAll(/\.volatile\(\)/g)].length, keys.length, 'every Config field must be volatile')

  assert.equal(hostRoute(), '/api/agent-alerts')
  assert.equal(clientRoute(), hostRoute(), 'both halves must agree about the route prefix')
  assert.match(HOST_SOURCE, /path: `\$\{ROUTE\}\/sound`/)
  assert.match(HOST_SOURCE, /path: `\$\{ROUTE\}\/status`/)

  // The route must never take a path from the request: it resolves one out of
  // this plugin's own config, so it cannot become a general file read.
  assert.match(HOST_SOURCE, /function resolveSound\(kind, config\)/)
  assert.equal([...HOST_SOURCE.matchAll(/admissionOf\(ctx\.connection, req\)/g)].length, 3, 'every route is gated')
  // Spread: the array crosses a vm realm, so its prototype is not this one's.
  assert.deepEqual([...host.inject], ['webServer', 'connection'])
})

test('the sound route serves the bundled bytes, and refuses an unadmitted caller', () => {
  const read = []
  const host = loadHostHalf({
    readFileSync: (path) => {
      read.push(path)
      return Buffer.from(`bytes:${path}`)
    },
  })

  const routes = host.mountHost()
  assert.deepEqual([...routes.keys()].sort(), [
    '/api/agent-alerts/notify',
    '/api/agent-alerts/sound',
    '/api/agent-alerts/status',
  ])

  const turnEnd = callRoute(routes, '/api/agent-alerts/sound', '/api/agent-alerts/sound?kind=turn-end')
  assert.equal(turnEnd.status, 200)
  assert.equal(turnEnd.headers['content-type'], 'audio/mpeg')
  assert.equal(turnEnd.headers['cache-control'], 'no-store', 'a cached body would keep announcing an old file')
  assert.match(turnEnd.body.toString(), /duo_finish\.mp3$/)
  assert.match(read[0], /assets[/\\]duo_finish\.mp3$/)

  // An approval is the same moment as a question and shares its sound.
  const approval = callRoute(routes, '/api/agent-alerts/sound', '/api/agent-alerts/sound?kind=approval')
  assert.match(approval.body.toString(), /duo_question\.mp3$/)

  // An unknown kind falls back rather than 404-ing: a stale page must still be
  // able to play something.
  const unknown = callRoute(routes, '/api/agent-alerts/sound', '/api/agent-alerts/sound?kind=nonsense')
  assert.equal(unknown.status, 200)
  assert.match(unknown.body.toString(), /duo_finish\.mp3$/)

  // The admission fence, on both routes.
  const refused = host.mountHost({ admit: () => ({ rejection: 403 }) })
  assert.equal(callRoute(refused, '/api/agent-alerts/sound', '/api/agent-alerts/sound?kind=turn-end').status, 403)
  assert.equal(callRoute(refused, '/api/agent-alerts/status', '/api/agent-alerts/status').status, 403)

  // An unrecognisable admission contract refuses rather than admitting.
  const opaque = host.mountHost({})
  assert.equal(callRoute(opaque, '/api/agent-alerts/sound', '/api/agent-alerts/sound?kind=turn-end').status, 503)
})

test('a configured path wins, and every way it can fail is reported', () => {
  const read = []
  const host = loadHostHalf({
    readFileSync: (path) => {
      read.push(path)
      return Buffer.from('custom-bytes')
    },
  })

  const custom = host.mountHost({ admit: () => ({}) })
  assert.equal(callRoute(custom, '/api/agent-alerts/sound', '/api/agent-alerts/sound?kind=turn-end').status, 200)
  assert.match(read[0], /duo_finish\.mp3$/, 'with no configured path the bundled file is read')

  const configured = loadHostHalf({
    config: { turnEndSound: '  /Users/me/done.wav  ', questionSound: '/Users/me/ask.mp3' },
    readFileSync: (path) => {
      read.push(path)
      return Buffer.from('custom-bytes')
    },
  })
  const routes = configured.mountHost({ admit: () => ({}) })
  const answer = callRoute(routes, '/api/agent-alerts/sound', '/api/agent-alerts/sound?kind=turn-end')
  assert.equal(read.at(-1), '/Users/me/done.wav', 'the configured path is trimmed and used verbatim')
  assert.equal(answer.headers['content-type'], 'audio/wav', 'the media type follows the extension, not the default')
  callRoute(routes, '/api/agent-alerts/sound', '/api/agent-alerts/sound?kind=question')
  assert.equal(read.at(-1), '/Users/me/ask.mp3')

  // A path that cannot be read is a 404 naming the reason, not a silent empty body.
  const missing = loadHostHalf({
    config: { turnEndSound: '/nope.mp3' },
    statSync: () => {
      const error = new Error('no such file')
      error.code = 'ENOENT'
      throw error
    },
  })
  const missingRoutes = missing.mountHost({ admit: () => ({}) })
  const absent = callRoute(missingRoutes, '/api/agent-alerts/sound', '/api/agent-alerts/sound?kind=turn-end')
  assert.equal(absent.status, 404)
  assert.match(absent.body.toString(), /ENOENT/)

  const status = callRoute(missingRoutes, '/api/agent-alerts/status', '/api/agent-alerts/status')
  const report = JSON.parse(status.body.toString())
  assert.equal(report.sounds[0].source, 'custom')
  assert.equal(report.sounds[0].ok, false)
  assert.equal(report.sounds[0].error, 'ENOENT')
  assert.equal(report.sounds[1].source, 'bundled', 'the other moment still reports the bundled file')

  // An accidentally enormous file fails loudly instead of stalling the page.
  const huge = loadHostHalf({
    config: { turnEndSound: '/huge.mp3' },
    statSync: () => ({ isFile: () => true, size: 64 * 1024 * 1024 }),
  })
  const hugeRoutes = huge.mountHost({ admit: () => ({}) })
  assert.equal(callRoute(hugeRoutes, '/api/agent-alerts/sound', '/api/agent-alerts/sound?kind=turn-end').status, 413)

  // A directory is not a sound.
  const directory = loadHostHalf({
    config: { turnEndSound: '/some/dir' },
    statSync: () => ({ isFile: () => false, size: 0 }),
  })
  assert.equal(
    callRoute(directory.mountHost({ admit: () => ({}) }), '/api/agent-alerts/sound', '/api/agent-alerts/sound?kind=turn-end').status,
    404,
  )
})

test('a volatile setting is read at request time, not at mount time', () => {
  // `.volatile()` members arrive as live references with their own `get()`, so a
  // value captured when the plugin mounted would freeze the setting until the
  // app restarted. Nothing else in the suite would notice that.
  let current = '/first.mp3'
  const read = []
  const host = loadHostHalf({
    config: { turnEndSound: { get: () => current } },
    readFileSync: (path) => {
      read.push(path)
      return Buffer.from('bytes')
    },
  })
  const routes = host.mountHost({ admit: () => ({}) })

  callRoute(routes, '/api/agent-alerts/sound', '/api/agent-alerts/sound?kind=turn-end')
  assert.equal(read.at(-1), '/first.mp3')

  current = '/second.mp3'
  callRoute(routes, '/api/agent-alerts/sound', '/api/agent-alerts/sound?kind=turn-end')
  assert.equal(read.at(-1), '/second.mp3', 'the reference is re-read on every request')
})

/**
 * Mount the plugin against the standard service set.
 *
 * @param options - Environment and service tweaks.
 * @returns Everything a test needs to drive it.
 */
async function mount(options = {}) {
  const env = browserEnvironment(options)
  const status = sessionStatusStub()
  const forms = configFormsStub(options.config ?? {})
  const waterfall = new Map()
  const { ctx, record } = clientContext({
    uiSession: status.service,
    sessions: sessionsStub(options.sessions ?? {}),
    configForms: forms.service,
    remote: { $on: (event, listener) => { waterfall.set(event, listener); return () => {} } },
    ...options.services,
  })
  env.exports.apply(ctx)
  await tick()
  return { env, status, forms, waterfall, ctx, record }
}

test('the browser half mounts, subscribes to both sources, and registers its page', async () => {
  const { env, status, record } = await mount({ sessions: { s1: { id: 's1', running: false, displayTitle: 'A session', origin: 'main' } } })

  assert.deepEqual([...env.exports.inject], ['slots', 'locale'])
  assert.deepEqual(record.slotInjections, ['plugins.row.config'])
  assert.equal(record.registrations.length, 1)
  assert.equal(record.registrations[0].options.key, 'dsh-plugin-agent-alerts#agent-alerts')
  assert.equal(record.registrations[0].options.locale, 'dsh-plugin-agent-alerts')

  // The status map is the load-bearing source; the forwarded events are the
  // best-effort second opinion and are subscribed too.
  assert.equal(status.listeners.length, 1, 'the session status map must be subscribed')
  assert.ok(record.effectLabels.some((label) => label.includes('session status')))
  assert.ok(record.effectLabels.some((label) => label.includes('user-questions/request')))
  assert.ok(record.effectLabels.some((label) => label.includes('approval/request')))

  for (const dispose of record.disposers) dispose()
})

test('a first sighting is not a transition', async () => {
  const { env, status, record } = await mount()

  // The very first snapshot describes the world as it already is. At boot the
  // application marks every historically idle session `completionUnread`; a
  // plugin that treated that as news would fire one alert per old session on
  // every launch.
  status.publish(new Map([['old', { running: false, pendingInteraction: undefined, completionUnread: true }]]))
  env.advance(SETTLE_MS * 4)

  assert.equal(env.record.played.length, 0, 'no sound for a session that was already idle')
  assert.equal(env.record.notifications.length, 0, 'no banner for a session that was already idle')

  // The reload-while-a-question-is-open case: the first snapshot already carries
  // a pending interaction. Re-announcing it would fire for every question that
  // was already on screen when the page loaded.
  status.publish(
    new Map([
      ['old', { running: false, completionUnread: true }],
      ['waiting', { running: false, pendingInteraction: { kind: 'question', questions: [{ question: 'Still here?' }] } }],
    ]),
  )
  assert.equal(env.record.played.length, 0, 'a question that was already pending is not news')
  assert.equal(env.record.notifications.length, 0)

  for (const dispose of record.disposers) dispose()
})

test('a settled turn rings once, and a resumed round does not ring at all', async () => {
  const { env, status, record } = await mount({
    hasFocus: false,
    sessions: { s1: { id: 's1', running: false, displayTitle: 'Fix the parser', origin: 'main' } },
  })

  status.publish(new Map([['s1', { running: false }]]))
  status.publish(new Map([['s1', { running: true }]]))
  assert.equal(env.record.played.length, 0, 'a turn starting is not an alert')

  status.publish(new Map([['s1', { running: false }]]))
  assert.equal(env.record.played.length, 0, 'the alert is held, not raised immediately')
  env.advance(SETTLE_MS)
  assert.equal(env.record.played.length, 1, 'the finished turn rings once')
  assert.equal(env.record.played[0].src, '/api/agent-alerts/sound?kind=turn-end')
  assert.equal(env.record.notifications.length, 1)
  assert.equal(env.record.notifications[0].title, 'Finished')
  assert.equal(env.record.notifications[0].options.body, 'Fix the parser')
  assert.equal(env.record.notifications[0].options.silent, true)

  // A goal round closes its turn and opens the next one *inside* the window —
  // a second later, before the settle timer has fired. Announcing at the moment
  // the turn closed would say "finished" while the next round was starting.
  //
  // The suppression window has to be stepped over first, or it would absorb the
  // second alert and this case would pass for the wrong reason.
  env.advance(5000)
  status.publish(new Map([['s1', { running: true }]]))
  status.publish(new Map([['s1', { running: false }]]))
  env.advance(800)
  assert.equal(env.record.played.length, 1, 'the settle window must not have expired yet')
  status.publish(new Map([['s1', { running: true }]]))
  env.advance(SETTLE_MS * 3)
  assert.equal(env.record.played.length, 1, 'a round that resumed must not announce a finished turn')

  for (const dispose of record.disposers) dispose()
})

test('a subagent run is silent, a question and an approval are not', async () => {
  const { env, status, record } = await mount({
    hasFocus: false,
    sessions: {
      child: { id: 'child', running: false, displayTitle: 'Child run', origin: 'subagent' },
      main: { id: 'main', running: false, displayTitle: 'Main', origin: 'main' },
    },
  })

  // A workflow can finish dozens of child runs in a minute; announcing each one
  // would train the user to ignore the alert.
  status.publish(new Map([['child', { running: false }]]))
  status.publish(new Map([['child', { running: true }]]))
  status.publish(new Map([['child', { running: false }]]))
  env.advance(SETTLE_MS * 2)
  assert.equal(env.record.played.length, 0, 'a child run must not ring')

  // A child asking for approval is still the user's decision.
  status.publish(new Map([['child', { running: false }], ['main', { running: false }]]))
  status.publish(new Map([['child', { running: false, pendingInteraction: { kind: 'approval', toolName: 'bash' } }], ['main', { running: false }]]))
  assert.equal(env.record.played.length, 1, 'an approval from a child still rings')
  assert.equal(env.record.played[0].src, '/api/agent-alerts/sound?kind=question')
  assert.equal(env.record.notifications[0].title, 'Waiting for your approval')
  assert.match(env.record.notifications[0].options.body, /bash/)

  // A question carries the question text.
  status.publish(new Map([['child', { running: false, pendingInteraction: { kind: 'approval', toolName: 'bash' } }], ['main', { running: false }]]))
  status.publish(
    new Map([
      ['child', { running: false, pendingInteraction: { kind: 'approval', toolName: 'bash' } }],
      ['main', { running: false, pendingInteraction: { kind: 'question', questions: [{ question: 'Continue?  ' }] } }],
    ]),
  )
  assert.equal(env.record.notifications.length, 2, 'a question rings separately from the approval')
  assert.equal(env.record.notifications[1].title, 'Waiting for your answer')
  assert.equal(env.record.notifications[1].options.body, 'Continue?', 'the body is the flattened question')

  // Plan review shares the question sound but not its wording. The question has
  // to settle first: one pending interaction replacing another is not news.
  status.publish(new Map([['main', { running: false }]]))
  status.publish(new Map([['main', { running: false, pendingInteraction: { kind: 'plan-review', questions: [{ question: 'Approve the plan' }] } }]]))
  assert.equal(env.record.notifications.length, 3)
  assert.equal(env.record.notifications[2].title, 'Waiting for your review')

  for (const dispose of record.disposers) dispose()
})

test('one moment reported twice is one alert', async () => {
  const { env, status, waterfall, record } = await mount({
    hasFocus: false,
    sessions: { s1: { id: 's1', running: false, displayTitle: 'S', origin: 'main' } },
  })

  // The same question arrives from the forwarded event and from the status map.
  const listener = waterfall.get('user-questions/request')
  assert.equal(typeof listener, 'function')
  const outcome = await listener.call({}, { questions: [{ question: 'Which one?' }] }, () => Promise.resolve('NEXT'))
  assert.equal(outcome, 'NEXT', 'the waterfall must be handed on, or the agent hangs')

  status.publish(new Map([['s1', { running: false }]]))
  status.publish(new Map([['s1', { running: false, pendingInteraction: { kind: 'question', questions: [{ question: 'Which one?' }] } }]]))
  assert.equal(env.record.played.length, 1, 'the suppression window collapses the duplicate')

  // ...but a genuinely different moment on the same session still rings.
  env.advance(5000)
  status.publish(new Map([['s1', { running: false }]]))
  status.publish(new Map([['s1', { running: false, pendingInteraction: { kind: 'approval', toolName: 'write' } }]]))
  assert.equal(env.record.played.length, 2)

  for (const dispose of record.disposers) dispose()
})

test('by default a focused window is still notified', async () => {
  // The default was the other way round until it was shipped and cost a user a
  // long evening: they saw the sound fire, no banner, and had no way to tell
  // that this switch was the reason.
  const { env, status, record } = await mount({
    hasFocus: true,
    sessions: { s1: { id: 's1', running: false, displayTitle: 'S', origin: 'main' } },
  })

  status.publish(new Map([['s1', { running: false }]]))
  status.publish(new Map([['s1', { running: true }]]))
  status.publish(new Map([['s1', { running: false }]]))
  env.advance(SETTLE_MS)
  assert.equal(env.record.played.length, 1)
  assert.equal(env.record.notifications.length, 1, 'the default must notify even while the window is focused')

  for (const dispose of record.disposers) dispose()
})

test('quiet-while-focused drops the banner and keeps the sound', async () => {
  const { env, status, record } = await mount({
    hasFocus: true,
    config: { quietWhenFocused: true },
    sessions: { s1: { id: 's1', running: false, displayTitle: 'S', origin: 'main' } },
  })

  status.publish(new Map([['s1', { running: false }]]))
  status.publish(new Map([['s1', { running: true }]]))
  status.publish(new Map([['s1', { running: false }]]))
  env.advance(SETTLE_MS)
  assert.equal(env.record.played.length, 1, 'the sound is the point while the window is visible')
  assert.equal(env.record.notifications.length, 0, 'the banner is skipped while focused')

  for (const dispose of record.disposers) dispose()
})

test('the settings actually switch each kind off', async () => {
  const { env, status, forms, record } = await mount({
    hasFocus: false,
    config: { sound: false, notifyMode: 'off' },
    sessions: { s1: { id: 's1', running: false, displayTitle: 'S', origin: 'main' } },
  })

  status.publish(new Map([['s1', { running: false }]]))
  status.publish(new Map([['s1', { running: true }]]))
  status.publish(new Map([['s1', { running: false }]]))
  env.advance(SETTLE_MS)
  assert.equal(env.record.played.length, 0, 'sound:false must silence it')
  assert.equal(env.record.notifications.length, 0, "notifyMode:'off' must silence it")

  // The per-kind switch is independent of the delivery switches.
  forms.publish({ turnEnd: false, sound: true, notifyMode: 'banner' })
  status.publish(new Map([['s1', { running: true }]]))
  status.publish(new Map([['s1', { running: false }]]))
  env.advance(SETTLE_MS)
  assert.equal(env.record.played.length, 0, 'turnEnd:false must silence that kind')

  for (const dispose of record.disposers) dispose()
})

test('a banner click focuses the window and opens its session', async () => {
  const { env, status, record } = await mount({
    hasFocus: false,
    sessions: { s1: { id: 's1', running: false, displayTitle: 'S', origin: 'main' } },
  })

  status.publish(new Map([['s1', { running: false }]]))
  status.publish(new Map([['s1', { running: false, pendingInteraction: { kind: 'approval', toolName: 'bash' } }]]))
  assert.equal(env.record.notifications.length, 1)
  const banner = env.record.instances[0]
  assert.equal(typeof banner.onclick, 'function')
  banner.onclick()
  assert.equal(env.record.focusCalls, 1, 'clicking the banner focuses the window')
  assert.deepEqual(record.opened, ['s1'], 'and opens the session it was about')

  for (const dispose of record.disposers) dispose()
})

test('the settings page renders every Config field, with copy for each', async () => {
  const { env, record } = await mount()
  const page = env.runtime.render(record.registrations[0].component({ view: 'page' }))
  await tick()

  assert.ok(textOf(page).length > 0, 'the page must render')

  // Every field label is requested through the dictionary, so a field with no
  // copy shows up as a missing key rather than as a bare dotted identifier.
  const requestedFields = new Set(record.requested.filter((key) => key.startsWith('field.')).map((key) => key.split('.')[1]))
  assert.deepEqual([...requestedFields].sort(), [...hostConfigKeys()].sort(), 'the page and the Host schema must list the same fields')
  assert.deepEqual(record.missing, [], 'every requested key must exist in the dictionary')

  const dict = record.localeRegistrations[0].dicts
  assert.deepEqual(Object.keys(dict.en).sort(), Object.keys(dict.zh).sort(), 'both locales must define the same keys')

  // The summary view is a different projection of the same registration.
  const summary = textOf(env.runtime.render(record.registrations[0].component({ view: 'summary' })))
  assert.match(summary, /notification and a sound/i)

  for (const dispose of record.disposers) dispose()
})

test('the settings page writes through the Host form', async () => {
  const { env, forms, record } = await mount({ config: { turnEnd: true, volume: 0.5 } })
  env.runtime.render(record.registrations[0].component({ view: 'page' }))
  await tick()

  const page = () => env.runtime.current()
  const checkboxes = () => findIn(page(), (element) => element.props?.type === 'checkbox')
  assert.equal(checkboxes().length, 5, 'three moment switches and two delivery switches')

  /** The last value written to one field. */
  const written = (field) => forms.writes.filter((write) => write.field === field).at(-1)

  checkboxes()[0].props.onChange({ target: { checked: false } })
  await tick()
  assert.deepEqual(written('turnEnd'), { field: 'turnEnd', value: false })

  const ranges = findIn(page(), (element) => element.props?.type === 'range')
  assert.equal(ranges.length, 1)
  ranges[0].props.onChange({ target: { value: '0.25' } })
  await tick()
  assert.deepEqual(written('volume'), { field: 'volume', value: 0.25 })

  // The transport is a choice of three, not a switch, because the banner and
  // the system fallback can differ in whether they work at all.
  const selects = findIn(page(), (element) => element.type === 'select')
  assert.equal(selects.length, 1)
  // Spread: the option list crosses a vm realm.
  assert.deepEqual([...selects[0].props.children].map((option) => option.props.value), ['off', 'banner', 'system'])
  selects[0].props.onChange({ target: { value: 'system' } })
  await tick()
  assert.deepEqual(written('notifyMode'), { field: 'notifyMode', value: 'system' })

  // A text field commits on blur, and only when the draft actually changed.
  const pathField = () => findIn(page(), (element) => element.props?.type === 'text')[0]
  pathField().props.onFocus()
  await tick()
  pathField().props.onChange({ target: { value: '/tmp/done.mp3' } })
  await tick()
  pathField().props.onBlur()
  await tick()
  assert.deepEqual(written('turnEndSound'), { field: 'turnEndSound', value: '/tmp/done.mp3' })

  const before = forms.writes.length
  pathField().props.onFocus()
  pathField().props.onBlur()
  await tick()
  assert.equal(forms.writes.length, before, 'blurring an unchanged field writes nothing')

  for (const dispose of record.disposers) dispose()
})

test('a configured sound that does not resolve is reported, not silent', async () => {
  const { env, record } = await mount({
    config: { turnEndSound: '/nope.mp3' },
    sounds: [
      { kind: 'turn-end', source: 'custom', ok: false, error: 'ENOENT', path: '/nope.mp3' },
      { kind: 'question', source: 'bundled', ok: true, bytes: 95767 },
    ],
  })
  env.runtime.render(record.registrations[0].component({ view: 'page' }))
  await tick()
  await tick()

  const text = textOf(env.runtime.current())
  assert.match(text, /ENOENT/, 'the Host verdict reaches the page')
  assert.match(text, /Using the bundled sound/, 'the other moment reports the bundled file')

  for (const dispose of record.disposers) dispose()
})

test('unmounting releases the pending timer and the live banner', async () => {
  const { env, status, record } = await mount({ hasFocus: false, sessions: { s1: { id: 's1', running: false, displayTitle: 'S', origin: 'main' } } })

  // A banner that is on screen, and a turn-end timer that has NOT fired yet.
  status.publish(new Map([['s1', { running: false }]]))
  status.publish(new Map([['s1', { running: false, pendingInteraction: { kind: 'approval', toolName: 'bash' } }]]))
  assert.equal(env.record.notifications.length, 1)
  status.publish(new Map([['s1', { running: false }]]))
  status.publish(new Map([['s1', { running: true }]]))
  status.publish(new Map([['s1', { running: false }]]))
  assert.equal(env.record.played.length, 1, 'the approval rang')
  const played = env.record.played.length

  for (const dispose of record.disposers) dispose()
  assert.equal(env.record.notifications[0].closed, true, 'a live banner is closed on teardown')

  // Step over the suppression window AND the settle window. A timer that
  // survived teardown would fire here; a subscription that survived it would
  // schedule a new one.
  env.advance(10000)
  status.publish(new Map([['s1', { running: true }]]))
  status.publish(new Map([['s1', { running: false }]]))
  env.advance(10000)
  assert.equal(env.record.played.length, played, 'no alert fires after teardown')
  assert.equal(env.record.notifications.length, 1, 'no banner is raised after teardown')
})

test('the system-notification route passes its text as argv, never as script', async () => {
  const calls = []
  const host = loadHostHalf({
    execFile: (file, args, opts, callback) => {
      calls.push({ file, args, opts })
      callback(null, { stdout: '', stderr: '' })
    },
  })
  const routes = host.mountHost({ admit: () => ({}) })

  // Only POST, and only from an admitted caller.
  assert.equal((await callRouteAsync(routes, '/api/agent-alerts/notify', '/api/agent-alerts/notify', { method: 'GET' })).status, 405)
  const refused = host.mountHost({ admit: () => ({ rejection: 403 }) })
  assert.equal((await callRouteAsync(refused, '/api/agent-alerts/notify', '/api/agent-alerts/notify', { body: '{}' })).status, 403)
  assert.equal((await callRouteAsync(routes, '/api/agent-alerts/notify', '/api/agent-alerts/notify', { body: 'not json' })).status, 400)

  // A body larger than the cap is refused rather than buffered.
  const huge = await callRouteAsync(routes, '/api/agent-alerts/notify', '/api/agent-alerts/notify', {
    body: JSON.stringify({ title: 'x', body: 'y'.repeat(8000) }),
  })
  assert.equal(huge.status, 400)
  assert.match(huge.body.toString(), /too-large/)

  // A session title containing a quote must not be able to become AppleScript.
  const title = 'He said "hi" \\ and left'
  const body = 'line one\nline two'
  const ok = await callRouteAsync(routes, '/api/agent-alerts/notify', '/api/agent-alerts/notify', {
    body: JSON.stringify({ title, body }),
  })
  assert.equal(ok.status, 200)
  assert.equal(JSON.parse(ok.body.toString()).ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].file, '/usr/bin/osascript')
  // The script is a fixed string; the text is argv. Interpolating instead would
  // make a session title executable.
  assert.equal(calls[0].args[0], '-e')
  assert.ok(!calls[0].args[1].includes(title), 'the script must not contain the title')
  assert.ok(!calls[0].args[1].includes('line one'), 'the script must not contain the body')
  assert.equal(calls[0].args[2], title)
  assert.equal(calls[0].args[3], 'line one line two', 'the body is flattened to one line')
  assert.equal(typeof calls[0].opts.timeout, 'number', 'a hung helper must not hang the Host')

  // A helper that fails is reported rather than swallowed.
  const failing = loadHostHalf({
    execFile: (file, args, opts, callback) => callback(new Error('osascript exploded')),
  })
  const failingRoutes = failing.mountHost({ admit: () => ({}) })
  const failed = await callRouteAsync(failingRoutes, '/api/agent-alerts/notify', '/api/agent-alerts/notify', { body: '{"title":"x"}' })
  assert.equal(failed.status, 502)
  assert.match(failed.body.toString(), /osascript exploded/)

  // Off macOS the answer is explicit, not silence.
  const elsewhere = loadHostHalf({ platform: 'win32' })
  const elsewhereRoutes = elsewhere.mountHost({ admit: () => ({}) })
  const unsupported = await callRouteAsync(elsewhereRoutes, '/api/agent-alerts/notify', '/api/agent-alerts/notify', { body: '{"title":"x"}' })
  assert.equal(unsupported.status, 501)
  assert.match(unsupported.body.toString(), /macos-only/)
})

test('the transport setting decides whether the page or the Host notifies', async () => {
  /** Raise one approval alert and report what each transport did. */
  const raise = async (notifyMode) => {
    const { env, status, record } = await mount({
      hasFocus: false,
      config: { notifyMode },
      sessions: { s1: { id: 's1', running: false, displayTitle: 'A session', origin: 'main' } },
    })
    status.publish(new Map([['s1', { running: false }]]))
    status.publish(new Map([['s1', { running: false, pendingInteraction: { kind: 'approval', toolName: 'bash' } }]]))
    await tick()
    return { env, record }
  }

  const off = await raise('off')
  assert.equal(off.env.record.notifications.length, 0, 'off raises no banner')
  assert.equal(off.env.record.posts.length, 0, 'off asks the Host for nothing')

  const banner = await raise('banner')
  assert.equal(banner.env.record.notifications.length, 1, 'banner constructs a Notification')
  assert.equal(banner.env.record.posts.length, 0, 'banner does not also ask the Host')

  const system = await raise('system')
  assert.equal(system.env.record.notifications.length, 0, 'the fallback constructs no Notification')
  assert.equal(system.env.record.posts.length, 1, 'the fallback asks the Host exactly once')
  assert.match(system.env.record.posts[0].url, /\/api\/agent-alerts\/notify$/)
  const payload = JSON.parse(system.env.record.posts[0].body)
  assert.equal(payload.title, 'Waiting for your approval')
  assert.match(payload.body, /bash/, 'the composed text is what crosses the wire')
})

test('the test button reports what it saw, in both transports', async () => {
  /** Render the settings page and click its notification test button. */
  const press = async (config, options = {}) => {
    const { env, record } = await mount({ config, ...options })
    env.runtime.render(record.registrations[0].component({ view: 'page' }))
    await tick()
    // By label, not by position: the page also has two Preview buttons.
    const button = findIn(env.runtime.current(), (element) => element.type === 'button' && textOf(element.props.children) === 'Send a test')[0]
    assert.equal(typeof button?.props.onClick, 'function', 'the test button must render')
    await button.props.onClick()
    await tick()
    return { text: textOf(env.runtime.current()), env, record, page: () => env.runtime.current() }
  }

  /** Click the transport select and return the page text afterwards. */
  const switchMode = async (view, value) => {
    const select = findIn(view, (element) => element.type === 'select')[0]
    select.props.onChange({ target: { value } })
    await tick()
  }

  // A banner that reports `onshow` still does not prove anything was displayed,
  // so the verdict has to say so rather than claim success.
  const banner = await press({ notifyMode: 'banner' })
  assert.match(banner.text, /onshow ✓/, 'the banner verdict reports the callback')
  assert.match(banner.text, /屏幕上没有的话/, 'and refuses to call it proof')

  // A verdict belongs to the transport it was measured on. Leaving the previous
  // one on screen while the user tries the other would be its own small lie.
  await switchMode(banner.page(), 'system')
  assert.doesNotMatch(textOf(banner.page()), /onshow ✓/, 'switching transport clears the old verdict')

  // The fallback reports the HTTP answer, which is the Host's real opinion.
  const system = await press({ notifyMode: 'system' })
  assert.match(system.text, /已交给系统（HTTP 200）/)

  // A refusal is shown with its status, not swallowed into the console.
  const refused = await press({ notifyMode: 'system' }, { notifyFails: true })
  assert.match(refused.text, /被拒绝：HTTP 401/)
})

test('the rendered page agrees with the shipped defaults', async () => {
  const { env, record } = await mount({ config: {} })
  env.runtime.render(record.registrations[0].component({ view: 'page' }))
  await tick()

  // The browser half carries its own copy of each default, because it must
  // answer before the Host's settings snapshot has loaded. Two copies can drift,
  // and this is the check that they have not.
  const page = env.runtime.current()
  const switches = findIn(page, (element) => element.props?.type === 'checkbox')
  assert.deepEqual(
    switches.map((element) => element.props.checked),
    [true, true, true, true, false],
    'the switches render the shipped defaults, with quiet-when-focused last and off',
  )
  const select = findIn(page, (element) => element.type === 'select')[0]
  assert.equal(select.props.value, 'banner')
  const range = findIn(page, (element) => element.props?.type === 'range')[0]
  assert.equal(range.props.value, 0.8, 'volume renders the shipped default')
})

test('a status route that cannot be reached says so', async () => {
  // Silence here would look exactly like "the bundled sound is fine", which is
  // the one thing the status line exists to distinguish.
  const { env, record } = await mount({ statusFails: true })
  env.runtime.render(record.registrations[0].component({ view: 'page' }))
  await tick()
  await tick()

  const text = textOf(env.runtime.current())
  assert.match(text, /Could not ask the Host/, 'a failed status read is visible')
  assert.match(text, /status route unreachable/, 'with the reason')
})

test('a turn that closed because the agent is waiting on you is not "finished"', async () => {
  const { env, status, record } = await mount({
    hasFocus: false,
    sessions: { s1: { id: 's1', running: false, displayTitle: 'S', origin: 'main' } },
  })

  // Running, then idle *at the same moment* a question appears. Announcing
  // "finished" here would be the opposite of what happened.
  status.publish(new Map([['s1', { running: false }]]))
  status.publish(new Map([['s1', { running: true }]]))
  status.publish(new Map([['s1', { running: false, pendingInteraction: { kind: 'question', questions: [{ question: 'Which?' }] } }]]))
  assert.equal(env.record.played.length, 1, 'the question rings')
  env.advance(SETTLE_MS * 3)
  assert.equal(env.record.played.length, 1, 'and the finished-turn alert is dropped')

  // Once the question is answered and the turn really ends, it rings.
  status.publish(new Map([['s1', { running: false }]]))
  status.publish(new Map([['s1', { running: true }]]))
  status.publish(new Map([['s1', { running: false }]]))
  env.advance(5000)
  assert.equal(env.record.played.length, 2, 'with nothing pending, a finished turn rings')

  for (const dispose of record.disposers) dispose()
})
