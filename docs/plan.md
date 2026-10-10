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

## 4. The open question: notification banners, and the fallback it forced

Rounds 1 and 2 established what it is *not*:

- **Not a collected reference.** An arm that held the reference behaved the same
  as one that did not.
- **Not macOS coalescing.** An arm whose body changed on every attempt behaved
  the same as one that repeated identical content.
- **Not a broken signature.** `codesign --verify --strict` passes; the app is
  signed with a Developer ID and satisfies its Designated Requirement. The
  documented Electron 42+ trap ("unsigned binaries emit `failed`") therefore does
  not apply.
- **Not an error the page can see.** Every attempt in every arm fired `onshow`.

The remaining clue looked decisive and was not: `com.deepseek.dsh` is **absent
from the read of `com.apple.ncprefs`** while 130 other applications are listed,
which reads as "never registered". Round 3 was therefore built to isolate
`silent: true` (held constant across every failing attempt) and foreground
suppression by raising notifications on a five-second delay.

**The actual cause was simpler and documented nowhere in that data:** the
Harness app was present in **System Settings → Notifications** the whole time,
with notifications **switched off**. Turning them on is the fix.

### The lesson is about the evidence, not the bug

`defaults read` and `plutil -p` were both consulted, agreed with each other, and
were both wrong — they read a preferences file that the notification daemon had
not flushed. Two views of the same cache are one piece of evidence, not two.

This is the same failure this repository already recorded once: an upstream
document's wording is not evidence, and neither is a cached preference read. The
line of code next to it is. Here, the nearest thing to a line of code was the
*user's own System Settings window*, and no amount of binary archaeology
substituted for asking what it said.

What is certain is the shape of the trap: the renderer's `Notification.permission`
reports `granted` because that is **Electron's** permission gate, not macOS's, so
a page can construct notifications indefinitely while the operating system has
never granted anything. Nothing in the page can tell the difference between "the
banner was shown" and "the banner was dropped", because `onshow` fires either
way.

That is why the plugin ships **two transports**. The banner is the honest one and
stays the default; the system fallback asks the Host to have macOS notify through
an identity it has already registered — `com.apple.ScriptEditor2` is present in
`com.apple.ncprefs` on the machine this was built on, while `com.deepseek.dsh` is
not present at all. The fallback is opt-in because its banner is attributed to
Script Editor and is not clickable.

The sound is unaffected either way: R3 settled it independently.

---

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
