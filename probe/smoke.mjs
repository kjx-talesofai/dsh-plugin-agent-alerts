/**
 * Probe smoke test.
 *
 * The probe is installed by hand, once, in the user's real application. A typo
 * found there costs a whole install cycle, so this harness loads both halves
 * under stubs first and fails loudly on anything that would have thrown inside
 * the running app:
 *
 *   - the browser half must parse, register its factory, and mount against a
 *     context whose services are either present or absent — never throw;
 *   - the registered panel must render a report rather than a blank card, and
 *     its buttons must actually reach `Notification` and `Audio`;
 *   - the Host half's routes must answer with the two real `mp3` files, which
 *     also proves the committed `assets/` paths resolve.
 *
 * Not shipped.
 *
 * @module dsh-plugin-agent-alerts-probe/smoke
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSETS = join(HERE, '..', 'assets')

/** Let queued microtasks and the zero-delay timers inside `apply` settle. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

//#region a hooks runtime small enough to read

/** A React stand-in offering exactly the three hooks the probe uses. */
function createReact() {
  const cleanups = []
  return {
    cleanups,
    React: {
      createElement(type, props, ...children) {
        const next = { ...(props ?? {}) }
        if (children.length > 0) next.children = children.length > 1 ? children : children[0]
        return { $$element: true, type, props: next }
      },
      useReducer(_reducer, initial) {
        return [initial, () => {}]
      },
      useEffect(effect) {
        const cleanup = effect()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      },
    },
  }
}

/**
 * Render an element tree, invoking function components until only host nodes
 * remain, and flatten every string leaf.
 *
 * @param element - Element returned by a component.
 * @param depth - Recursion guard.
 * @returns The concatenated text of the tree.
 */
function renderToText(element, depth = 0) {
  if (depth > 40 || element === null || element === undefined || typeof element === 'boolean') return ''
  if (typeof element === 'string' || typeof element === 'number') return String(element)
  if (Array.isArray(element)) return element.map((child) => renderToText(child, depth + 1)).join(' ')
  if (typeof element.type === 'function') return renderToText(element.type(element.props), depth + 1)
  return renderToText(element.props?.children, depth + 1)
}

//#endregion

//#region environment

/**
 * Build the browser globals the client half expects, recording what it did.
 *
 * @param options - `notification` and `audio` set to false remove the global.
 * @returns The captured factory exports, the record, and the render helpers.
 */
