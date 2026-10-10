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
| R6 | Does `sessions.list` expose a usable running transition? | **Yes** (`ids=1537 phase=ready`) |
| R7 | Is `ctx.uiSession.sessionStatus` readable? | **Yes** (`entries=1537`) |

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
a 1537-session store.

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
