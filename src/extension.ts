import * as vscode from 'vscode';
import { getGitContext } from './git-context';

/** Shared setup for a MarDoc webview panel: theme sync, message handling. */
function setupPanel(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext
): void {
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
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open — cannot save file.');
        return;
      }
      const fileUri = vscode.Uri.joinPath(workspaceFolder, msg.filePath);
      const bytes = Buffer.from(msg.content, 'utf-8');
      await vscode.workspace.fs.writeFile(fileUri, bytes);
      vscode.window.showInformationMessage(`Saved ${msg.filePath}`);
    }
  });
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

    panel.webview.html = getWebviewHtml(initPayload, '', 'embed=true');
    setupPanel(panel, context);
  });

  // Command: open specific file in MarDoc
  const openFileCommand = vscode.commands.registerCommand('mardoc.openFile', async (uri?: vscode.Uri) => {
    const fileUri = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!fileUri) {
      vscode.window.showWarningMessage('No file selected.');
      return;
    }

    const gitContext = getGitContext();
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const relativePath = workspaceFolder
      ? fileUri.fsPath.replace(workspaceFolder + '/', '')
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

    panel.webview.html = getWebviewHtml(initPayload, hash, 'embed=true');
    setupPanel(panel, context);
  });

  context.subscriptions.push(command, openFileCommand);
}

function getWebviewHtml(initPayload: string, hash: string, query: string): string {
  const base = query ? `https://mardoc.app/?${query}` : 'https://mardoc.app';
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

      if (msg.type === 'ready') {
        sendInit();
      }
      // Forward theme changes from extension host → iframe
      if (msg.type === 'theme:change') {
        iframe.contentWindow.postMessage(msg, '*');
      }
      // Forward app messages → extension host
      if (msg.type === 'open-external' || msg.type === 'file:save') {
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
