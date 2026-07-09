import * as vscode from 'vscode';
import { getGitContext, getRepoRootForFile } from './git-context';

/**
 * File-backed panels, tracked so reload (keybinding, command palette, or
 * the app's `file:reload` message) knows which file to re-read. Panels
 * opened via plain `mardoc.open` (repo browser, no file) are not tracked
 * — reload is a no-op for them.
 */
const panelFiles = new Map<
  vscode.WebviewPanel,
  { uri: vscode.Uri; relativePath: string; lastSelfSaveAt: number }
>();

/** Watcher events within this window of a MarDoc-initiated save are the
 *  save itself echoing back — not an external change worth pushing. */
const SELF_SAVE_SUPPRESS_MS = 1500;

/**
 * Re-read a panel's file from disk and push the fresh content to the
 * app as a `file:content` message (feature 040 in the app repo).
 * `reason` tells the app whether this was pushed by the file watcher
 * ("watch" — the app skips it if the user has unsaved edits) or
 * explicitly requested ("request" — always applies).
 */
async function reloadPanelFile(
  panel: vscode.WebviewPanel,
  reason: 'watch' | 'request'
): Promise<void> {
  const file = panelFiles.get(panel);
  if (!file) {
    console.log('[MarDoc reload] no file tracked for this panel — nothing to reload');
    return;
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(file.uri);
    console.log(`[MarDoc reload] pushing file:content (${reason}) for ${file.relativePath} (${bytes.byteLength} bytes)`);
    panel.webview.postMessage({
      type: 'file:content',
      reason,
      filePath: file.relativePath,
      fileName: file.relativePath.split('/').pop() ?? 'untitled',
      fileContent: Buffer.from(bytes).toString('utf-8'),
    });
  } catch (err) {
    vscode.window.showErrorMessage(
      `MarDoc: could not reload ${file.relativePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Shared setup for a MarDoc webview panel: theme sync, message handling.
 *
 * `baseUri` is the root that workspace-relative paths from the app
 * (save targets, image reads) resolve against. For `openFile`, callers
 * pass the git repo root of the opened file — not `workspaceFolders[0]`,
 * which in multi-root workspaces is almost always a sibling repo and
 * would make `docs/images/x.png` look in the wrong place. For the plain
 * `open` command (no specific file) we fall back to `workspaceFolders[0]`.
 */
function setupPanel(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  baseUri?: vscode.Uri,
  fileInfo?: { uri: vscode.Uri; relativePath: string }
): void {
  const resolveBase = (): vscode.Uri | undefined =>
    baseUri ?? vscode.workspace.workspaceFolders?.[0]?.uri;

  if (fileInfo) {
    panelFiles.set(panel, { ...fileInfo, lastSelfSaveAt: 0 });

    // Auto-reload: watch the open file and push fresh content when it
    // changes on disk (same model as VS Code's built-in Markdown Preview
    // / Live Preview — the preview follows the file; no keystroke
    // required). The app side refuses watcher pushes while the user has
    // unsaved edits, so this can't clobber work in progress.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        vscode.Uri.joinPath(fileInfo.uri, '..'),
        fileInfo.uri.path.split('/').pop() ?? '*'
      )
    );
    const onDiskChange = () => {
      const tracked = panelFiles.get(panel);
      if (!tracked) return;
      if (Date.now() - tracked.lastSelfSaveAt < SELF_SAVE_SUPPRESS_MS) {
        console.log(`[MarDoc reload] watcher event within ${SELF_SAVE_SUPPRESS_MS}ms of MarDoc's own save — skipping`);
        return;
      }
      console.log(`[MarDoc reload] disk change detected for ${fileInfo.relativePath}`);
      void reloadPanelFile(panel, 'watch');
    };
    watcher.onDidChange(onDiskChange);
    watcher.onDidCreate(onDiskChange);

    panel.onDidDispose(() => {
      watcher.dispose();
      panelFiles.delete(panel);
    });
  }

  // Sync VS Code theme changes → iframe
  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme((theme) => {
      const dark = theme.kind === vscode.ColorThemeKind.Dark
        || theme.kind === vscode.ColorThemeKind.HighContrast;
      panel.webview.postMessage({ type: 'theme:change', theme: dark ? 'dark' : 'light' });
    })
  );

  // Handle messages forwarded from iframe → webview → extension host
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === 'open-external' && msg.url) {
      vscode.env.openExternal(vscode.Uri.parse(msg.url));
    }

    if (msg.type === 'file:save' && msg.filePath && msg.content !== undefined) {
      const base = resolveBase();
      if (!base) {
        vscode.window.showErrorMessage('No workspace folder open — cannot save file.');
        return;
      }
      const fileUri = vscode.Uri.joinPath(base, msg.filePath);
      const bytes = Buffer.from(msg.content, 'utf-8');
      // Stamp before writing so the watcher event this write triggers is
      // recognized as our own and not pushed back as an "external" change.
      const tracked = panelFiles.get(panel);
      if (tracked) tracked.lastSelfSaveAt = Date.now();
      await vscode.workspace.fs.writeFile(fileUri, bytes);
      vscode.window.showInformationMessage(`Saved ${msg.filePath}`);
    }

    // Local image reader. The app posts a request whenever a markdown
    // file references a relative image path (e.g. `./images/arch.png`);
    // the browser has no filesystem access so we read the bytes here
    // and send back a base64 data payload. Path is workspace-relative
    // and has already been resolved against the containing file's dir
    // by the app (see src/lib/github-api.ts → loadEmbedLocalImages).
    if (msg.type === 'file:read-image' && typeof msg.requestId === 'string' && typeof msg.path === 'string') {
      try {
        const base = resolveBase();
        if (!base) {
          panel.webview.postMessage({
            type: 'file:image-error',
            requestId: msg.requestId,
            error: 'No workspace folder open',
          });
          return;
        }
        const fileUri = vscode.Uri.joinPath(base, msg.path);
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        panel.webview.postMessage({
          type: 'file:image-data',
          requestId: msg.requestId,
          data: Buffer.from(bytes).toString('base64'),
          mimeType: mimeTypeForPath(msg.path),
        });
      } catch (err) {
        panel.webview.postMessage({
          type: 'file:image-error',
          requestId: msg.requestId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Cmd+W bridge: the iframe catches Cmd+W and posts this message
    // because VS Code's keybinding-for-webview system doesn't route
    // close-editor commands reliably. Disposing the panel directly
    // from the extension host is the cleanest path.
    if (msg.type === 'close-panel') {
      panel.dispose();
    }

    // Reload bridge: the app asks (button, palette, or Ctrl/Cmd+Shift+R)
    // for the file's current disk content.
    if (msg.type === 'file:reload') {
      console.log('[MarDoc reload] file:reload received from app');
      await reloadPanelFile(panel, 'request');
    }
  });
}

function mimeTypeForPath(p: string): string {
  const ext = p.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'svg': return 'image/svg+xml';
    case 'webp': return 'image/webp';
    case 'avif': return 'image/avif';
    case 'bmp': return 'image/bmp';
    case 'ico': return 'image/x-icon';
    default: return 'application/octet-stream';
  }
}

