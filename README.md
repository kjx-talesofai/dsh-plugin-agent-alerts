<p align="center">
  <img src="assets/icon.svg" alt="dsh-plugin-agent-alerts" height="112"/>
</p>

# dsh-plugin-agent-alerts

A desktop notification and a sound the moment the agent **finishes a turn**, **asks you a question**, or **needs your approval** — so you can go and do something else instead of watching the window.

<p align="center">
  <a href="https://github.com/kjx-talesofai/dsh-plugin-agent-alerts/releases"><img src="https://img.shields.io/github/v/release/kjx-talesofai/dsh-plugin-agent-alerts?label=release&style=flat-square&color=blue" alt="release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/kjx-talesofai/dsh-plugin-agent-alerts?label=license&style=flat-square&color=green" alt="license"></a>
  <a href="https://github.com/kjx-talesofai/dsh-plugin-agent-alerts/actions/workflows/ci.yml"><img src="https://github.com/kjx-talesofai/dsh-plugin-agent-alerts/actions/workflows/ci.yml/badge.svg?branch=main&event=push" alt="CI"></a>
  <img src="https://img.shields.io/badge/DSH-%E2%89%A5%200.2.0--rc.1-blueviolet?style=flat-square" alt="DSH >= 0.2.0-rc.1">
</p>

> dsh-plugin-agent-alerts — agent 回复完、向你提问、或需要你批准工具时，弹出桌面通知并播放提示音

<details>
<summary><b>中文说明（点开）</b> —— 你不用一直盯着窗口，它响了再回来</summary>

**它是什么**：给 DSH 加上**提示音 + macOS 桌面通知**。三种时刻会响：agent 把一轮做完了、agent 向你提问、工具在等你批准。

**为什么做**：agent 跑一个 turn 可能要几分钟，这期间正确的做法是去干别的 —— 但"去干别的"需要一个信号把你叫回来，DSH 本身没有。

**自带两段哆啦A梦音效**，也可以换成你自己的文件（设置里填绝对路径，页面上会显示它有没有读到）。

**通知有两种通道**，因为可靠性不一样：

| 方式 | 说明 |
|---|---|
| **应用横幅**（默认） | Harness 自己的名字和图标，**点一下会跳到那个会话** |
| **系统兜底** | 让 macOS 代为通知，署名是「脚本编辑器」，点了没反应 —— 横幅一直不出来时用它 |

**三件它故意不做的事**：

- **子 agent 的 turn 结束不响。** 一次 workflow 一分钟能结束几十个子运行，每个都响就是在训练你忽略它。但**子 agent 提问或要审批照常响** —— 那仍然是你的决定。
- **页面刚加载不补报历史。** app 在会话列表加载时会把所有历史空闲会话标成"未读"，把它们当新闻就会每次开 app 响几十下。
- **刚结束又立刻继续的 turn 不响。** goal 的下一轮紧接着上一轮，先说"做完了"是在骗人，所以会等 1.5 秒复查。

**注意事项**：

- **app 必须开着。** 两半都跑在 Harness 进程里，退出就没有任何东西能提醒你 —— 这不是常驻后台服务。
- **通知需要 macOS 允许。** 如果横幅不出现，先去 **系统设置 → 通知 → DeepSeek Harness** 看两处：最上面的开关，和下面的**提醒样式**（不能是「无」）。
- **专注模式会压掉横幅**，压不掉声音（声音是插件自己播的）。
- **只在 macOS 上端到端跑过。** Windows / Linux 未测。

**怎么装**（DSH「添加插件」里填，不需要 npm 账号）：

`github:kjx-talesofai/dsh-plugin-agent-alerts#v0.3.3`

装完**重启桌面端**（host 半边只在启动时加载）。

**卸载**：DSH「插件」列表里卸载 → 重启。它只在自己的 `config` 块里留了一份设置，没有别的痕迹。

</details>

## Why

An agent turn takes minutes. The rational thing to do is leave — and the whole point of leaving is that you need a signal to come back. DSH does not have one.

Two cues rather than one, because they fail differently: the **sound** reaches you when the window is behind three others, and the **banner** tells you *which* session and opens it on click.

## What it alerts on

| Moment | Sound | Notification |
|---|---|---|
| A turn finished | `duo_finish.mp3` | The session's title |
| The agent asked you a question | `duo_question.mp3` | The question text |
| A tool needs your approval | `duo_question.mp3` | The tool that is asking |
| A plan is waiting for review | `duo_question.mp3` | The plan prompt |

Click a banner to bring the window forward and open the session it was about. The settings page states whether that click is wired, so a silent failure is visible rather than invisible. The **system fallback is not clickable** — `display notification` carries no action — which is part of why it is opt-in.

Three things it deliberately does **not** do:

- **It does not announce a child agent's turn.** A workflow can finish dozens of subagent runs in a minute; announcing each one teaches you to ignore the alert. Questions and approvals from a child still ring, because those are still your decision.
- **It does not replay history when the page loads.** The app marks every historically idle session as unread while its list loads; treating that as news would fire one alert per old session on every launch.
- **It does not announce a turn that immediately resumes.** A goal round closes its turn and opens the next one a moment later, so a finished turn is held for 1.5 seconds and dropped if the session is running again — or if the reason it closed is that the agent is waiting on you.

