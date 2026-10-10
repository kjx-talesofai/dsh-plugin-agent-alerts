# Agent Alerts

A desktop notification and a sound the moment the agent **finishes a turn**, **asks you a question**, or **needs your approval** — so you can go and do something else instead of watching the window.

Ships with two bundled sounds and accepts your own.

<!-- The plugin is client-side. A browser half raises the notification and plays the
     sound; a Host half serves the bytes and owns the settings. -->

## Install

```sh
dsh plugin install github:kjx-talesofai/dsh-plugin-agent-alerts#v0.3.0
```

Or, from the app: **Settings → Plugins → Add**, then paste the same spec.

## What it alerts on

| Moment | Bundled sound | Notification |
| --- | --- | --- |
| A turn finished | `duo_finish.mp3` | The session's title |
| The agent asked you a question | `duo_question.mp3` | The question text |
| A tool needs your approval | `duo_question.mp3` | The tool that is asking |
| A plan is waiting for your review | `duo_question.mp3` | The plan prompt |

Click a notification to bring the window forward and open the session it was about.

Three things it deliberately does **not** do:

- **It does not announce a child agent's turn.** A workflow can finish dozens of subagent runs in a minute; announcing each one teaches you to ignore the alert. Questions and approvals from a child still ring, because those are still your decision.
- **It does not replay history when the page loads.** The app marks every historically idle session as unread while its list loads; treating that as news would fire one alert per old session on every launch.
- **It does not announce a turn that immediately resumes.** A goal round closes its turn and opens the next one a moment later, so a finished turn is held for 1.5 seconds and dropped if the session is running again.

## Settings

**Settings → Plugins → Agent Alerts → the row's configure control.** Every switch applies immediately; nothing needs a restart.

| Setting | Default | Notes |
| --- | --- | --- |
| A turn finished | on | |
| The agent asked a question | on | Also covers a plan waiting for review. |
| A tool needs approval | on | |
| Play a sound | on | |
| How to notify | App banner | `Off`, `App banner`, or `System fallback` — see below |
| Skip the banner while the window is focused | **off** | The sound plays either way. |
| Volume | 80% | |
| Sound for a finished turn | empty | An absolute path. Empty uses the bundled sound. |
| Sound for a question or approval | empty | An absolute path. Empty uses the bundled sound. |

**How to notify** is a choice of three rather than a switch, because the two transports can differ in whether they work at all:

- **App banner** *(default)* — a notification raised by the page. It carries the Harness name and icon, and clicking it opens the session it was about.
- **System fallback** — the Host asks macOS to notify on the app's behalf. The banner is attributed to **Script Editor**, and clicking it does nothing, but it goes out through an identity macOS has already registered, so it works when the app's own permission never landed.
- **Off** — no notification; the sound still plays.

There is a **Send a test** button beside it, and it reports what it saw rather than a yes or no:

```
onshow ✓ —— the renderer believes it displayed. If nothing is on screen, the system dropped it.
2.5 秒内既没有 onshow 也没有 onerror —— it was never handed to the system.
已交给系统（HTTP 200）—— the Host accepted it.
被拒绝：HTTP 401 —— the Host refused.
```

That distinction is the whole reason the readout exists: `onshow` fires whether or not the banner was displayed, so a bare "sent ✓" would be exactly the false confidence this took three rounds to see through.

The path fields show what the Host actually found on disk — *"Using the bundled sound"*, *"Your file, 57 KB"*, or *"Cannot read it: ENOENT"* — so a typo is visible rather than silent. **Preview** plays the sound that will be used.

Settings live in your profile's `cordis.patch.yml`, beside every other Harness preference, and can also be edited there:

```yaml
- id: agent-alerts
  name: dsh-plugin-agent-alerts
  config:
    turnEndSound: /Users/you/Sounds/done.mp3
    quietWhenFocused: false
```

## Requirements and honest limits

- **The app has to be running.** Both halves are parts of the Harness process, so there is nothing to alert you once it has quit. This is not a background daemon.
- **The app banner needs permission from macOS. Check it first:** **System Settings → Notifications → DeepSeek Harness**. If notifications are switched off there, the page cannot tell — the renderer's `Notification.permission` reports `granted` because that is Electron's own gate, not macOS's, and the page will construct notifications forever while none is displayed. If you cannot make banners appear, switch **How to notify** to the system fallback.
- **Focus modes suppress banners**, not sounds.
- **Untested on Windows and Linux.** The notification and audio code is standard web API and the bundled sounds are served the same way on every platform, but only macOS has been exercised.

## How it works

The Harness Host runs as an Electron **child process**, where `Notification` does not exist — so only the page can raise a notification or play a sound. The Host half exists for the two things the page cannot do:

- **Read a sound off disk.** The page has no filesystem. The Host resolves the configured path — never a path from the request — and serves the bytes over `/api/agent-alerts/sound`, gated by the same admission fence as every other Host route.
- **Notify on the app's behalf**, when the banner path is blocked. `/api/agent-alerts/notify` runs one fixed AppleScript through `/usr/bin/osascript`, passing the title and body as `argv` rather than interpolating them into the script — a session title must not be able to become executable.
- **Own the settings.** `Config` is the plugin's schema; `dsh-settings` derives its namespace from this row's loader id, so the page reads and writes the same values through `ctx.configForms`.

The browser half gets its three moments from **`ctx.uiSession.sessionStatus`** — the very `{ running, pendingInteraction, completionUnread }` map the app's own unread badges are computed from. One subscription covers all three, and it sits outside every waterfall chain, so no earlier listener can short-circuit it. The forwarded `user-questions/request` and `approval/request` events are subscribed as well, purely as a best-effort second source.

## Development

```sh
npm test
```

No install step: the suite evaluates the browser half as a script and runs the Host half's body with its imports stubbed, so it never resolves the one dependency the package declares.

### Installing a working copy

```sh
dsh plugin install link:$(pwd)
```

A `link:` install keeps the package outside the profile, so the Host half's one dependency has to be reachable **through the plugin directory** or the entry fails to import with `Cannot find package '@deepseek-ai/schemastery'`:

```sh
mkdir -p node_modules/@deepseek-ai
ln -sfn ~/.dsh/profiles/desktop/node_modules/@deepseek-ai/schemastery node_modules/@deepseek-ai/schemastery
ln -sfn ~/.dsh/profiles/desktop/node_modules/@deepseek-ai/cosmokit     node_modules/@deepseek-ai/cosmokit
```

A registry install (`github:…#v0.3.0`) needs none of this: pnpm installs the dependency into the profile and Node walks up to it from there.

```
index.js       Host half: the settings schema, the sound route, the status route,
               and the system-notification fallback
client.js      browser half: the triggers, the notification, the settings page
cordis.patch.yml  the one loader row that mounts the package
assets/        the two bundled sounds and the icon
probe/         the throwaway Phase 0 diagnostic (never shipped)
docs/plan.md   what was measured, and which assumptions turned out to be wrong
```

## Licence

MIT.