async function getAuthToken(): Promise<string | undefined> {
  try {
    const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: false });
    return session?.accessToken;
  } catch {
    return undefined;
  }
}

function isDarkTheme(): boolean {
  return vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
    || vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast;
}

export function activate(context: vscode.ExtensionContext) {
  // Command: open MarDoc (repo browser)
  const command = vscode.commands.registerCommand('mardoc.open', async () => {
    const panel = vscode.window.createWebviewPanel(
      'mardoc',
      'MarDoc',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    const gitContext = getGitContext();
    const token = await getAuthToken();

    const initPayload = JSON.stringify({
      type: 'init',
      owner: gitContext?.owner ?? null,
      repo: gitContext?.repo ?? null,
      branch: gitContext?.branch ?? null,
      token: token ?? null,
      theme: isDarkTheme() ? 'dark' : 'light',
    });

    panel.webview.html = getWebviewHtml(initPayload, '', 'embed=true', getAppBaseUrl());
    setupPanel(panel, context);
  });

  // Command: open specific file in MarDoc
  const openFileCommand = vscode.commands.registerCommand('mardoc.openFile', async (uri?: vscode.Uri) => {
    const fileUri = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!fileUri) {
      vscode.window.showWarningMessage('No file selected.');
      return;
    }

    // Resolve git context AND relative path against the workspace
    // folder that actually contains this file — not workspaceFolders[0].
    // VS Code commonly has multiple workspace folders, and using the
    // first one produces (a) the wrong owner/repo from a sibling repo's
    // git remote and (b) an absolute fsPath as filePath, which breaks
    // image resolution downstream in MarDoc.
    const gitContext = getGitContext(fileUri);
    const repoRoot = getRepoRootForFile(fileUri);
    const relativePath = repoRoot && fileUri.fsPath.startsWith(repoRoot + '/')
      ? fileUri.fsPath.slice(repoRoot.length + 1)
      : fileUri.fsPath;

    const token = await getAuthToken();

    const hash = gitContext
      ? `#/${gitContext.owner}/${gitContext.repo}/blob/${gitContext.branch}/${relativePath}`
      : '';

    const fileBytes = await vscode.workspace.fs.readFile(fileUri);
    const fileContent = Buffer.from(fileBytes).toString('utf-8');

    const initPayload = JSON.stringify({
      type: 'init',
      owner: gitContext?.owner ?? null,
      repo: gitContext?.repo ?? null,
      branch: gitContext?.branch ?? null,
      token: token ?? null,
      theme: isDarkTheme() ? 'dark' : 'light',
      filePath: relativePath,
      fileName: relativePath.split('/').pop() ?? 'untitled',
      fileContent: fileContent,
    });

    const panel = vscode.window.createWebviewPanel(
      'mardoc',
      `MarDoc: ${relativePath.split('/').pop()}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    // Pin the panel's base URI to the git repo root of the opened file.
    // The app sends workspace-relative paths for save and image reads
    // (see `filePath` in init above — it's already `fileUri.fsPath`
    // sliced against `repoRoot`). Resolving those against the matching
    // root keeps the bridge honest in multi-root workspaces.
    const baseUri = repoRoot ? vscode.Uri.file(repoRoot) : undefined;
    panel.webview.html = getWebviewHtml(initPayload, hash, 'embed=true', getAppBaseUrl());
    setupPanel(panel, context, baseUri, { uri: fileUri, relativePath });
  });

  // Command: re-read the active panel's file from disk. Reached from the
  // panel's title-bar refresh icon (the reliable path — pure VS Code, no
  // key capture involved), the command palette, and the Ctrl/Cmd+Shift+R
  // keybinding while a MarDoc panel is active. The in-iframe keydown
  // handler covers the same chord when focus is inside the app.
  const reloadCommand = vscode.commands.registerCommand('mardoc.reloadFile', async () => {
    const active = [...panelFiles.keys()].find((p) => p.active);
    console.log(`[MarDoc reload] mardoc.reloadFile invoked — active file panel: ${active ? panelFiles.get(active)?.relativePath : 'none'}`);
    if (!active) {
      vscode.window.showInformationMessage('No active MarDoc file panel to reload.');
      return;
    }
    await reloadPanelFile(active, 'request');
  });

  context.subscriptions.push(command, openFileCommand, reloadCommand);
}

/**
 * Resolve the MarDoc web app URL the webview should load. Defaults
 * to https://mardoc.app, but is overridable via the `mardoc.appUrl`
 * workspace setting so a developer can point at a local
 * `npm run dev` server (http://localhost:3000) without rebuilding
 * the extension.
 */
function getAppBaseUrl(): string {
  const configured = vscode.workspace
    .getConfiguration('mardoc')
    .get<string>('appUrl');
  if (configured && configured.trim().length > 0) {
    return configured.replace(/\/$/, '');
  }
  return 'https://mardoc.app';
}

function getWebviewHtml(initPayload: string, hash: string, query: string, appBase: string): string {
  const base = query ? `${appBase}/?${query}` : appBase;
  const src = hash ? `${base}${hash}` : base;
  // JSON.stringify escapes quotes and backslashes but NOT `</script>`
  // or `<!--`. The payload is interpolated directly into a <script>
  // block below, so a user-supplied file whose content includes
  // `</script>` would prematurely close the script tag and break the
  // whole webview. Escape both sequences before inlining. HTML files
  // commonly contain `</script>`; markdown files almost never do,
  // which is why only HTML files were failing to load.
  const safeInitPayload = initPayload
    .replace(/<\/script/gi, '<\\/script')
    .replace(/<!--/g, '<\\!--');
  return /*html*/`<!DOCTYPE html>
<html style="margin:0;padding:0;height:100%;width:100%;">
<head>
  <meta charset="UTF-8">
  <style>
    body { margin: 0; padding: 0; height: 100vh; width: 100vw; overflow: hidden; }
    iframe { border: none; width: 100%; height: 100%; }
  </style>
</head>
<body>
  <iframe id="mardoc" src="${src}"></iframe>
  <script>
    const vscodeApi = acquireVsCodeApi();
    const iframe = document.getElementById('mardoc');
    const initPayload = ${safeInitPayload};

    // Send init when iframe signals ready, or retry on iframe load
    let initSent = false;
    function sendInit() {
      if (initSent) return;
      initSent = true;
      iframe.contentWindow.postMessage(initPayload, '*');
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || !msg.type) return;

      if (msg.type === 'file:reload' || msg.type === 'file:content') {
        console.log('[MarDoc reload] wrapper forwarding ' + msg.type);
      }

      if (msg.type === 'ready') {
        sendInit();
      }
      // Forward extension host → iframe
      if (msg.type === 'theme:change' || msg.type === 'file:image-data' || msg.type === 'file:image-error' || msg.type === 'file:content') {
        iframe.contentWindow.postMessage(msg, '*');
      }
      // Forward iframe → extension host
      if (msg.type === 'open-external' || msg.type === 'file:save' || msg.type === 'close-panel' || msg.type === 'file:read-image' || msg.type === 'file:reload') {
        vscodeApi.postMessage(msg);
      }
    });

    // Fallback: if ready was missed, send after iframe loads + short delay
    iframe.addEventListener('load', () => {
      setTimeout(() => sendInit(), 500);
    });
  </script>
</body>
</html>`;
}

export function deactivate() {}