## Install

Use DSH's own **Add plugin** dialog. No npm account, no publishing.

| Field | Value |
|---|---|
| GitHub | `github:kjx-talesofai/dsh-plugin-agent-alerts#v0.3.3` |
| Local directory | an absolute path, e.g. `/path/to/dsh-plugin-agent-alerts` |

Restart the desktop app afterwards: the Host half is only loaded at startup. The browser half reloads with the page.

> If **Add plugin** reports `connection to github.com timed out after 5000ms`, that is the manager's own connectivity preflight (a 5-second `git` check) rather than the download — the same tarball fetches in under a second, and a plain `https://codeload.github.com/...` GET succeeds while `git ls-remote` over HTTPS hangs. Retry it, or install the same spec with `pnpm add` in your profile directory.

This plugin is **not published to npm**, and `npm install` is not the install path.

## Settings

**Settings → Plugins → Agent Alerts → the row's configure control.** Every switch applies immediately; nothing needs a restart.

| Setting | Default | Notes |
|---|---|---|
| A turn finished | on | |
| The agent asked a question | on | Also covers a plan waiting for review. |
| A tool needs approval | on | |
| Play a sound | on | |
| How to notify | App banner | `Off`, `App banner`, or `System fallback` |
| Skip the banner while the window is focused | **off** | The sound plays either way. |
| Volume | 80% | |
| Sound for a finished turn | empty | An absolute path. Empty uses the bundled sound. |
| Sound for a question or approval | empty | An absolute path. Empty uses the bundled sound. |

A **Send a test** button beside the notification setting raises one immediately, so finding the transport that works on your machine is a ten-second experiment rather than a guess.

Settings live in your profile's `cordis.patch.yml`, beside every other Harness preference, and can also be edited there:

```yaml
- id: agent-alerts
  name: dsh-plugin-agent-alerts
  config:
    turnEndSound: /Users/you/Sounds/done.mp3
    quietWhenFocused: false
```

## What it does not reach

- **No sound packs and no file picker.** A custom sound is an absolute path you type.
- **Nothing survives the app quitting.** No daemon, no background process.
- **No per-session or per-workspace rules.** The switches are global.
- **The system fallback is macOS-only.** On other platforms the route answers `501` rather than going quiet.

## Compatibility

Verified against **DSH 0.2.0-rc.2** on macOS (Apple Silicon), in a real profile — every mechanism below was measured against a running app before it was depended on, and [`docs/plan.md`](docs/plan.md) records what that measurement got wrong.

| Contract | Where it comes from |
|---|---|
| `ctx.uiSession.sessionStatus` — one observable map of `{ running, pendingInteraction, completionUnread }` | `dsh-client-ui-session` |
| `ctx.configForms`, and the `plugins.row.config` seat keyed `<package>#<rowId>` | `dsh-client-ui-settings`, `dsh-client-ui-plugin-manager` |
| A `webServer` route reachable from the `dsh-app://app` page, behind `connection.admit` | `dsh-host-webserver`, `dsh-api-remotes` |
| `ctx.remote.$on('user-questions/request')` as a waterfall | `dsh-api-gateway` |

The notification path is the fragile one, because the page cannot observe whether the operating system displayed anything: `Notification.permission` reports `granted` from Electron's own gate, not macOS's. That is why there are two transports and a test button.

## Development

```sh
npm test          # 34 tests, no install step required
```

There is deliberately **no build step**: `client.js` is the shipped browser bundle, and the Host half is a single `index.js`.

The suite evaluates the browser half as a script in `node:vm`, drives the real components through a small hooks runtime, and runs the Host half's own body with its imports stubbed — so it never resolves the one dependency the package declares and a bare checkout is enough.

| Path | Ships to users | Purpose |
|---|---|---|
| `client.js` | ✓ | The browser half — the triggers, the sound, the notification, the settings page |
| `index.js` | ✓ | The Host half — the `Config` schema, the sound route, the system-notification fallback |
| `cordis.patch.yml` | ✓ | The bundle row that mounts the package |
| `locale/*.json` | ✓ | Plugin-manager display metadata (en / zh) |
| `assets/` | ✓ | The two bundled sounds and the icon |
| `tests/plugin.test.mjs` | ✗ | Behaviour suite |
| `docs/plan.md` | ✗ | The design record: what was verified, and what was got wrong |
| `probe/` | ✗ | The Phase 0 diagnostic that established the mechanisms above |

A `link:` install needs one step a registry install does not: the package stays outside the profile, so the Host half's dependency must be reachable **through the plugin directory** or the entry fails to import with `Cannot find package '@deepseek-ai/schemastery'`. Symlink it into `node_modules/`; `docs/plan.md` says exactly which two.

## Uninstall

Remove `dsh-plugin-agent-alerts` from DSH's plugin list and restart. It writes no browser storage and no profile state beyond its own optional `config` block.

## License

[MIT](LICENSE) © 2026 Jiaxin Kou

---

<p align="center">
  <sub>Built by <a href="https://hypersampling.com">hypersampling</a> · <a href="https://github.com/kjx-talesofai">GitHub</a></sub>
</p>
