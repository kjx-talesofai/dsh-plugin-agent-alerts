# Agent Alerts — what was measured, and what it changed

This plugin is small. Almost everything worth writing down is about **how the
mechanisms were established**, because the interesting failures here were not
typos — they were plausible designs that turned out to be wrong, one of which
would have fired 22 notifications on every launch.

Everything below was measured on a real desktop profile (DSH `0.2.0-rc.2`,
Electron 44, macOS), through a throwaway probe plugin that is kept in `probe/`
and never shipped.

---

## 1. The questions, and their answers

| # | Question | Answer |
| --- | --- | --- |
| R1 | Does `new Notification()` raise a macOS banner? | **Open** — see §4 |
| R2 | Is a profile-installed bundle's `ctx.webServer` route reachable from the page? | **Yes.** `200 · admitted=true cookie=true`, and the media loader reached `readyState=4` |
| R3 | Does `<audio>` play with no user gesture? | **Yes.** `play()` resolved with no `NotAllowedError` |
| R4 | Does `ctx.remote.$on('user-questions/request')` fire for an external plugin? | **Probably not**, and nothing depends on it — see §3 |
| R5 | Does `ctx.configForms.get(rowId)` resolve? | **Yes**, and the Host serves 23 settings namespaces |
| R6 | Does `sessions.list` expose a usable running transition? | **Yes** (`ids` populated, `phase=ready`) |
| R7 | Is `ctx.uiSession.sessionStatus` readable? | **Yes** (one entry per session, incl. subagent runs) |

### R2 in full

The page's origin is the custom scheme `dsh-app://app`. Everything that is not a
static document path is forwarded to the Host's own HTTP server **together with
the Host cookie** (`lib/main.js`: `forwardWebRequest(request, hostUrl,
hostCookie)`), so a same-origin `fetch('/api/...')` lands on the Host.

Two things under it were worth checking separately, and the probe checked both:

- the route has to pass the same `connection.admit` fence as every other Host
  route, and
- `<audio src>` is **not the same request path** as `fetch` — the media loader
  may or may not carry the cookie.

Round 1 reported `route.ping → 200 admitted=true cookie=true` and
`media.gated.finish → readyState=4 duration=4.3s`. Both halves were therefore
real, which is what makes it safe to serve the sounds over a route instead of
embedding ~200 KB of base64 in the browser bundle.

---

## 2. The finding that changed the design: `completionUnread` floods at boot

The first probe round produced this log, and it was not noise:

```
02:35:42  unread ×22
```

`dsh-client-ui-session` marks **every historically idle session**
`completionUnread` while its session list loads, because `observeRunning` treats
"idle, and the baseline is not ready yet" as a completion. Twenty-two sessions in
a store of well over a thousand sessions.

The obvious design — "alert on `completionUnread`" — would therefore have fired
twenty-two desktop notifications on every single launch. The signal is unusable
as a trigger, and the plugin instead diffs `running` between two snapshots **it
has both seen**, so a first sighting is never a transition. A question that was
already pending when the page loaded is likewise not news.

---

## 3. The mechanism that looks right and probably never runs

`ctx.remote.$on('user-questions/request', …)` is attractive: the event is in
`API_REMOTE_FORWARDED_EVENTS`, it carries the question text verbatim, and the
shipped UI itself subscribes to it. The probe subscribed too, with a `next()`
call wrapped in `try`/`catch`.

It may never fire. The event is forwarded as a **waterfall**, and the shipped
listener for it (`dsh-client-ui-user-questions`) registers first and returns the
user's answer **without calling `next()`** — which ends the chain before a
late-registering plugin is reached. Subscribing anyway costs nothing and is
correct when it does run, but the plugin's triggers come from
`ctx.uiSession.sessionStatus`, which is a plain observable and sits in no chain
at all.

This is why the browser half subscribes to **both** and lets a suppression window
collapse the duplicate, rather than betting on either one.

---

## 4. The banner that never came, and the two reasons it did not

**Symptom.** A turn ends while the user is in another application. The sound
plays. No banner appears.