function browserEnvironment(options = {}) {
  const record = { notifications: [], played: [], fetches: [], styles: [], cleanups: [] }
  const { React, cleanups } = createReact()

  // A controllable ticker instead of the real `setInterval`: the countdown runs
  // while a notification is scheduled, and a real interval would keep the test
  // process alive forever.
  const intervals = new Map()
  let nextIntervalId = 1

  class FakeNotification {
    static permission = 'granted'
    static requestPermission = async () => 'granted'
    constructor(title, opts) {
      record.notifications.push({ title, options: opts })
      this.onerror = null
      this.onshow = null
      this.onclick = null
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
      this.listeners = new Map()
    }
    addEventListener(name, fn) {
      if (!this.listeners.has(name)) this.listeners.set(name, [])
      this.listeners.get(name).push(fn)
    }
    removeEventListener() {}
    load() {
      for (const fn of this.listeners.get('canplaythrough') ?? []) fn()
    }
    play() {
      record.played.push(this.src)
      return Promise.resolve()
    }
    pause() {}
  }

  const context = {
    console,
    // Unref'd: the delayed notification arms schedule shots up to 15 seconds out,
    // and a referenced timer would hold the test process open that whole time.
    setTimeout: (callback, delay, ...rest) => {
      const timer = setTimeout(callback, delay, ...rest)
      if (typeof timer?.unref === 'function') timer.unref()
      return timer
    },
    clearTimeout,
    setInterval: (callback) => {
      const id = nextIntervalId
      nextIntervalId += 1
      intervals.set(id, callback)
      return id
    },
    clearInterval: (id) => {
      intervals.delete(id)
    },
    URL,
    Date,
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
    fetch: async (url) => {
      record.fetches.push(String(url))
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, admitted: true, sawCookie: true }),
        arrayBuffer: async () => new ArrayBuffer(2048),
      }
    },
    document: {
      visibilityState: 'visible',
      hasFocus: () => true,
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
    },
  }
  if (options.notification !== false) context.Notification = FakeNotification
  if (options.audio !== false) context.Audio = FakeAudio
  context.globalThis = context
  context.window.document = context.document

  let definition
  context.window.__ModuleLoader__ = { load: (value) => { definition = value } }

  const source = readFileSync(join(HERE, 'client.js'), 'utf8')
  vm.createContext(context)
  new vm.Script(source, { filename: 'probe/client.js' }).runInContext(context)

  assert.ok(definition !== undefined, 'client.js must register through window.__ModuleLoader__')
  const exports_ = definition.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require(${JSON.stringify(name)})`)
  })

  return {
    record,
    definition,
    exports: exports_,
    cleanups,
    intervals,
    /** Run every installed ticker once, the way a real second would. */
    tickInterval: () => {
      for (const callback of [...intervals.values()]) callback()
    },
    /** Stop every ticker; the mount's own disposers clear the ones it owns. */
    stopIntervals: () => intervals.clear(),
  }
}

/**
 * Build a Client context stub, recording effects, slot registrations, and
 * cleanups.
 *
 * @param services - Service table keyed by name.
 * @returns The stub context and its record.
 */
function clientContext(services) {
  const record = { slotInjections: [], registrations: [], effectLabels: [], disposers: [] }
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
  }
  return { ctx, record }
}

//#endregion

test('the browser half mounts without services and reports what it could not read', async () => {
  const env = browserEnvironment()
  const { ctx, record } = clientContext({})

  env.exports.apply(ctx)
  await tick()

  // Spread: the array literal comes from the vm realm, so its prototype is not
  // this realm's `Array.prototype` and a strict deep-equal would reject it.
  assert.deepEqual([...env.exports.inject], ['slots'], 'slots is the only hard dependency')
  assert.deepEqual(record.slotInjections, ['shell.overlay'])
  assert.equal(record.registrations.length, 1)
  assert.equal(record.registrations[0].options.id, 'agent-alerts-probe.panel')

  const text = panelOf(record).text
  assert.match(text, /Agent Alerts 探针/, 'the panel must render its header')
  assert.match(text, /dsh-app:\/\/app/, 'the page origin is reported')
  assert.match(text, /permission=granted/, 'the notification permission is reported')
  assert.match(text, /Host 路由 fetch/, 'the route probe reports even when it fails')
  assert.match(text, /configForms/)
  assert.match(text, /sessions\.list/)
  assert.match(text, /ctx\.remote\.\$on/)
  assert.match(text, /事件日志/)

  // A route probe that never ran is a broken probe: assert the fetch happened.
  assert.ok(env.record.fetches.some((url) => url.endsWith('/ping')), 'the ping route is fetched')

  for (const dispose of record.disposers) dispose()
  for (const cleanup of env.cleanups) cleanup()
  assert.equal(env.intervals.size, 0, 'the mount disposer stops the countdown ticker')
  env.stopIntervals()
})

test('present services are reported as present, and the buttons reach the real APIs', async () => {
  const subscribers = []
  const waterfall = new Map()
  const statusListeners = []
  let statusSnapshot = new Map()
  const env = browserEnvironment()
  const { ctx, record } = clientContext({
    sessions: { list: { subscribe: (fn) => { subscribers.push(fn); return () => {} }, getSnapshot: () => ({ ids: ['a'.repeat(32)], byId: { ['a'.repeat(32)]: { running: false, displayTitle: 'x', origin: 'main' } }, phase: 'ready' }) } },
    configForms: {
      get: () => ({ getSnapshot: () => ({ value: { volume: 1 } }) }),
      describe: () => ({ getSnapshot: () => ({ view: { namespaces: [{ ns: 'agent-alerts-probe' }] } }) }),
    },
    remote: { $on: (event, listener) => { subscribers.push(event); waterfall.set(event, listener); return () => {} } },
    uiSession: {
      sessionStatus: {
        subscribe: (fn) => { statusListeners.push(fn); return () => {} },
        getSnapshot: () => statusSnapshot,
      },
    },
  })

  env.exports.apply(ctx)
  await tick()

  const panel = panelOf(record)
  assert.match(panel.text, /get=ok/, 'configForms.get must resolve')
  assert.match(panel.text, /Host 托管 ns/)
  assert.match(panel.text, /可用，已订阅/)
  assert.match(panel.text, /ids=1/)

  // The notification experiment is driven through the panel's own callback,
  // which is the only path a user has.
  assert.match(panel.text, /A 立刻 · 有声 · 已响 0/, 'the attempt counters start at zero')

  // An immediate arm constructs straight away, and the body has to carry the
  // two facts the round-3 reading depends on: which arm, and whether the window
  // was focused at fire time.
  panel.props.onNotify({ id: 'loud', label: 'A 立刻 · 有声', silent: false, delayMs: 0, repeat: 1 })
  await tick()
  assert.equal(env.record.notifications.length, 1, 'an immediate arm fires without user-visible delay')
  assert.match(env.record.notifications[0].title, /A 立刻 · 有声/)
  assert.equal(env.record.notifications[0].options.silent, false, 'the arm controls `silent`')
  assert.match(env.record.notifications[0].options.body, /窗口前台/, 'the body records the focus state at fire time')
  assert.match(panelOf(record).text, /A 立刻 · 有声 · 已响 1/, 'the counter advances')

  // A delayed arm must NOT construct anything up front — that is the entire
  // reason it exists — and the panel must show the countdown that tells the user
  // when to switch away.
  const before = env.record.notifications.length
  panel.props.onNotify({ id: 'burst', label: 'D 连响 3 次 · 有声', silent: false, delayMs: 5000, repeat: 3 })
  await tick()
  assert.equal(env.record.notifications.length, before, 'a delayed arm constructs nothing immediately')
  const scheduled = panelOf(record).text
  assert.match(scheduled, /⏳ \d\.\d 秒后响/, 'the countdown shows the remaining time from the arm delay')
  assert.match(scheduled, /D 连响 3 次 · 有声（第 1\/3 发）/, 'the countdown names the arm and the shot')
  assert.match(scheduled, /第 1\/3 发/, 'all three shots are scheduled, not just the first')
  assert.equal(env.intervals.size, 1, 'exactly one countdown ticker is installed')
  env.tickInterval()

  // The `silent` flag is the one variable rounds 1 and 2 held constant, so the
  // arms must actually disagree about it.
  // The countdown shows only the earliest pending shot, so the C arm is read
  // from its own check row rather than from the countdown block.
  panel.props.onNotify({ id: 'later-silent', label: 'C 5 秒后 · 无声', silent: true, delayMs: 5000, repeat: 1 })
  await tick()
  assert.match(panelOf(record).text, /C 5 秒后 · 无声 已排程 1 发/)
  assert.match(panelOf(record).text, /⏳ \d\.\d 秒后响：D 连响 3 次/, 'the countdown pins the earliest pending shot')

  panel.props.onPlay('finish')
  await tick()
  assert.ok(env.record.played.length > 0, 'the play button drives an Audio element')

  // The two forwarded events are WATERFALLS. A listener that forgets to return
  // `next()` would not merely fail to notify — it would hang the agent waiting
  // for a question nobody can answer, which is the one failure in this design
  // that is worse than having no plugin at all.
  for (const [event, request] of [
    ['user-questions/request', { questions: [{ question: '继续吗？' }] }],
    ['approval/request', { toolName: 'bash' }],
  ]) {
    const listener = waterfall.get(event)
    assert.equal(typeof listener, 'function', `${event} must be subscribed`)
    let handed = 0
    const outcome = await listener.call({}, request, () => {
      handed += 1
      return Promise.resolve('REMOTE_EVENT_NEXT')
    })
    assert.equal(handed, 1, `${event} must hand the chain on exactly once`)
    assert.equal(outcome, 'REMOTE_EVENT_NEXT', `${event} must return what next() returned`)
  }
  assert.match(panelOf(record).text, /★ user-questions\/request/, 'the question is logged')

  // R7: the application's own status source. A pending interaction must be
  // reported, and a running→idle flip must be reported as a turn end.
  assert.equal(statusListeners.length, 1, 'uiSession.sessionStatus must be subscribed')
  const key = 'b'.repeat(32)
  statusSnapshot = new Map([[key, { running: true, pendingInteraction: undefined, completionUnread: false }]])
  statusListeners[0]()
  statusSnapshot = new Map([[key, { running: true, pendingInteraction: { kind: 'question' }, completionUnread: false }]])
  statusListeners[0]()
  statusSnapshot = new Map([[key, { running: false, pendingInteraction: undefined, completionUnread: true }]])
  statusListeners[0]()
  const afterStatus = panelOf(record).text
  assert.match(afterStatus, /★ 需要你 · question/, 'a pending question must be reported')
  assert.match(afterStatus, /★ TURN END \(uiSession\)/, 'a running→idle flip must be reported')
  assert.match(afterStatus, /uiSession 待办/)

  // A listener bug must not be able to hang a real question either.
  const hostile = waterfall.get('user-questions/request')
  const broken = await hostile.call({}, null, () => Promise.resolve('REMOTE_EVENT_NEXT'))
  assert.equal(broken, 'REMOTE_EVENT_NEXT', 'a malformed payload still hands the chain on')

  // Rendering with the notification API absent must not throw.
  const bare = browserEnvironment({ notification: false })
  const bareCtx = clientContext({})
  bare.exports.apply(bareCtx.ctx)
  await tick()
  assert.match(panelOf(bareCtx.record).text, /Notification 接口/)
})

/**
 * Render the panel a mount registered and return its text plus the props the
 * registration handed to the overlay component — which is how the test reaches
 * the panel's buttons.
 *
 * @param record - The `clientContext` record of the mount.
 * @returns `{ text, props }`.
 */
function panelOf(record) {
  assert.equal(record.registrations.length, 1, 'exactly one overlay entry is registered')
  const element = record.registrations[0].component()
  return { text: renderToText(element), props: element.props }
}

test('the Host half serves both bundled sounds, gated and open', async () => {
  const { apply, inject } = await import('./index.js')
  assert.deepEqual(inject, ['webServer', 'connection'])

  /**
   * Mount the Host half against a fresh route table.
   *
   * @param connection - Admission stub.
   * @returns The recorded routes.
   */
  const mount = (connection) => {
    const routes = new Map()
    apply({
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
    })
    return routes
  }

  /** Drive one handler the way Node's HTTP server would. */
  const call = (routes, path, url, headers = {}) => {
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
    routes.get(path).handler({ url, method: 'GET', headers }, res)
    return { ...state, body: Buffer.concat(chunks) }
  }

  const admitted = mount({ admit: () => ({}) })
  assert.deepEqual([...admitted.keys()].sort(), [
    '/api/agent-alerts-probe/ping',
    '/api/agent-alerts-probe/sound',
    '/api/agent-alerts-probe/sound-open',
  ])

  const ping = call(admitted, '/api/agent-alerts-probe/ping', '/api/agent-alerts-probe/ping')
  assert.equal(ping.status, 200)
  assert.equal(JSON.parse(ping.body.toString()).admitted, true)

  for (const [kind, file] of [['finish', 'duo_finish.mp3'], ['question', 'duo_question.mp3']]) {
    const answer = call(admitted, '/api/agent-alerts-probe/sound', `/api/agent-alerts-probe/sound?kind=${kind}`)
    assert.equal(answer.status, 200, kind)
    assert.equal(answer.headers['content-type'], 'audio/mpeg')
    const onDisk = readFileSync(join(ASSETS, file))
    assert.equal(answer.body.length, onDisk.length, `${kind} byte length`)
    assert.ok(answer.body.equals(onDisk), `${kind} bytes must be the packaged file`)
  }

  const refused = mount({ admit: () => ({ rejection: 403 }) })
  const gated = call(refused, '/api/agent-alerts-probe/sound', '/api/agent-alerts-probe/sound?kind=finish')
  assert.equal(gated.status, 403, 'the gated route must honour admission')
  assert.equal(gated.body.toString(), 'refused')

  const stillOpen = call(refused, '/api/agent-alerts-probe/sound-open', '/api/agent-alerts-probe/sound-open?kind=question')
  assert.equal(stillOpen.status, 200, 'the open route stays reachable when admission refuses')

  const unknown = call(refused, '/api/agent-alerts-probe/sound-open', '/api/agent-alerts-probe/sound-open?kind=nope')
  assert.equal(unknown.status, 404)
})
