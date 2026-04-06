import * as vscode from 'vscode';
import { execSync } from 'child_process';

interface GitContext {
  owner: string;
  repo: string;
  branch: string;
}

export function getGitContext(): GitContext | null {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceFolder) {
    return null;
  }

  try {
    const remoteUrl = execSync('git config --get remote.origin.url', {
      cwd: workspaceFolder,
      encoding: 'utf-8',
    }).trim();

    const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (!match) {
      return null;
    }

    const branch = execSync('git symbolic-ref --short HEAD', {
      cwd: workspaceFolder,
      encoding: 'utf-8',
    }).trim();

    return { owner: match[1], repo: match[2], branch };
  } catch {
    return null;
  }
}