Rounds 1 and 2 eliminated most of the field: not a collected reference (an arm
that held one behaved identically), not macOS coalescing (an arm with a distinct
body did too), not a broken signature (`codesign --verify --strict` passes, so
Electron 42's "unsigned binaries emit `failed`" does not apply), and not
something the page could see (`onshow` fired on every attempt in every arm).

There were **two** causes, stacked, and each hid the other.

**Cause one, in the operating system.** Notifications for the Harness app were
switched off in System Settings. Nothing in the page can see that: the renderer's
`Notification.permission` reports `granted` because that is *Electron's*
permission gate, not macOS's, so a page constructs notifications happily while
the system drops every one. The user turned it on.

**Cause two, in this plugin.** `quietWhenFocused` defaulted to **true**, and it
skips the banner while the Harness window is focused — which is exactly the
condition under which anyone tests the feature. So after cause one was fixed,
the plugin still produced nothing, and nothing on screen said why. The setting is
now default-off, and a test pins that default.

The ground truth that settled it was the macOS **Notification Center**: sixteen
probe notifications were sitting in it, delivered long before the code had
changed. "Delivered" and "shown as a banner" are different events, and the page
can observe neither.

### Two lessons, both about evidence

`defaults read` and `plutil -p` were both consulted about `com.apple.ncprefs`,
agreed with each other, and were both wrong — they read a preferences file the
notification daemon had not flushed. **Two views of the same cache are one piece
of evidence, not two.** This repository had already recorded the same failure
once, in a different costume: an upstream document's wording is not evidence
either. The nearest thing to a line of code was the user's own System Settings
window, and no amount of binary archaeology substituted for asking what it said.

And a quieter one, which cost more: **a default that suppresses output makes the
feature untestable, and an untestable feature reads as a broken one.** The
reasoning behind quiet-when-focused was sound — do not notify about what is
already on screen — and it is still available. It just should not have been the
default, because the first thing anyone does is watch it work.

### What that produced

Two transports, because the two causes need different answers. The banner stays
the default: it carries the Harness name and icon and its click opens the
session. The **system fallback** asks the Host to have macOS notify through an
identity it has already registered, for the case where the app's own permission
never lands; its banner is attributed to Script Editor and is not clickable,
which is why it is opt-in. The settings page carries a **Send a test** button
that reports *which callback arrived* — `onshow`, `onerror`, or nothing within
2.5 seconds — because `onshow` fires whether or not a banner was displayed, and a
bare "sent ✓" would be exactly the false confidence this took three rounds to see
through.

## 4b. The fallback's one sharp edge, verified by hand

`/api/agent-alerts/notify` puts session titles and question text into an
AppleScript `display notification`. Interpolating them into the script source
would make a session title executable, so the script is a fixed string that reads
`argv` instead. That claim was checked rather than asserted:

```
$ osascript -e 'on run argv … end run' \
    'He said "hi" \ and
     do shell script "echo pwned"' \
    'body with "quotes" and \ backslash'
exit=0          # and /tmp/pwned was never created

$ osascript -e "display notification \"x\" with title \"He said \"hi\"\""
syntax error: A identifier can't go after this "". (-2740)     # the unsafe form
```

The second command is the same text through string interpolation. It does not
run anything either — it fails to parse — but it shows what the argv form is
avoiding, and a title that happens to be *valid* AppleScript would not be so
lucky.

## 4c. Why the click did nothing: `ctx.<service>` is gated by `inject`

Reported from use, not from reading: clicking a banner brought the window forward
and stopped there. The load-bearing line was

```js
ctx.uiWorkspace?.openSession(sessionId)      // inside try { } catch { console.warn }
```

and the reason it was a no-op is in the client runtime, not in this plugin. The
context a dynamic Client half receives is a whitelisting proxy
(`dsh-cordis-client-runner/lib/client.js`, `dynamicCordisContext`):

```js
const declared = new Set(Object.keys(ctx.fiber.inject));
if (prop === "get") return (name) => readService(name, false);   // ungated
…
if (requireDeclaration && !declared.has(name)) return denyRead(name);   // throws
```

So `ctx.get(name)` is optional lookup for anyone, while `ctx.<name>` **throws**
unless the plugin declared that service in `inject`. This plugin declares
`['slots', 'locale']`, so `ctx.uiWorkspace` threw on every click, and the plugin's
own `catch` turned the runtime's rejection into a `console.warn` that nobody reads.
The behaviour from the outside — window forward, no navigation — was exactly a
missing feature, and looked like one.

**There was a second site, and it was worse.** `sessionForTarget` read
`ctx.sessions?.scopeOf?.(carrier)` for the forwarded-event source. Same gate, same
`catch`; that source had been dead on arrival rather than merely unreliable, and
the doc comment above it blamed something else ("may never run" because the shipped
UI listener answers first). Both now resolve through `serviceOf(ctx, name)`, which
is this plugin's own `ctx.get` policy, at call time rather than at mount, so a late
arriving service is still found.

**Why the suite did not catch it, which is the part worth remembering.** The test
stub exposed *every* service as a property as well as through `ctx.get` — strictly
more permissive than the runtime. A plugin that reached for `ctx.someService`
therefore failed in the app and passed here. The stub is now the same shape as the
runtime: the service table is reachable only through `ctx.get`, `ctx.<name>` throws
for anything the plugin did not `inject`, and the allowed list is read off the
plugin's own declaration. Reverting either call site now fails the suite; before,
both passed.

One silence remained after that fix, and a mutation found it: the forwarded-event
test published the status map *as well*, so it could not tell "the waterfall fired"
from "the waterfall was silent and the map did the work". There is now a test with
one source only.

**Where the click can still do nothing:** the *system fallback* transport
(`osascript display notification`) carries no action at all, so its banner is not
clickable in any implementation. That is a property of `display notification`, not
a bug here; the settings page now states whether the app-banner click is wired, so
the next failure of this kind is visible on the surface the user already looks at
rather than in a console.

Both halves were then re-scanned for the same class: the Client half's remaining
`ctx.<name>` reads are `slots` and `locale` (injected) plus `ctx.get` calls, and the
Host half's are `webServer` and `connection` (injected) plus `ctx.effect`.

## 4d. Installing the fix: the manager's preflight is stricter than the download

Shipping v0.3.3 hit an obstacle worth recording, because it will hit the next
GitHub install on this machine too. `plugin_manager install_bundle` for
`github:kjx-talesofai/dsh-plugin-agent-alerts#v0.3.3` failed twice, both times at
`stage: install`, `failedAt: spec-host`, with

```
dsh: connection to github.com timed out after 5000ms
```

and `changed: false`, so nothing was installed or removed. Measured on the same
machine a minute later:

| probe | result |
|---|---|
| `curl -L https://codeload.github.com/…/tar.gz/refs/tags/v0.3.3` | **HTTP 200, 150 KB, 0.9 s** |
| `git ls-remote https://github.com/kjx-talesofai/dsh-plugin-agent-alerts --tags` | no output, still running at 6 s |

So the preflight runs `git` over HTTPS with a 5-second budget, and `git`-over-HTTPS
is the one path that does not work here (SSH does; `git push` is instant, which is
how the tag reached GitHub). The download itself is fine. Two consequences:

- The installer cannot be driven from this machine while that is true; retrying is
  the only lever inside the tool, and it failed twice.
- The fix therefore reached the app **by replacing the installed copy's files**,
  which works because the browser half is read from disk on every page load while
  the Host half is unchanged between v0.3.2 and v0.3.3 — and it is what the user
  then verified by clicking a notification. The profile's *declared* spec and
  `pnpm-lock.yaml` still name v0.3.2, so a future `pnpm install` would silently
  revert the click fix; that is the loose end to close at the next convenient
  restart, not a defect in the plugin.

## 5. Things confirmed by reading code, and left alone

- `updatedAt` on a session row is the last **user** prompt, not the last
  activity. Agent replies do not advance it — which is exactly why this plugin
  cannot be built from list recency and needs a live status source.
- Only `.volatile()` Config fields are exposed to the page and accepted on write.
  Without it the namespace does not appear at all.
- The plugin-manager keys `plugins.row.config` by `<package name>#<row id>`, and
  **a row grows a configure control only while an entry names it** — there is no
  default form renderer, so the settings page is this plugin's own component.
- Installing a bundle writes an enable record into `cordis.patch.yml` (or the
  profile's `package.json` bundle list); removing the bundle does not always roll
  it back. Check after uninstalling.

---

## 6. Anything that would make this obsolete

- **A Host-side notification service.** The Host is a child process and cannot
  raise one *natively*; if DSH ever exposes a notification service, both
  transports here should be replaced by it, and §4 stops mattering.
- **A way to observe whether macOS actually displayed a banner.** Every
  workaround in §4 exists because `onshow` is not that signal. If Electron ever
  surfaces the underlying `failed` event to the renderer, the fallback becomes
  unnecessary and the choice can collapse back into a switch.
- **A `pendingInteraction` change event that fires for a replaced interaction.**
  The plugin treats "one pending interaction replaced by another" as not news.
  If the app ever wants that announced, this is the line to revisit.
