# The Webview Embed Model

How VS Code, the extension's webview wrapper, and the mardoc.app iframe
actually interact. Every embed-mode feature must be designed against this
model. It exists because features designed against intuition (especially
keyboard shortcuts) have repeatedly failed in ways that only surfaced in
manual testing.

## The three worlds

```
┌─ VS Code workbench (extension host) ──────────────────────────────┐
│  Commands, keybindings, menus, file system, git.                  │
│                                                                   │
│  ┌─ Webview wrapper (getWebviewHtml in extension.ts) ──────────┐  │
│  │  A thin HTML page with acquireVsCodeApi(). Relays messages  │  │
│  │  between the two neighbors — BY WHITELIST, both directions. │  │
│  │                                                              │  │
│  │  ┌─ Cross-origin iframe: https://mardoc.app ─────────────┐  │  │
│  │  │  The deployed web app. Sees its own DOM events only.  │  │  │
│  │  └────────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

Two boundaries. Everything that goes wrong in embed mode goes wrong at a
boundary.

## Rules that follow from the model

### 1. Keystrokes are never the primary trigger

When focus is inside the cross-origin iframe:

- Keydown events are visible **only** to the iframe's document. They do
  not bubble to the wrapper, and VS Code's keybinding service never sees
  them — contributed keybindings (`when: activeWebviewPanelId ==
  'mardoc'`) fire only when focus is on the panel but *outside* the
  iframe, which is rare.
- Some chords never reach the iframe at all: Electron and the workbench
  consume reserved combinations upstream, and *which* ones varies by
  platform and VS Code version. An iframe-side key handler is therefore
  best-effort by construction.

**Rule:** every embed feature gets a click path that involves no key
capture — an `editor/title` menu icon (pure VS Code, always works)
and/or a visible button in the app UI. A keystroke may be layered on
top as a convenience. This is also what shipped tools do: VS Code's
built-in Markdown Preview and Microsoft's Live Preview use auto-refresh
plus a title-bar icon; neither gates behavior on a chord.

### 2. Content that follows a file follows it automatically

Prior art (Markdown Preview, Live Preview): a preview of a file updates
when the file changes. The user never asks. MarDoc's equivalent: the
extension watches the open file and pushes `file:content` with
`reason: "watch"`; the app auto-applies unless the editor has unsaved
edits (it never clobbers work in progress). Explicit reloads carry
`reason: "request"` and pass the discard-changes guard before the
request is even posted.

### 3. The wrapper forwards by whitelist — new message types must be added twice

`getWebviewHtml` relays messages in both directions through explicit
`msg.type` lists. A new message type that isn't added to the correct
list is **silently dropped** — no error, no log, feature just doesn't
work. When adding a protocol message, update:

- iframe → host list (app-originated messages)
- host → iframe list (extension-originated messages)

### 4. The iframe runs the *deployed* app — version skew is the default

- The iframe loads `https://mardoc.app` (or `mardoc.appUrl`). Extension
  code and app code ship on different cadences; a cross-boundary feature
  does not exist until **both** are live.
- GitHub Pages serves HTML with ~10-minute cache headers, and
  `retainContextWhenHidden` keeps an already-loaded app alive
  indefinitely. An open panel does not pick up a deploy — ever.
- **Rule:** app-side handlers land and deploy first; extension-side
  senders may then ship. Design messages so an unhandled type is a
  harmless no-op on an older peer.
- **Test protocol after a deploy:** close MarDoc panels, wait out the
  Pages cache (or hard-verify with the console logs below), reopen. For
  pre-merge testing, run `npm run dev` in the app repo and set
  `"mardoc.appUrl": "http://localhost:3000"`.

### 5. Every hop logs

The reload pipeline logs with a `[MarDoc reload]` prefix at each
decision point. Where to look:

| Hop | Where the log appears |
|---|---|
| App (iframe): keystroke captured, request posted, content applied/rejected | **Developer: Open Webview Developer Tools** → Console |
| Wrapper: message forwarded | Same webview devtools console |
| Extension: command invoked, watcher fired, content pushed, self-save suppressed | **Help → Toggle Developer Tools** → Console (extension host) |

A failed feature must be traceable to the exact hop where the chain
stopped, from one test cycle. If a new embed feature can fail silently
at a hop with no log, it isn't done.

## Message protocol (current)

| Type | Direction | Meaning |
|---|---|---|
| `ready` | app → ext | App is ready for `init` |
| `init` | ext → app | Repo/branch/token/theme + optional file snapshot |
| `theme:change` | ext → app | VS Code theme flipped |
| `file:save` | app → ext | Write content to disk |
| `file:read-image` / `file:image-data` / `file:image-error` | app ⇄ ext | Local image bytes |
| `file:reload` | app → ext | Re-read the open file, answer with `file:content` |
| `file:content` | ext → app | Fresh disk content; `reason: "watch" \| "request"` |
| `close-panel` | app → ext | Cmd+W bridge |
| `open-external` | app → ext | Open URL in system browser |
