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

## 4. The open question: notification banners

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

What remains is that `com.deepseek.dsh` is **absent from the macOS Notification
Center database** (`com.apple.ncprefs`) while 130 other applications are listed,
which is consistent with the app never having been registered for notifications
at all. Round 3 isolates the two remaining candidates — `silent: true` (held
constant across every failing attempt) and foreground suppression — by raising
notifications on a five-second delay so the window can be left in the background
first.

Whatever it concludes, the plugin ships both cues and the sound is unaffected:
R3 settled it independently.

---

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
  raise one; if DSH ever exposes a notification service, the browser half's
  `Notification` call should be replaced by it, and §4 stops mattering.
- **A `pendingInteraction` change event that fires for a replaced interaction.**
  The plugin treats "one pending interaction replaced by another" as not news.
  If the app ever wants that announced, this is the line to revisit.
