import * as vscode from 'vscode';
import { getGitContext } from './git-context';

export function activate(context: vscode.ExtensionContext) {
  const command = vscode.commands.registerCommand('mardoc.open', async () => {
    const panel = vscode.window.createWebviewPanel(
      'mardoc',
      'MarDoc',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    const gitContext = getGitContext();

    let token: string | undefined;
    try {
      const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: false });
      token = session?.accessToken;
    } catch {
      // User declined or no GitHub auth — app falls back to its own settings
    }

    const isDark = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
      || vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast;

    const initPayload = JSON.stringify({
      type: 'init',
      owner: gitContext?.owner ?? null,
      repo: gitContext?.repo ?? null,
      branch: gitContext?.branch ?? null,
      token: token ?? null,
      theme: isDark ? 'dark' : 'light',
    });

    panel.webview.html = getWebviewHtml(initPayload, '', 'embed=true');

    // Sync theme changes
    context.subscriptions.push(
      vscode.window.onDidChangeActiveColorTheme((theme) => {
        const dark = theme.kind === vscode.ColorThemeKind.Dark
          || theme.kind === vscode.ColorThemeKind.HighContrast;
        panel.webview.postMessage({ type: 'theme:change', theme: dark ? 'dark' : 'light' });
      })
    );
  });

  const openFileCommand = vscode.commands.registerCommand('mardoc.openFile', async (uri?: vscode.Uri) => {
    const fileUri = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!fileUri) {
      vscode.window.showWarningMessage('No markdown file selected.');
      return;
    }

    const gitContext = getGitContext();
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const relativePath = workspaceFolder
      ? fileUri.fsPath.replace(workspaceFolder + '/', '')
      : fileUri.fsPath;

    let token: string | undefined;
    try {
      const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: false });
      token = session?.accessToken;
    } catch {
      // Falls back to app settings
    }

    const isDark = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
      || vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast;

    // Build the hash route to navigate directly to this file
    const hash = gitContext
      ? `#/${gitContext.owner}/${gitContext.repo}/blob/${gitContext.branch}/${relativePath}`
      : '';

    const query = 'embed=true';

    // Read the file content to send to the app
    const fileBytes = await vscode.workspace.fs.readFile(fileUri);
    const fileContent = Buffer.from(fileBytes).toString('utf-8');

    const initPayload = JSON.stringify({
      type: 'init',
      owner: gitContext?.owner ?? null,
      repo: gitContext?.repo ?? null,
      branch: gitContext?.branch ?? null,
      token: token ?? null,
      theme: isDark ? 'dark' : 'light',
      filePath: relativePath,
      fileName: relativePath.split('/').pop() ?? 'untitled.md',
      fileContent: fileContent,
    });

    const panel = vscode.window.createWebviewPanel(
      'mardoc',
      `MarDoc: ${relativePath.split('/').pop()}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    panel.webview.html = getWebviewHtml(initPayload, hash, query);

    context.subscriptions.push(
      vscode.window.onDidChangeActiveColorTheme((theme) => {
        const dark = theme.kind === vscode.ColorThemeKind.Dark
          || theme.kind === vscode.ColorThemeKind.HighContrast;
        panel.webview.postMessage({ type: 'theme:change', theme: dark ? 'dark' : 'light' });
      })
    );
  });

  context.subscriptions.push(command, openFileCommand);
}

function getWebviewHtml(initPayload: string, hash: string, query: string): string {
  const base = query ? `https://mardoc.app/?${query}` : 'https://mardoc.app';
  const src = hash ? `${base}${hash}` : base;
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
    const iframe = document.getElementById('mardoc');
    const initPayload = ${initPayload};

    // Send init when iframe signals ready, or retry on iframe load
    let initSent = false;
    function sendInit() {
      if (initSent) return;
      initSent = true;
      iframe.contentWindow.postMessage(initPayload, '*');
    }

    window.addEventListener('message', (event) => {
      if (event.data?.type === 'ready') {
        sendInit();
      }
      // Forward theme changes from extension host to iframe
      if (event.data?.type === 'theme:change') {
        iframe.contentWindow.postMessage(event.data, '*');
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
