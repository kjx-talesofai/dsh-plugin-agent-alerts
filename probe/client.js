/**
 * Agent Alerts Probe — browser half.
 *
 * A throwaway Phase 0 diagnostic. Every question below is undecidable by
 * reading the shipped bundles, because each depends on live runtime state or on
 * an interaction between the Electron main process, the Host child process, and
 * the page:
 *
 *   R1  Does `new Notification(...)` raise a macOS banner, and does it keep
 *       doing so on repeat? Round 1 answered the first half: the first banner
 *       appeared, later identical ones did not. The notification experiment
 *       below isolates the three candidates — a collected JS reference, macOS
 *       coalescing identical content, and foreground suppression.
 *
 *   R2  Is a profile-installed bundle's `ctx.webServer` route reachable from
 *       the page? SETTLED in round 1: `200 admitted=true cookie=true`, and the
 *       media loader reached `readyState=4`. The page's origin is the custom
 *       scheme `dsh-app://app`; everything but a static document path is
 *       forwarded to the Host with the Host cookie.
 *
 *   R3  Does `<audio>` play with no user gesture? Manual playback works; the
 *       no-gesture attempt is the one that matters, because the whole point is
 *       to be heard while the user is in another application.
 *
 *   R4  Does `ctx.remote.$on('user-questions/request', ...)` fire for an
 *       external plugin, and does returning `next()` leave the shipped question
 *       dialog working? The event is forwarded as a *waterfall*; the shipped UI
 *       listener registers first and returns the user's answer without calling
 *       `next()`, so this listener may never run at all. Must be measured.
 *
 *   R5  Does `ctx.configForms.get(rowId)` resolve, and does Host `describe()`
 *       list the row's namespace? Round 1 showed the controller resolves and the
 *       namespace is absent — expected, because the probe declares no `Config`.
 *       The served-namespace list is the useful number: a third-party plugin's
 *       namespace in it is what proves the mechanism.
 *
 *   R6  Does the client session store expose a usable `running` true→false
 *       transition — the "turn ended" signal?
 *
 *   R7  Is `ctx.uiSession.sessionStatus` readable? SETTLED in round 1:
 *       one entry per session. That is the application's own
 *       `{ running, pendingInteraction, completionUnread }` map, and it sits
 *       outside every waterfall chain.
 *
 * Round 1 also produced a finding that changed the design: at boot the app marks
 * every historically idle session `completionUnread` — dozens of them. That
 * signal is therefore unusable as a turn-end trigger, and the log below shows it
 * rather than hiding it.
 *
 * The panel mounts one `shell.overlay` entry and never throws: a probe that dies
 * on a missing service answers nothing.
 *
 * Nothing here ships.
 *
 * @module dsh-plugin-agent-alerts-probe/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-agent-alerts-probe',
  factory(require) {
    const React = require('react')

    const h = React.createElement

    /** Locale namespace; also the slot registration's `locale` key. */
    const NS = 'dsh-plugin-agent-alerts-probe'

    /** The frame-wide floating seat the real plugin's toast will also use. */
    const SLOT = 'shell.overlay'

    /**
     * The Loader row id from `cordis.patch.yml`.
     *
     * Load-bearing twice over: `dsh-settings` derives the plugin's settings
     * namespace from it, and the page resolves Config through
     * `ctx.configForms.get(ROW_ID)`. It must stay in step with the patch.
     */
    const ROW_ID = 'agent-alerts-probe'

    /** Route prefix registered by this package's Host half. */
    const ROUTE = '/api/agent-alerts-probe'

    /** How many log lines the panel keeps. */
    const LOG_LIMIT = 40

    /**
     * The reconciliation order of the report.
     *
     * `Map` preserves insertion order, but checks are inserted as their
     * asynchronous work settles, so the decisive rows would otherwise sit below
     * the fold. This list pins them, most important first; anything not named
     * here renders after them in insertion order.
     */
    const PINNED = [
      'uiSession',
      'sessions.list',
      'configForms',
      'configForms.ns',
      'remote',
      'env.notification',
      'route.ping',
      'media.gated.finish',
      'media.open.question',
      'audio.autoplay',
      'audio.manual',
      'uiSession.pending',
      'env.origin',
      'env.focus',
    ]

    //#region store

    /**
     * Probe state.
     *
     * Deliberately a plain mutable bag plus a listener set rather than anything
     * from `@deepseek-ai/dsh-client-store`: the probe must keep working when
     * module resolution is the thing under test.
     */
    const store = {
      version: 0,
      /** Insertion-ordered check rows: id → `{ label, value, tone }`. */
      checks: new Map(),
      /** Newest-last event log. */
      log: [],
      /** Counters so a flooding event still leaves a readable trace. */
      counts: new Map(),
      /** Per-arm notification attempt counts, so the panel can show progress. */
      attempts: new Map(),
      /** Scheduled-but-not-yet-fired notifications: key → `{ at, label, shot, total }`. */
      pending: new Map(),
      dismissed: false,
    }

    const listeners = new Set()

    /** Bump the version and wake every mounted panel. */
    function changed() {
      store.version += 1
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (error) {
          console.warn(`${NS}: panel listener threw`, error)
        }
      }
    }

    /**
     * Record or replace one named check.
     *
     * @param id - Stable row id.
     * @param label - Human label.
     * @param value - What was observed.
     * @param tone - `good`, `bad`, or `wait`.
     */
    function check(id, label, value, tone = 'wait') {
      store.checks.set(id, { label, value, tone })
      changed()
    }

    /**
     * Count an event and log only the first few, so a chatty channel cannot
     * push everything else out of the window.
     *
     * @param key - Counter key.
     * @param text - Line to log while under the burst limit.
     * @param limit - How many occurrences to log verbatim.
     */
    function counted(key, text, limit = 4) {
      const next = (store.counts.get(key) ?? 0) + 1
      store.counts.set(key, next)
      store.log.push({ at: Date.now(), text: next <= limit ? text : null, key, count: next })
      if (store.log.length > LOG_LIMIT) store.log.splice(0, store.log.length - LOG_LIMIT)
      changed()
    }

    /** Subscribe a React component to the probe store. */
    function useStore() {
      const [, force] = React.useReducer((n) => n + 1, 0)
      React.useEffect(() => {
        listeners.add(force)
        return () => {
          listeners.delete(force)
        }
      }, [])
      return store
    }

    //#endregion

    //#region helpers

    /** Format a clock time for the log column. */
    function clock(at) {
      const date = new Date(at)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /** Shorten a session id to something a human can compare by eye. */
    function shortId(id) {
      return typeof id === 'string' && id.length > 10 ? `${id.slice(0, 8)}…` : String(id)
    }

    /**
     * Resolve a Client service without letting a missing one abort the probe.
     *
     * @param ctx - Client Cordis context.
     * @param name - Service key to resolve.
     * @returns The service, or `undefined`.
     */
    function serviceOf(ctx, name) {
      try {
        return ctx.get(name) ?? undefined
      } catch (error) {
        console.warn(`${NS}: ctx.get('${name}') threw`, error)
        return undefined
      }
    }

    //#endregion

    //#region the notification experiment

    /**
     * The four arms of round 3.
     *
     * Round 2 settled three variables at once and eliminated all of them: from
     * Electron 42 on, macOS notifications go through `UNNotification`, and every
     * arm reported `onshow ✓` on every attempt — holding the reference, varying
     * the body, and closing the predecessor changed nothing, so collection and
     * macOS coalescing are both ruled out. The app's code signature verifies
     * (`codesign --verify --strict` passes), so the documented "unsigned
     * binaries emit `failed`" trap is not it either.
     *
     * Two factors remain, and `silent: true` was held constant across every
     * failing attempt in rounds 1 and 2 — which is exactly where a constant
     * belongs when you run out of variables to blame.
     *
     *   loud          silent:false, no delay — isolates `silent` while focused
     *   later-loud    silent:false, 5s delay — isolates focus; the delay exists
     *                 so the user can switch to another app before it fires
     *   later-silent  silent:true,  5s delay — the control for the pair above
     *   burst         silent:false, three shots 5s apart — a longer window, and
     *                 it shows whether repeats behave differently once the app
     *                 is no longer frontmost
     */
    const ARMS = [
      { id: 'loud', label: 'A 立刻 · 有声', hint: 'silent:false，点完马上看', silent: false, delayMs: 0, repeat: 1 },
      { id: 'later-loud', label: 'B 5 秒后 · 有声', hint: '点完立刻 ⌘Tab 切到别的 app', silent: false, delayMs: 5000, repeat: 1 },
      { id: 'later-silent', label: 'C 5 秒后 · 无声', hint: '点完立刻切走；和 B 对比就知道 silent 有没有影响', silent: true, delayMs: 5000, repeat: 1 },
      { id: 'burst', label: 'D 连响 3 次 · 有声', hint: '每 5 秒一次，切走后慢慢观察', silent: false, delayMs: 5000, repeat: 3 },
    ]

    /** Live notification references, so a collection bug cannot hide here. */
    const live = new Set()

    /**
     * Schedule one arm's notifications.
     *
     * The delay is not a nicety: a notification raised while the Harness window
     * is frontmost cannot distinguish "macOS suppressed it" from "macOS never
     * got it", and that distinction decides whether the plugin is shippable.
     *
     * @param arm - One entry of {@link ARMS}.
     */
    function scheduleNotification(arm) {
      if (typeof Notification === 'undefined') {
        check(`notify.${arm.id}`, arm.label, 'Notification 接口缺失', 'bad')
        return
      }
      const total = arm.repeat ?? 1
      for (let shot = 1; shot <= total; shot += 1) {
        const at = Date.now() + arm.delayMs + (shot - 1) * 5000
        store.pending.set(`${arm.id}#${shot}`, { at, label: arm.label, shot, total })
        setTimeout(
          () => {
            store.pending.delete(`${arm.id}#${shot}`)
            fireNotification(arm, shot)
          },
          Math.max(0, at - Date.now()),
        )
      }
      check(
        `notify.${arm.id}`,
        arm.label,
        arm.delayMs === 0 ? '已发出，等 onshow…' : `已排程 ${total} 发，第一发在 ${(arm.delayMs / 1000).toFixed(0)} 秒后`,
        'wait',
      )
      changed()
    }

    /**
     * Construct one banner and report what it does.
     *
     * The `onshow` / `onerror` / `onclose` trace is the whole point: if `onshow`
     * fires while no banner is visible, the loss is on the macOS side and no
     * amount of reference-keeping will fix it. If `onshow` stops firing, the
     * loss is inside this process.
     *
     * @param arm - One entry of {@link ARMS}.
     * @param shot - Which repetition this is, counting from 1.
     */
    function fireNotification(arm, shot) {
      const attempt = (store.attempts.get(arm.id) ?? 0) + 1
      store.attempts.set(arm.id, attempt)
      const where = document.hasFocus() ? '前台' : '后台'
      let banner
      try {
        banner = new Notification(`Agent Alerts 探针 · ${arm.label}`, {
          body: `第 ${shot} 发 · ${arm.silent ? '无声' : '有声'} · 窗口${where}`,
          silent: arm.silent,
        })
      } catch (error) {
        check(`notify.${arm.id}`, arm.label, `构造就抛错：${String(error?.message ?? error)}`, 'bad')
        return
      }
      // Held for every arm: round 2 ruled collection out, and keeping the
      // reference removes it as a variable for the rest of the run.
      live.add(banner)
      banner.onshow = () => {
        counted(`show-${arm.id}`, `${arm.label} 第 ${shot} 发 onshow ✓（${where}）`, 4)
        check(`notify.${arm.id}`, arm.label, `#${attempt} onshow ✓ · 第 ${shot} 发 · ${where}`, 'good')
      }
      banner.onerror = () => {
        live.delete(banner)
        counted(`error-${arm.id}`, `${arm.label} 第 ${shot} 发 onerror ✗`, 4)
        check(`notify.${arm.id}`, arm.label, `#${attempt} onerror ✗`, 'bad')
      }
      banner.onclose = () => {
        live.delete(banner)
        counted(`close-${arm.id}`, `${arm.label} 第 ${shot} 发已关闭`, 4)
      }
      check(`notify.${arm.id}`, arm.label, `#${attempt} 已构造 · 第 ${shot} 发 · ${where}（持有 ${live.size} 条）`, 'wait')
    }

    //#endregion

    //#region panel

    const TONE_COLOR = { good: '#4ade80', bad: '#f87171', wait: '#fbbf24' }

    /**
     * Order the checks for display: pinned ids first, then everything else in
     * insertion order.
     *
     * @param checks - The check map.
     * @returns Rows in display order.
     */
    function orderedRows(checks) {
      const rows = []
      for (const id of PINNED) {
        const row = checks.get(id)
        if (row !== undefined) rows.push({ id, ...row })
      }
      for (const [id, row] of checks) if (!PINNED.includes(id)) rows.push({ id, ...row })
      return rows
    }

    /** One `label · value` row of the report. */
    function CheckRow({ row }) {
      return h(
        'div',
        { className: 'aap-row' },
        h('span', { className: 'aap-row-label', title: row.label }, row.label),
        h('span', { className: 'aap-row-value', style: { color: TONE_COLOR[row.tone] ?? TONE_COLOR.wait } }, row.value),
      )
    }

    /** The floating diagnostics card. */
    function Panel({ onClose, onNotify, onPlay }) {
      const state = useStore()
      const rows = orderedRows(state.checks)
      const lines = [...state.log].reverse()
      const now = Date.now()
      const pending = [...state.pending.values()].sort((left, right) => left.at - right.at)

      return h(
        'div',
        { className: 'aap-card' },
        h(
          'div',
          { className: 'aap-head' },
          h('span', { className: 'aap-title' }, 'Agent Alerts 探针'),
          h('button', { className: 'aap-x', type: 'button', onClick: onClose, title: '收起' }, '×'),
        ),

        pending.length === 0
          ? null
          : h(
              'div',
              { className: 'aap-countdown' },
              `⏳ ${Math.max(0, (pending[0].at - now) / 1000).toFixed(1)} 秒后响：${pending[0].label}（第 ${pending[0].shot}/${pending[0].total} 发）—— 现在切走`,
            ),

        h('div', { className: 'aap-section' }, '通知实验 —— A 点 1 次；B/C/D 点完立刻切走'),
        h(
          'div',
          { className: 'aap-arms' },
          ARMS.map((arm) =>
            h(
              'div',
              { className: 'aap-arm', key: arm.id },
              h(
                'button',
                { className: 'aap-btn', type: 'button', onClick: () => onNotify(arm) },
                `${arm.label} · 已响 ${state.attempts.get(arm.id) ?? 0}`,
              ),
              h('span', { className: 'aap-hint' }, arm.hint),
            ),
          ),
        ),

        h(
          'div',
          { className: 'aap-actions' },
          h('button', { className: 'aap-btn', type: 'button', onClick: () => onPlay('finish') }, '播放 finish'),
          h('button', { className: 'aap-btn', type: 'button', onClick: () => onPlay('question') }, '播放 question'),
        ),

        h('div', { className: 'aap-section' }, '实测明细'),
        h('div', { className: 'aap-rows' }, rows.map((row) => h(CheckRow, { key: row.id, row }))),

        h('div', { className: 'aap-section' }, `事件日志（共 ${state.counts.size} 类）`),
        h(
          'div',
          { className: 'aap-log' },
          lines.length === 0
            ? h('div', { className: 'aap-empty' }, '暂无事件。跑一个 turn、或让我提问试试。')
            : lines.map((line, index) =>
                h(
                  'div',
                  { className: 'aap-line', key: `${line.at}:${index}` },
                  h('span', { className: 'aap-time' }, clock(line.at)),
                  h('span', null, line.text ?? `${line.key} ×${line.count}`),
                ),
              ),
        ),
      )
    }

    /** The pill that brings the card back after it is collapsed. */
    function Pill({ onOpen }) {
      return h('button', { className: 'aap-pill', type: 'button', onClick: onOpen }, '探针')
    }

    /** The registered overlay entry: card or pill. */
    function Overlay(props) {
      const state = useStore()
      if (state.dismissed) return h(Pill, { onOpen: props.onOpen })
      return h(Panel, props)
    }

    const CSS = `
.aap-card{position:fixed;right:16px;bottom:16px;width:min(460px,calc(100vw - 32px));max-height:min(86vh,780px);
  display:flex;flex-direction:column;gap:7px;padding:12px 14px;border-radius:12px;pointer-events:auto;
  background:rgba(18,18,22,.96);color:#f4f4f5;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
  box-shadow:0 18px 48px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.14);z-index:2147483000}
.aap-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.aap-title{font-weight:600;font-size:13px}
.aap-x{all:unset;cursor:pointer;padding:0 6px;font-size:16px;line-height:1;opacity:.7}
.aap-x:hover{opacity:1}
.aap-section{color:#a1a1aa;font-size:11px;letter-spacing:.04em;text-transform:uppercase}
.aap-countdown{padding:6px 9px;border-radius:8px;background:rgba(251,191,36,.16);border:1px solid rgba(251,191,36,.5);color:#fbbf24}
.aap-actions{display:flex;flex-wrap:wrap;gap:6px}
.aap-arms{display:flex;flex-direction:column;gap:4px}
.aap-arm{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.aap-hint{color:#71717a;font-size:11px}
.aap-btn{all:unset;cursor:pointer;padding:3px 9px;border-radius:6px;border:1px solid rgba(255,255,255,.22);
  background:rgba(255,255,255,.08);font:inherit;flex:0 0 auto}
.aap-btn:hover{background:rgba(255,255,255,.16)}
.aap-rows{display:flex;flex-direction:column;gap:2px;overflow:auto;max-height:30vh}
.aap-row{display:flex;gap:8px;align-items:baseline}
.aap-row-label{flex:0 0 140px;color:#a1a1aa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aap-row-value{flex:1 1 auto;word-break:break-all}
.aap-log{overflow:auto;height:150px;display:flex;flex-direction:column;gap:2px}
.aap-empty{color:#71717a}
.aap-line{display:flex;gap:8px;word-break:break-all}
.aap-time{color:#71717a;flex:0 0 auto}
.aap-pill{position:fixed;right:16px;bottom:16px;z-index:2147483000;pointer-events:auto;cursor:pointer;
  padding:6px 12px;border-radius:999px;border:1px solid rgba(255,255,255,.2);background:rgba(18,18,22,.9);
  color:#f4f4f5;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
`

    //#endregion

    //#region audio

    /** Live `Audio` handles, keyed by check id, so a replay reuses one element. */
    const players = new Map()

    /**
     * Build or reuse an `Audio` element for one route.
     *
     * @param key - Player key.
     * @param url - Root-relative media URL.
     * @returns The element.
     */
    function playerFor(key, url) {
      const existing = players.get(key)
      if (existing !== undefined) return existing
      const audio = new Audio(url)
      audio.preload = 'auto'
      players.set(key, audio)
      return audio
    }

    /**
     * Describe an `Audio` element's readiness in one line.
     *
     * @param audio - Element to describe.
     * @returns A short human summary.
     */
    function mediaState(audio) {
      if (audio.error !== null && audio.error !== undefined) return `error ${audio.error?.code ?? '?'} ${audio.error?.message ?? ''}`.trim()
      const duration = Number.isFinite(audio.duration) ? `${audio.duration.toFixed(1)}s` : '—'
      return `readyState=${audio.readyState} duration=${duration}`
    }

    //#endregion

    /**
     * Install the probe.
     *
     * @param ctx - Client Cordis context.
     */
    function apply(ctx) {
      // ---- static report that needs no service at all ----
      check('env.notification', 'Notification 接口', typeof Notification === 'undefined' ? '缺失' : `permission=${Notification.permission}`, typeof Notification === 'undefined' ? 'bad' : 'good')
      check('env.origin', '页面 origin', window.location.origin, 'wait')
      check('env.focus', '窗口焦点', `${document.visibilityState} / hasFocus=${String(document.hasFocus())}`, 'wait')

      const onFocus = () => check('env.focus', '窗口焦点', `${document.visibilityState} / hasFocus=${String(document.hasFocus())}`, 'wait')
      ctx.effect(() => {
        document.addEventListener('visibilitychange', onFocus)
        window.addEventListener('focus', onFocus)
        window.addEventListener('blur', onFocus)
        return () => {
          document.removeEventListener('visibilitychange', onFocus)
          window.removeEventListener('focus', onFocus)
          window.removeEventListener('blur', onFocus)
        }
      }, `${NS}: focus reporting`)

      // ---- styles ----
      ctx.effect(() => {
        if (document.querySelector(`style[data-plugin-css="${NS}"]`) !== null) return undefined
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', NS)
        style.textContent = CSS
        document.head?.appendChild(style)
        return () => style.remove()
      }, `${NS}: styles`)

      // ---- countdown ----
      //
      // The delayed arms only mean anything if the user actually leaves the
      // window, and "click, then count to five, then switch" is exactly the kind
      // of instruction that fails. A visible countdown turns it into "switch
      // now", so the tick only runs while something is scheduled.
      ctx.effect(() => {
        const timer = setInterval(() => {
          if (store.pending.size > 0) changed()
        }, 250)
        return () => clearInterval(timer)
      }, `${NS}: notification countdown`)

      // ---- R2: is the Host route reachable at all? ----
      const ping = async () => {
        try {
          const response = await fetch(`${ROUTE}/ping`, { credentials: 'same-origin' })
          const text = await response.text()
          let body
          try {
            body = JSON.parse(text)
          } catch {
            body = undefined
          }
          if (response.status !== 200) {
            check('route.ping', 'Host 路由 fetch', `HTTP ${response.status} · ${text.slice(0, 80)}`, 'bad')
            return
          }
          check(
            'route.ping',
            'Host 路由 fetch',
            `200 admitted=${String(body?.admitted)} cookie=${String(body?.sawCookie)}`,
            body?.admitted === true ? 'good' : 'bad',
          )
        } catch (error) {
          check('route.ping', 'Host 路由 fetch', `抛错 ${String(error?.message ?? error)}`, 'bad')
        }
      }
      void ping()

      // ---- R2/R3: does the media loader reach the route, and does it play? ----
      /**
       * Load one sound over a route and report both the HTTP answer and the
       * media element's own verdict.
       *
       * The two are separate on purpose: `fetch` proves routing and admission,
       * while `<audio src>` additionally proves the media loader's request is
       * admitted — it is not the same request path.
       *
       * @param id - Check id.
       * @param label - Check label.
       * @param path - Route path to load from.
       * @param kind - Sound key.
       * @param autoplay - Whether to attempt `play()` with no gesture.
       */
      const loadSound = async (id, label, path, kind, autoplay) => {
        const url = `${path}?kind=${kind}`
        try {
          const response = await fetch(url, { credentials: 'same-origin' })
          if (!response.ok) {
            check(id, label, `fetch HTTP ${response.status}`, 'bad')
          } else {
            const bytes = await response.arrayBuffer()
            check(id, label, `fetch 200 · ${bytes.byteLength}B`, 'good')
          }
        } catch (error) {
          check(id, label, `fetch 抛错 ${String(error?.message ?? error)}`, 'bad')
        }

        const audio = playerFor(id, url)
        await new Promise((resolve) => {
          const done = () => {
            audio.removeEventListener('canplaythrough', done)
            audio.removeEventListener('error', done)
            resolve()
          }
          audio.addEventListener('canplaythrough', done, { once: true })
          audio.addEventListener('error', done, { once: true })
          audio.load()
          setTimeout(done, 4000)
        })
        const loadLine = mediaState(audio)
        check(id, label, loadLine, audio.error === null || audio.error === undefined ? 'good' : 'bad')

        if (!autoplay) return
        try {
          await audio.play()
          audio.pause()
          audio.currentTime = 0
          check('audio.autoplay', '无手势自动播放', 'play() 成功（没有 NotAllowedError）', 'good')
        } catch (error) {
          check('audio.autoplay', '无手势自动播放', `被拒 ${String(error?.name ?? '')}`, 'bad')
        }
      }

      void loadSound('media.gated.finish', '✓ 受控路由 finish', `${ROUTE}/sound`, 'finish', true)
      void loadSound('media.open.question', '开放路由 question', `${ROUTE}/sound-open`, 'question', false)

      /** Play a sound from the panel, reporting the outcome. */
      const play = (kind) => {
        const id = kind === 'finish' ? 'media.gated.finish' : 'media.open.question'
        const audio = players.get(id)
        if (audio === undefined) {
          check('audio.manual', '手动播放', `${kind}: 播放器尚未就绪`, 'bad')
          return
        }
        audio.currentTime = 0
        audio.volume = 1
        audio.play().then(
          () => check('audio.manual', '手动播放', `${kind}: 成功 · ${mediaState(audio)}`, 'good'),
          (error) => check('audio.manual', '手动播放', `${kind}: ${String(error?.name ?? '')}`, 'bad'),
        )
      }

      // ---- R7: the application's own status source ----
      //
      // `dsh-client-ui-session` publishes `ctx.uiSession` as a Cordis *service*,
      // and `sessionStatus` is a public field on it: the very
      // `{ running, pendingInteraction, completionUnread }` map the app's own
      // unread badges are computed from. If it resolves for an external plugin
      // it is a strictly better trigger source than the forwarded events,
      // because one subscription covers all three moments and it does not sit
      // in a waterfall chain whose earlier listener can short-circuit it.
      const uiSession = serviceOf(ctx, 'uiSession')
      const status = uiSession?.sessionStatus
      if (status !== undefined && typeof status.subscribe === 'function' && typeof status.getSnapshot === 'function') {
        check('uiSession', 'uiSession.sessionStatus', '已订阅', 'good')
        const previous = new Map()
        const sync = () => {
          let snapshot
          try {
            snapshot = status.getSnapshot()
          } catch (error) {
            check('uiSession', 'uiSession.sessionStatus', `getSnapshot 抛错 ${String(error?.message ?? error)}`, 'bad')
            return
          }
          const entries = snapshot instanceof Map ? [...snapshot] : []
          const line = `entries=${entries.length}`
          if (store.checks.get('uiSession')?.value !== line) check('uiSession', 'uiSession.sessionStatus', line, 'good')
          const seen = new Set()
          for (const [id, value] of entries) {
            seen.add(id)
            const was = previous.get(id)
            const pending = value?.pendingInteraction ?? undefined
            if (pending !== undefined && was?.pending === undefined) {
              const kind = String(pending?.kind ?? pending?.constructor?.name ?? '?')
              counted('pending', `★ 需要你 · ${kind} · ${shortId(id)}`)
              check('uiSession.pending', 'uiSession 待办', `${kind} · ${shortId(id)}`, 'good')
            }
            if (pending === undefined && was?.pending !== undefined) {
              counted('pending-end', `✓ 待办已解决 · ${String(was.pending?.kind ?? '?')} · ${shortId(id)}`, 6)
            }
            // A first sighting is NOT a transition. Round 1 taught this the hard
            // way: the app marks every historically idle session
            // `completionUnread` while its list baseline loads, and reporting
            // first sightings turned that into 22 phantom events.
            if (was !== undefined) {
              if (was.running === true && value?.running !== true) counted('ui-turn-end', `★ TURN END (uiSession) · ${shortId(id)}`, 6)
              if (value?.completionUnread === true && was.completionUnread !== true) counted('unread', `● completionUnread · ${shortId(id)}`, 2)
            }
            previous.set(id, { pending, running: value?.running, completionUnread: value?.completionUnread })
          }
          for (const id of [...previous.keys()]) if (!seen.has(id)) previous.delete(id)
        }
        ctx.effect(() => {
          const off = status.subscribe(sync)
          sync()
          return typeof off === 'function' ? off : undefined
        }, `${NS}: uiSession sessionStatus`)
      } else {
        check('uiSession', 'uiSession.sessionStatus', `不可用（service=${typeof uiSession}）`, 'bad')
      }

      // ---- R6: the turn-end signal, second source ----
      const sessions = serviceOf(ctx, 'sessions')
      const list = sessions?.list
      if (list !== undefined && typeof list.subscribe === 'function' && typeof list.getSnapshot === 'function') {
        const running = new Map()
        const sync = () => {
          let snapshot
          try {
            snapshot = list.getSnapshot()
          } catch (error) {
            check('sessions.list', 'sessions.list', `getSnapshot 抛错 ${String(error?.message ?? error)}`, 'bad')
            return
          }
          const ids = Array.isArray(snapshot?.ids) ? snapshot.ids : []
          const line = `ids=${ids.length} phase=${String(snapshot?.phase)}`
          if (store.checks.get('sessions.list')?.value !== line) check('sessions.list', 'sessions.list', line, 'good')
          for (const id of ids) {
            const row = snapshot?.byId?.[id]
            if (row === undefined || row === null) continue
            const was = running.get(id)
            const now = row.running === true
            running.set(id, now)
            if (was === undefined || was === now) continue
            const where = `${shortId(id)} origin=${String(row.origin ?? 'main')}`
            if (was && !now) counted('turn-end', `★ TURN END · ${where} · ${String(row.displayTitle ?? '')}`)
            else counted('turn-start', `▶ 开始运行 · ${where}`, 2)
          }
        }
        ctx.effect(() => {
          const off = list.subscribe(sync)
          sync()
          return typeof off === 'function' ? off : undefined
        }, `${NS}: session running transitions`)
      } else {
        check('sessions.list', 'sessions.list', '不可用（拿不到 subscribe/getSnapshot）', 'bad')
      }

      // ---- R5: the settings form wiring ----
      const configForms = serviceOf(ctx, 'configForms')
      if (configForms === undefined) {
        check('configForms', 'configForms', '服务缺失', 'bad')
      } else {
        try {
          const form = configForms.get(ROW_ID)
          const snapshot = form?.getSnapshot?.()
          check('configForms', 'configForms', `get=ok status=${String(snapshot?.status)} value=${JSON.stringify(snapshot?.value ?? null)}`, 'good')
        } catch (error) {
          check('configForms', 'configForms', `get 抛错 ${String(error?.message ?? error)}`, 'bad')
        }
        try {
          const mirror = configForms.describe?.()
          const snapshot = mirror?.getSnapshot?.()
          const namespaces = (snapshot?.view?.namespaces ?? []).map((view) => view.ns)
          const thirdParty = namespaces.filter((ns) => ns.includes('-') && !ns.startsWith('ui-'))
          check(
            'configForms.ns',
            'Host 托管 ns',
            `${namespaces.length} 个 · 像第三方插件的：${thirdParty.slice(0, 8).join(', ') || '无'}`,
            namespaces.length > 0 ? 'good' : 'bad',
          )
        } catch (error) {
          check('configForms.ns', 'Host 托管 ns', `describe 抛错 ${String(error?.message ?? error)}`, 'bad')
        }
      }

      // ---- R4: forwarded events, including the two waterfalls ----
      const remote = serviceOf(ctx, 'remote')
      if (remote === undefined || typeof remote.$on !== 'function') {
        check('remote', 'ctx.remote.$on', '服务缺失', 'bad')
      } else {
        check('remote', 'ctx.remote.$on', '可用，已订阅', 'good')
        ctx.effect(() => {
          remote.$on('api-session/status', (sessionId, isRunning) => {
            counted('status', `api-session/status · ${shortId(sessionId)} running=${String(isRunning)}`, 2)
          })
        }, `${NS}: api-session/status`)

        // A waterfall listener OWNS the chain: it must hand control on. Each of
        // these is wrapped so a bug in the probe cannot hang a real question.
        // Whether they run at all is the open question — the shipped UI
        // listener registers first and may answer without calling `next()`.
        ctx.effect(() => {
          remote.$on('user-questions/request', function (request, next) {
            try {
              const questions = Array.isArray(request?.questions) ? request.questions : []
              counted(
                'question',
                `★ user-questions/request · ${questions.length} 问 · “${String(questions[0]?.question ?? '').slice(0, 28)}”`,
              )
            } catch (error) {
              console.warn(`${NS}: question listener threw`, error)
            }
            return next()
          })
        }, `${NS}: user-questions/request`)

        ctx.effect(() => {
          remote.$on('approval/request', function (request, next) {
            try {
              counted('approval', `★ approval/request · tool=${String(request?.toolName ?? request?.name ?? '?')}`)
            } catch (error) {
              console.warn(`${NS}: approval listener threw`, error)
            }
            return next()
          })
        }, `${NS}: approval/request`)
      }

      // ---- the panel itself ----
      ctx.slots.inject(SLOT, () =>
        ctx.slots.register(
          {
            name: SLOT,
            id: 'agent-alerts-probe.panel',
            order: 999,
          },
          () =>
            h(Overlay, {
              onClose: () => {
                store.dismissed = true
                changed()
              },
              onOpen: () => {
                store.dismissed = false
                changed()
              },
              onNotify: (arm) => scheduleNotification(arm),
              onPlay: play,
            }),
        ),
      )

      console.info(`${NS}: probe mounted`)
    }

    return {
      apply,
      // `slots` is the one hard dependency: the panel is the probe's whole
      // output surface. Everything else is resolved through `ctx.get` so a
      // missing service is reported in the panel instead of stopping `apply`.
      inject: ['slots'],
    }
  },
})
