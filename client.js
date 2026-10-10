/**
 * Agent Alerts — browser half.
 *
 * The Host half can serve bytes and persist settings; only the page can raise a
 * notification or make a sound. This half owns the four things that only exist
 * at runtime:
 *
 *   1. WHEN. The application already computes exactly the three moments this
 *      plugin cares about, in `ctx.uiSession.sessionStatus` — the same
 *      `{ running, pendingInteraction, completionUnread }` map its own unread
 *      badges come from. One subscription covers a finished turn, a question,
 *      and an approval request, and it sits outside every waterfall chain, so no
 *      earlier listener can short-circuit it. The forwarded
 *      `user-questions/request` / `approval/request` events are subscribed
 *      *as well*, purely as a best-effort second source: the shipped UI listener
 *      registers first and answers without calling `next()`, so those may never
 *      reach this plugin at all, and nothing here depends on them.
 *
 *   2. WHAT to say. A per-moment sound from the Host's route, and a native
 *      notification whose body is worth reading — the question text, the tool
 *      asking for approval, or the session that finished.
 *
 *   3. HOW LOUD. Every alert respects the settings the Host owns, read live
 *      through `ctx.configForms`.
 *
 *   4. The settings page itself, registered on the plugin's own row in
 *      Settings → Plugins.
 *
 * Two behaviours are deliberate and easy to get wrong:
 *
 *   - **A first sighting is not a transition.** At boot the application marks
 *     every historically idle session `completionUnread` (measured: 22 in a
 *     1537-session store). Reacting to first sightings would fire that many
 *     alerts on every launch, so transitions are only counted between two
 *     snapshots this plugin has both seen.
 *
 *   - **A finished turn is confirmed before it is announced.** A goal round ends
 *     its turn and starts the next one a moment later; announcing the first
 *     would be actively misleading. The alert is therefore held for
 *     {@link SETTLE_MS} and dropped if the session is running again.
 *
 * @module dsh-plugin-agent-alerts/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-agent-alerts',
  factory(require) {
    const React = require('react')

    const h = React.createElement

    /** Locale namespace; also the slot registration's `locale` key. */
    const NS = 'dsh-plugin-agent-alerts'

    /**
     * The Loader row id from `cordis.patch.yml`.
     *
     * Load-bearing twice over: `dsh-settings` derives the plugin's settings
     * namespace from it, and this half resolves Config through
     * `ctx.configForms.get(ROW_ID)`. It must stay in step with the patch.
     */
    const ROW_ID = 'agent-alerts'

    /** Route prefix registered by the Host half; must match `index.js`. */
    const ROUTE = '/api/agent-alerts'

    /**
     * The settings seat for this plugin's row.
     *
     * The plugin manager keys `plugins.row.config` by `<package name>#<row id>`,
     * and only while an entry names the row does the row grow a configure
     * control at all.
     */
    const PANEL_KEY = 'dsh-plugin-agent-alerts#agent-alerts'

    /**
     * How long a finished turn is held before it is announced.
     *
     * A goal round closes its turn and opens the next one immediately; without
     * this, every round would announce "the agent finished" while it was in fact
     * still working.
     */
    const SETTLE_MS = 1500

    /**
     * Suppression window for the same moment on the same session.
     *
     * Two independent sources can report one question; an alert repeated inside
     * this window is the same alert, not a second one.
     */
    const DEDUPE_MS = 4000

    /** Cap on retained notification objects, so a long session cannot leak. */
    const LIVE_NOTIFICATIONS = 8

    //#region dictionaries

    const DICT = {
      en: {
        'meta.title': 'Agent Alerts',
        'meta.description': 'A desktop notification and a sound when the agent finishes, asks you a question, or needs your approval.',

        'turnEnd.title': 'Finished',
        'turnEnd.body': '{session}',
        'turnEnd.bodyPlain': 'The agent finished its turn.',

        'question.title': 'Waiting for your answer',
        'question.body': '{question}',

        'plan.title': 'Waiting for your review',
        'plan.body': '{question}',

        'approval.title': 'Waiting for your approval',
        'approval.body': '{tool} wants to run.',

        'settings.title': 'Agent Alerts',
        'settings.group.when': 'When to alert',
        'settings.group.how': 'How to alert',
        'settings.group.custom': 'Your own sounds',

        'field.turnEnd': 'A turn finished',
        'field.turnEnd.help': 'The agent handed control back to you.',
        'field.question': 'The agent asked a question',
        'field.question.help': 'Also covers a plan waiting for your review.',
        'field.approval': 'A tool needs approval',
        'field.approval.help': 'The agent is blocked until you decide.',

        'field.sound': 'Play a sound',
        'field.sound.help': 'The bundled chime, or your own file below.',
        'field.notifyMode': 'How to notify',
        'field.notifyMode.help': 'A banner comes from the app itself. The system fallback asks macOS instead, and is attributed to Script Editor — use it if no banner appears.',
        'notify.off': 'Off',
        'notify.banner': 'App banner',
        'notify.system': 'System fallback',
        'settings.testNotification': 'Send a test',
        'field.quietWhenFocused': 'Stay quiet while the window is focused',
        'field.quietWhenFocused.help': 'The sound still plays — only the banner is skipped.',
        'field.volume': 'Volume',
        'field.volume.help': 'Only affects the sound, and only when it is on.',

        'field.turnEndSound': 'Sound for a finished turn',
        'field.turnEndSound.help': 'An absolute path to an audio file. Empty uses the bundled sound.',
        'field.questionSound': 'Sound for a question or approval',
        'field.questionSound.help': 'An absolute path to an audio file. Empty uses the bundled sound.',

        'settings.bundled': 'Using the bundled sound',
        'settings.customOk': 'Your file, {size}',
        'settings.customMissing': 'Cannot read it: {error}',
        'settings.preview': 'Preview',
        'settings.previewFailed': 'Playback failed: {error}',
        'settings.storage': 'Saved to your profile\u2019s cordis.patch.yml, beside every other Harness preference.',

        'summary': 'A notification and a sound the moment an agent finishes, asks a question, or needs approval.',
      },
      zh: {
        'meta.title': '智能体提醒',
        'meta.description': 'agent 回复完、向你提问、或需要你批准工具时，弹出桌面通知并播放提示音。',

        'turnEnd.title': '回复完了',
        'turnEnd.body': '{session}',
        'turnEnd.bodyPlain': 'agent 已经把这一轮做完了。',

        'question.title': '等你回答',
        'question.body': '{question}',

        'plan.title': '等你确认方案',
        'plan.body': '{question}',

        'approval.title': '等你批准',
        'approval.body': '{tool} 想执行。',

        'settings.title': '智能体提醒',
        'settings.group.when': '什么时候提醒',
        'settings.group.how': '怎么提醒',
        'settings.group.custom': '自定义音效',

        'field.turnEnd': '一轮做完了',
        'field.turnEnd.help': 'agent 把控制权交还给你。',
        'field.question': 'agent 向你提问',
        'field.question.help': '也包括等你确认的方案。',
        'field.approval': '工具需要你批准',
        'field.approval.help': '你不决定，它就卡在那里。',

        'field.sound': '播放提示音',
        'field.sound.help': '内置音效，或在下面填你自己的文件。',
        'field.notifyMode': '通知方式',
        'field.notifyMode.help': '横幅由 app 自己发。系统兜底是让 macOS 代为通知，署名会是「脚本编辑器」—— 如果横幅一直不出现就用它。',
        'notify.off': '关闭',
        'notify.banner': '应用横幅',
        'notify.system': '系统兜底',
        'settings.testNotification': '发一条测试',
        'field.quietWhenFocused': '窗口在前台时不弹通知',
        'field.quietWhenFocused.help': '提示音照常播放，只是不弹横幅。',
        'field.volume': '音量',
        'field.volume.help': '只影响提示音，且只在它打开时有用。',

        'field.turnEndSound': '「做完了」的提示音',
        'field.turnEndSound.help': '音频文件的绝对路径。留空就用内置的。',
        'field.questionSound': '「提问 / 批准」的提示音',
        'field.questionSound.help': '音频文件的绝对路径。留空就用内置的。',

        'settings.bundled': '正在使用内置音效',
        'settings.customOk': '你的文件，{size}',
        'settings.customMissing': '读不到：{error}',
        'settings.preview': '试听',
        'settings.previewFailed': '播放失败：{error}',
        'settings.storage': '保存在 profile 的 cordis.patch.yml 里，和其他 Harness 偏好放在一起。',

        'summary': 'agent 回复完、提问、或需要批准时，弹通知并播放提示音。',
      },
    }

    //#endregion

    //#region settings fields

    /**
     * The settings surface, in the order it is rendered.
     *
     * This list must mirror the Host `Config` schema exactly — a key that exists
     * here and not there can never be written, and one that exists there and not
     * here is invisible. `tests/plugin.test.mjs` reads the Host half as text and
     * fails when the two drift.
     */
    const FIELDS = [
      { key: 'turnEnd', type: 'boolean', group: 'when', default: true },
      { key: 'question', type: 'boolean', group: 'when', default: true },
      { key: 'approval', type: 'boolean', group: 'when', default: true },
      { key: 'sound', type: 'boolean', group: 'how', default: true },
      { key: 'notifyMode', type: 'enum', group: 'how', default: 'banner', options: ['off', 'banner', 'system'] },
      { key: 'quietWhenFocused', type: 'boolean', group: 'how', default: true },
      { key: 'volume', type: 'number', group: 'how', default: 0.8, min: 0, max: 1, step: 0.05 },
      { key: 'turnEndSound', type: 'string', group: 'custom', default: '' },
      { key: 'questionSound', type: 'string', group: 'custom', default: '' },
    ]

    /** Group headings, in render order. */
    const GROUPS = ['when', 'how', 'custom']

    //#endregion

    //#region small helpers

    /**
     * Resolve a Client service without letting a missing one abort the mount.
     *
     * @param ctx - Client Cordis context.
     * @param name - Service key.
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

    /** Render bytes as something a person can read. */
    function formatBytes(bytes) {
      if (!Number.isFinite(bytes)) return '—'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    /** Collapse whitespace and cap a string for a notification body. */
    function oneLine(text, limit) {
      const flat = String(text ?? '')
        .replace(/\s+/g, ' ')
        .trim()
      return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
    }

    //#endregion

    //#region the settings page

    /**
     * Subscribe a component to one `ConfigFormController`.
     *
     * @param form - The controller from `ctx.configForms.get(ROW_ID)`.
     * @returns The current snapshot, replaced on every change.
     */
    function useFormSnapshot(form) {
      const [snapshot, setSnapshot] = React.useState(() => (form === undefined ? undefined : form.getSnapshot()))
      React.useEffect(() => {
        if (form === undefined) return undefined
        const sync = () => setSnapshot(form.getSnapshot())
        sync()
        const dispose = form.subscribe(sync)
        return typeof dispose === 'function' ? dispose : undefined
      }, [form])
      return snapshot
    }

    /**
     * One labelled text field.
     *
     * The draft is local while the field has focus and the Host is the authority
     * otherwise, so an edit made in `cordis.patch.yml` still shows up here.
     */
    function TextRow({ value, disabled, placeholder, onCommit }) {
      const [draft, setDraft] = React.useState(value)
      const [editing, setEditing] = React.useState(false)
      React.useEffect(() => {
        if (!editing) setDraft(value)
      }, [value, editing])
      return h('input', {
        className: 'aaa-input',
        type: 'text',
        value: draft ?? '',
        placeholder: placeholder ?? '',
        disabled: disabled === true,
        spellCheck: false,
        onFocus: () => setEditing(true),
        onChange: (event) => setDraft(event.target.value),
        onBlur: () => {
          setEditing(false)
          if ((draft ?? '') !== (value ?? '')) onCommit(draft ?? '')
        },
        onKeyDown: (event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        },
      })
    }

    /**
     * The settings page for this plugin's row.
     *
     * Two sources of truth are on purpose: the live values come from the Host
     * through `ctx.configForms`, while the *validity* of a configured sound comes
     * from the Host's status route, because only the Host can see the filesystem.
     * A path that does not resolve has to be visible here, or "my sound is not
     * playing" is indistinguishable from "my path has a typo".
     */
    function SettingsPage(props) {
      const t = props.t
      const form = props.form
      const snapshot = useFormSnapshot(form)
      const live = snapshot !== undefined && typeof snapshot.value === 'object' && snapshot.value !== null ? snapshot.value : {}
      const writable = snapshot === undefined || snapshot.writable !== false

      const [local, setLocal] = React.useState({})
      const revision = snapshot === undefined ? undefined : snapshot.revision
      const lastRevision = React.useRef(revision)
      React.useEffect(() => {
        if (lastRevision.current !== revision) {
          lastRevision.current = revision
          setLocal({})
        }
      }, [revision])

      const valueOf = (field) => (field.key in local ? local[field.key] : (live[field.key] ?? field.default))
      const commit = (field, next) => {
        setLocal((previous) => ({ ...previous, [field.key]: next }))
        if (form === undefined) return
        Promise.resolve(form.set(field.key, next)).catch((error) => {
          console.warn(`${NS}: settings write failed`, error)
        })
      }

      const [sounds, setSounds] = React.useState(null)
      const [previewError, setPreviewError] = React.useState(null)

      // The status route is the Host's own answer about the two files, so it is
      // re-read whenever either path changes.
      const turnEndPath = valueOf(FIELDS.find((field) => field.key === 'turnEndSound'))
      const questionPath = valueOf(FIELDS.find((field) => field.key === 'questionSound'))
      React.useEffect(() => {
        let cancelled = false
        const read = async () => {
          try {
            const response = await fetch(`${ROUTE}/status`, { credentials: 'same-origin' })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const body = await response.json()
            if (!cancelled) setSounds(Array.isArray(body?.sounds) ? body.sounds : [])
          } catch (error) {
            if (!cancelled) setSounds(null)
            console.warn(`${NS}: sound status unavailable`, error)
          }
        }
        void read()
        return () => {
          cancelled = true
        }
      }, [turnEndPath, questionPath])

      const preview = (kind) => {
        setPreviewError(null)
        const audio = props.audioFor(kind)
        audio.currentTime = 0
        audio.volume = typeof valueOf(FIELDS.find((field) => field.key === 'volume')) === 'number' ? valueOf(FIELDS.find((field) => field.key === 'volume')) : 0.8
        audio.play().catch((error) => setPreviewError(String(error?.message ?? error)))
      }

      const statusOf = (kind) => {
        if (sounds === null) return null
        return sounds.find((entry) => entry.kind === kind) ?? null
      }

      const renderStatus = (kind) => {
        const status = statusOf(kind)
        if (status === null) return null
        if (status.source === 'bundled') return h('span', { className: 'aaa-status' }, t('settings.bundled'))
        if (status.ok === true) return h('span', { className: 'aaa-status aaa-ok' }, t('settings.customOk', { size: formatBytes(status.bytes) }))
        return h('span', { className: 'aaa-status aaa-bad' }, t('settings.customMissing', { error: String(status.error) }))
      }

      const groups = GROUPS.map((group) => ({
        group,
        fields: FIELDS.filter((field) => field.group === group),
      }))

      return h(
        'div',
        { className: 'aaa-page' },
        groups.map(({ group, fields }) =>
          h(
            'section',
            { className: 'aaa-group', key: group },
            h('h4', { className: 'aaa-group-title' }, t(`settings.group.${group}`)),
            fields.map((field) => {
              const value = valueOf(field)
              const text = h(
                'span',
                { className: 'aaa-row-text' },
                h('span', { className: 'aaa-label' }, t(`field.${field.key}`)),
                h('span', { className: 'aaa-help' }, t(`field.${field.key}.help`)),
              )
              if (field.type === 'enum') {
                return h(
                  'label',
                  { className: 'aaa-row', key: field.key },
                  text,
                  h(
                    'span',
                    { className: 'aaa-enum' },
                    h(
                      'select',
                      {
                        className: 'aaa-select',
                        value: typeof value === 'string' ? value : field.default,
                        disabled: !writable,
                        onChange: (event) => commit(field, event.target.value),
                      },
                      field.options.map((option) => h('option', { key: option, value: option }, t(`notify.${option}`))),
                    ),
                    // Finding the transport that works is a ten-second experiment
                    // rather than a guess, so the experiment is one click away.
                    field.key === 'notifyMode'
                      ? h(
                          'button',
                          {
                            className: 'aaa-button',
                            type: 'button',
                            disabled: !writable,
                            onClick: () => {
                              const mode = typeof value === 'string' ? value : field.default
                              if (mode === 'off') return
                              if (mode === 'system') void props.systemNotify(t('turnEnd.title'), t('turnEnd.bodyPlain'))
                              else props.testBanner(t('turnEnd.title'), t('turnEnd.bodyPlain'))
                            },
                          },
                          t('settings.testNotification'),
                        )
                      : null,
                  ),
                )
              }
              if (field.type === 'boolean') {
                return h(
                  'label',
                  { className: 'aaa-row', key: field.key },
                  text,
                  h('input', {
                    className: 'aaa-switch',
                    type: 'checkbox',
                    checked: value !== false,
                    disabled: !writable,
                    onChange: (event) => commit(field, event.target.checked),
                  }),
                )
              }
              if (field.type === 'number') {
                return h(
                  'label',
                  { className: 'aaa-row', key: field.key },
                  text,
                  h(
                    'span',
                    { className: 'aaa-range' },
                    h('input', {
                      type: 'range',
                      min: field.min,
                      max: field.max,
                      step: field.step,
                      value: typeof value === 'number' ? value : field.default,
                      disabled: !writable,
                      onChange: (event) => commit(field, Number(event.target.value)),
                    }),
                    h('span', { className: 'aaa-range-value' }, `${Math.round((typeof value === 'number' ? value : field.default) * 100)}%`),
                  ),
                )
              }
              const kind = field.key === 'turnEndSound' ? 'turn-end' : 'question'
              return h(
                'div',
                { className: 'aaa-row aaa-row-stack', key: field.key },
                text,
                h(TextRow, {
                  value,
                  disabled: !writable,
                  placeholder: t('settings.bundled'),
                  onCommit: (next) => commit(field, next),
                }),
                h(
                  'div',
                  { className: 'aaa-inline' },
                  h('button', { className: 'aaa-button', type: 'button', onClick: () => preview(kind) }, t('settings.preview')),
                  renderStatus(kind),
                ),
              )
            }),
          ),
        ),
        previewError === null ? null : h('p', { className: 'aaa-status aaa-bad' }, t('settings.previewFailed', { error: previewError })),
        h('p', { className: 'aaa-footnote' }, t('settings.storage')),
      )
    }

    //#endregion

    const CSS = `
.aaa-page{display:flex;flex-direction:column;gap:18px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.aaa-group{display:flex;flex-direction:column;gap:10px}
.aaa-group-title{margin:0;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.aaa-row{display:flex;align-items:center;justify-content:space-between;gap:16px}
.aaa-row-stack{flex-direction:column;align-items:stretch;gap:6px}
.aaa-row-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.aaa-label{color:var(--dsw-alias-label-primary)}
.aaa-help{font-size:12px;color:var(--dsw-alias-label-secondary)}
.aaa-switch{flex:0 0 auto;width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.aaa-input{width:100%;box-sizing:border-box;padding:6px 9px;border-radius:8px;font:inherit;
  color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);
  border:1px solid var(--dsw-alias-border-l2)}
.aaa-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.aaa-range{display:flex;align-items:center;gap:10px;flex:0 0 auto}
.aaa-range input{width:160px;accent-color:var(--dsw-alias-brand-primary)}
.aaa-range-value{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);min-width:42px;text-align:right}
.aaa-inline{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.aaa-button{cursor:pointer;padding:4px 12px;border-radius:8px;font:inherit;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l2)}
.aaa-button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.aaa-button:disabled{opacity:.5;cursor:default}
.aaa-enum{display:flex;align-items:center;gap:8px;flex:0 0 auto}
.aaa-select{cursor:pointer;padding:4px 8px;border-radius:8px;font:inherit;
  color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);
  border:1px solid var(--dsw-alias-border-l2)}
.aaa-status{font-size:12px;color:var(--dsw-alias-label-secondary)}
.aaa-ok{color:var(--dsw-alias-state-success-primary)}
.aaa-bad{color:var(--dsw-alias-state-error-primary)}
.aaa-footnote{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary)}
`

    /**
     * Install the alert engine and the settings page.
     *
     * @param ctx - Client Cordis context.
     */
    function apply(ctx) {
      // ---- dictionaries and styles ----
      ctx.effect(() => ctx.locale.register(NS, DICT), `${NS}: dictionaries`)
      const t = ctx.locale.bind(NS)

      ctx.effect(() => {
        if (document.querySelector(`style[data-plugin-css="${NS}"]`) !== null) return undefined
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', NS)
        style.textContent = CSS
        document.head?.appendChild(style)
        return () => style.remove()
      }, `${NS}: styles`)

      // ---- settings, read live ----
      //
      // Reading through the form rather than caching a snapshot is what makes a
      // settings change take effect without a reload: the controller's snapshot
      // is replaced on every Host acknowledgement.
      const configForms = serviceOf(ctx, 'configForms')
      const form = configForms === undefined ? undefined : configForms.get(ROW_ID)
      const settings = () => {
        if (form === undefined) return {}
        try {
          const snapshot = form.getSnapshot()
          return snapshot !== undefined && typeof snapshot.value === 'object' && snapshot.value !== null ? snapshot.value : {}
        } catch (error) {
          console.warn(`${NS}: settings read failed`, error)
          return {}
        }
      }
      const settingOf = (key) => {
        const value = settings()[key]
        if (value !== undefined) return value
        return FIELDS.find((field) => field.key === key)?.default
      }

      // ---- sound ----
      //
      // One element per moment, reused. Creating an element per alert would
      // restart the network fetch every time and leave the previous one playing.
      const players = new Map()
      const audioFor = (kind) => {
        const id = kind === 'turn-end' ? 'turn-end' : 'question'
        const existing = players.get(id)
        if (existing !== undefined) return existing
        const audio = new Audio(`${ROUTE}/sound?kind=${id}`)
        audio.preload = 'auto'
        players.set(id, audio)
        return audio
      }

      const playSound = (kind) => {
        if (settingOf('sound') === false) return
        try {
          const audio = audioFor(kind)
          const volume = settingOf('volume')
          audio.volume = typeof volume === 'number' ? Math.min(1, Math.max(0, volume)) : 0.8
          audio.currentTime = 0
          const started = audio.play()
          if (started !== undefined && typeof started.catch === 'function') {
            started.catch((error) => console.warn(`${NS}: sound was refused`, error))
          }
        } catch (error) {
          console.warn(`${NS}: sound failed`, error)
        }
      }

      // ---- notifications ----
      //
      // Two transports, chosen by `notifyMode`. The banner is the honest one —
      // it carries the Harness name and its click opens the session — but it
      // depends on a permission grant the page cannot observe, so the system
      // fallback exists for when it silently produces nothing.
      //
      // References to live banners are held: an Electron `Notification` with no
      // live reference can be collected, and the banner goes with it.
      const live = new Set()

      /** Ask the Host to have the system notify on this app's behalf. */
      const systemNotify = async (title, body) => {
        try {
          const response = await fetch(`${ROUTE}/notify`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title, body }),
          })
          if (!response.ok) console.warn(`${NS}: system notification refused with ${response.status}`)
        } catch (error) {
          console.warn(`${NS}: system notification failed`, error)
        }
      }

      /** Raise a banner directly, ignoring the focus rule, for the test button. */
      const testBanner = (title, body) => {
        if (typeof Notification === 'undefined') return
        try {
          const banner = new Notification(title, { body, silent: true })
          live.add(banner)
          const release = () => live.delete(banner)
          banner.onclose = release
          banner.onerror = release
        } catch (error) {
          console.warn(`${NS}: test banner failed`, error)
        }
      }

      /**
       * Compose and raise one notification.
       *
       * @param kind - `turn-end`, `question`, `plan`, or `approval`.
       * @param sessionId - The session it is about.
       * @param detail - The pending interaction, when there is one.
       */
      const showNotification = (kind, sessionId, detail) => {
        const mode = settingOf('notifyMode')
        if (mode === 'off') return
        const focused = document.visibilityState === 'visible' && document.hasFocus()
        if (settingOf('quietWhenFocused') !== false && focused) return

        const title = t(
          kind === 'turn-end' ? 'turnEnd.title' : kind === 'approval' ? 'approval.title' : kind === 'plan' ? 'plan.title' : 'question.title',
        )
        let body
        if (kind === 'turn-end') {
          const name = titleOf(sessionId)
          body = name === undefined ? t('turnEnd.bodyPlain') : t('turnEnd.body', { session: name })
        } else if (kind === 'approval') {
          body = t('approval.body', { tool: String(detail?.toolName ?? '') === '' ? 'A tool' : String(detail.toolName) })
        } else {
          const question = oneLine(detail?.questions?.[0]?.question, 140)
          body = question === '' ? title : t(kind === 'plan' ? 'plan.body' : 'question.body', { question })
        }

        if (mode === 'system') {
          void systemNotify(title, body)
          return
        }
        if (typeof Notification === 'undefined') return

        let banner
        try {
          // `silent` is true on purpose: the plugin's own sound is the audio
          // cue, and a second system sound on top of it is noise.
          banner = new Notification(title, { body, silent: true })
        } catch (error) {
          console.warn(`${NS}: notification failed`, error)
          return
        }
        live.add(banner)
        while (live.size > LIVE_NOTIFICATIONS) {
          const oldest = live.values().next().value
          live.delete(oldest)
          try {
            oldest?.close()
          } catch {
            /* closing a banner that macOS already dismissed is not a failure */
          }
        }
        const release = () => live.delete(banner)
        banner.onclose = release
        banner.onerror = release
        banner.onclick = () => {
          release()
          try {
            window.focus()
          } catch {
            /* focusing is best-effort */
          }
          if (sessionId === undefined) return
          try {
            ctx.uiWorkspace?.openSession(sessionId)
          } catch (error) {
            console.warn(`${NS}: could not open the session`, error)
          }
        }
      }

      /**
       * The session title for a notification body.
       *
       * @param sessionId - Session identity.
       * @returns The display title, or `undefined` when the row is unknown.
       */
      function titleOf(sessionId) {
        try {
          const row = sessionsList()?.byId?.[sessionId]
          const title = oneLine(row?.displayTitle, 80)
          return title === '' ? undefined : title
        } catch {
          return undefined
        }
      }

      /** The raw session list snapshot, or `undefined` when it is unavailable. */
      function sessionsList() {
        try {
          return sessionsService?.list?.getSnapshot()
        } catch {
          return undefined
        }
      }

      const sessionsService = serviceOf(ctx, 'sessions')

      /**
       * Whether a session is a subagent run.
       *
       * A workflow can finish dozens of child runs in a minute; announcing each
       * one would train the user to ignore the alert entirely. Questions and
       * approvals are deliberately NOT filtered — a child asking for approval is
       * still the user's decision to make.
       *
       * @param sessionId - Session identity.
       * @returns `true` for a child run.
       */
      function isSubagent(sessionId) {
        try {
          return sessionsList()?.byId?.[sessionId]?.origin === 'subagent'
        } catch {
          return false
        }
      }

      // ---- the one entry point every source funnels into ----
      const recent = new Map()

      /**
       * Raise one alert, subject to the settings and the suppression window.
       *
       * @param kind - `turn-end`, `question`, `plan`, or `approval`.
       * @param sessionId - Session the moment belongs to.
       * @param detail - The pending interaction, when there is one.
       */
      function alert(kind, sessionId, detail) {
        const enabled =
          kind === 'turn-end' ? settingOf('turnEnd') !== false : kind === 'approval' ? settingOf('approval') !== false : settingOf('question') !== false
        if (!enabled) return
        if (kind === 'turn-end' && isSubagent(sessionId)) return

        const key = `${kind}:${String(sessionId)}`
        const now = Date.now()
        const last = recent.get(key)
        if (last !== undefined && now - last < DEDUPE_MS) return
        recent.set(key, now)
        if (recent.size > 256) for (const [entry, at] of recent) if (now - at >= DEDUPE_MS) recent.delete(entry)

        playSound(kind === 'turn-end' ? 'turn-end' : 'question')
        showNotification(kind, sessionId, detail)
      }

      // ---- settled turns ----
      //
      // A goal round closes its turn and opens the next one immediately, so the
      // announcement is held briefly and dropped when work resumed.
      const latestStatus = { value: undefined }
      const settling = new Map()

      const onTurnEnd = (sessionId) => {
        const existing = settling.get(sessionId)
        if (existing !== undefined) clearTimeout(existing)
        settling.set(
          sessionId,
          setTimeout(() => {
            settling.delete(sessionId)
            const value = latestStatus.value?.get?.(sessionId)
            if (value?.running === true) return
            alert('turn-end', sessionId, undefined)
          }, SETTLE_MS),
        )
      }

      // ---- source one: the application's own status map ----
      const uiSession = serviceOf(ctx, 'uiSession')
      const sessionStatus = uiSession?.sessionStatus
      if (sessionStatus !== undefined && typeof sessionStatus.subscribe === 'function' && typeof sessionStatus.getSnapshot === 'function') {
        const previous = new Map()
        const sync = () => {
          let snapshot
          try {
            snapshot = sessionStatus.getSnapshot()
          } catch (error) {
            console.warn(`${NS}: session status read failed`, error)
            return
          }
          latestStatus.value = snapshot
          const entries = snapshot instanceof Map ? snapshot : new Map()
          const seen = new Set()
          for (const [id, value] of entries) {
            seen.add(id)
            const was = previous.get(id)
            const pending = value?.pendingInteraction ?? undefined
            // A first sighting is not a transition: at boot the application
            // marks every historically idle session `completionUnread`, and
            // treating that as news would fire an alert per old session.
            if (was !== undefined) {
              if (was.running === true && value?.running !== true) onTurnEnd(id)
              if (pending !== undefined && was.pending === undefined) {
                const kind = String(pending?.kind ?? 'question')
                alert(kind === 'approval' ? 'approval' : kind === 'plan-review' ? 'plan' : 'question', id, pending)
              }
            }
            previous.set(id, { running: value?.running, pending })
          }
          for (const id of [...previous.keys()]) if (!seen.has(id)) previous.delete(id)
        }
        ctx.effect(() => {
          const dispose = sessionStatus.subscribe(sync)
          sync()
          return typeof dispose === 'function' ? dispose : undefined
        }, `${NS}: session status`)
      } else {
        console.warn(`${NS}: ctx.uiSession.sessionStatus is unavailable; alerts will be quiet`)
      }

      // ---- source two: the forwarded events, best effort ----
      //
      // These are waterfalls, and the shipped UI listener registers first and
      // returns the user's answer without calling `next()` — so in the desktop
      // app these listeners may never run. They are subscribed anyway because
      // they cost nothing and they carry the request payload verbatim when they
      // do fire; nothing above depends on them.
      const remote = serviceOf(ctx, 'remote')
      if (remote !== undefined && typeof remote.$on === 'function') {
        ctx.effect(() => {
          remote.$on('user-questions/request', function (request, next) {
            try {
              const questions = Array.isArray(request?.questions) ? request.questions : []
              const sessionId = sessionForTarget(ctx, this)
              if (sessionId !== undefined) alert('question', sessionId, { kind: 'question', questions })
            } catch (error) {
              console.warn(`${NS}: question listener threw`, error)
            }
            return next()
          })
        }, `${NS}: user-questions/request`)

        ctx.effect(() => {
          remote.$on('approval/request', function (request, next) {
            try {
              const sessionId = sessionForTarget(ctx, this)
              if (sessionId !== undefined) alert('approval', sessionId, { kind: 'approval', toolName: request?.toolName })
            } catch (error) {
              console.warn(`${NS}: approval listener threw`, error)
            }
            return next()
          })
        }, `${NS}: approval/request`)
      }

      // ---- teardown for the pending turn-end timers ----
      ctx.effect(
        () => () => {
          for (const timer of settling.values()) clearTimeout(timer)
          settling.clear()
          for (const audio of players.values()) {
            try {
              audio.pause()
            } catch {
              /* a detached element cannot pause; nothing to restore */
            }
          }
          players.clear()
          for (const banner of live) {
            try {
              banner.close()
            } catch {
              /* already dismissed by the system */
            }
          }
          live.clear()
        },
        `${NS}: timers and players`,
      )

      // ---- the settings page on this plugin's own row ----
      if (form !== undefined) {
        ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register(
            {
              name: 'plugins.row.config',
              key: PANEL_KEY,
              locale: NS,
            },
            (props) => {
              if (props.view === 'summary') return h('span', null, t('summary'))
              return h(SettingsPage, { t, form, audioFor, systemNotify, testBanner })
            },
          ),
        )
      }
    }

    /**
     * Resolve the session a forwarded waterfall's carrier agent belongs to.
     *
     * `ctx.sessions.scopeOf` is the application's own mapping and is not in the
     * published Service catalog; it is used defensively, because a missing one
     * must silence this best-effort source rather than throw inside a waterfall
     * the agent is blocked on.
     *
     * @param ctx - Client Cordis context.
     * @param carrier - The waterfall's `this` target, an Agent projection.
     * @returns The session id, or `undefined`.
     */
    function sessionForTarget(ctx, carrier) {
      try {
        return ctx.sessions?.scopeOf?.(carrier)
      } catch {
        return undefined
      }
    }

    return {
      apply,
      // `slots` and `locale` are hard dependencies: without them there is no
      // page and no copy. Every other service is optional and resolved through
      // `ctx.get`, so a composition without one degrades instead of failing.
      inject: ['slots', 'locale'],
    }
  },
})
