import * as vscode from 'vscode';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

interface GitContext {
  owner: string;
  repo: string;
  branch: string;
}

/**
 * Resolve the git context for a specific file (or, if no file is
 * given, for the first workspace folder).
 *
 * Why per-file: a VS Code window often has multiple workspace folders
 * open, or has files opened from outside any workspace folder. Reading
 * the git remote from `workspaceFolders[0]` is wrong in either case —
 * it returns whichever repo happens to be first in the multi-root
 * workspace, not the one the file actually lives in. That manifests
 * in MarDoc as `owner/repo` mismatches and an absolute filesystem
 * path being shown as the file path. Always resolve from the file
 * when one is provided; only fall back to the first folder when
 * there's no file context (the bare `MarDoc: Open` command).
 */
export function getGitContext(fileUri?: vscode.Uri): GitContext | null {
  const cwd = resolveGitCwd(fileUri);
  if (!cwd) {
    return null;
  }

  try {
    const remoteUrl = execSync('git config --get remote.origin.url', {
      cwd,
      encoding: 'utf-8',
    }).trim();

    const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (!match) {
      return null;
    }

    const branch = execSync('git symbolic-ref --short HEAD', {
      cwd,
      encoding: 'utf-8',
    }).trim();

    return { owner: match[1], repo: match[2], branch };
  } catch {
    return null;
  }
}

/**
 * Pick the working directory git commands should run in.
 *
 * Order:
 *   1. The workspace folder VS Code says contains the file
 *      (`workspace.getWorkspaceFolder(fileUri)`)
 *   2. Walk up from the file's parent directory looking for a `.git`
 *      directory (covers files opened from outside any workspace folder)
 *   3. The first workspace folder (legacy fallback for `MarDoc: Open`
 *      with no file)
 */
function resolveGitCwd(fileUri?: vscode.Uri): string | undefined {
  if (fileUri) {
    const containingFolder = vscode.workspace.getWorkspaceFolder(fileUri);
    if (containingFolder) {
      return containingFolder.uri.fsPath;
    }
    const walked = walkUpForGitRoot(path.dirname(fileUri.fsPath));
    if (walked) {
      return walked;
    }
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function walkUpForGitRoot(start: string): string | undefined {
  let current = start;
  while (current && current !== path.dirname(current)) {
    try {
      if (fs.existsSync(path.join(current, '.git'))) {
        return current;
      }
    } catch {
      // ignore — keep walking
    }
    current = path.dirname(current);
  }
  return undefined;
}

/**
 * Public helper for the file path computation in extension.ts.
 * Returns the workspace folder fsPath that contains the file, or
 * the discovered git root if no workspace folder claims it.
 */
export function getRepoRootForFile(fileUri: vscode.Uri): string | undefined {
  const containingFolder = vscode.workspace.getWorkspaceFolder(fileUri);
  if (containingFolder) {
    return containingFolder.uri.fsPath;
  }
  return walkUpForGitRoot(path.dirname(fileUri.fsPath));
}
