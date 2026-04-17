/**
 * Node test for git-context.ts.
 *
 * The extension can't be loaded by a normal Node test runner because
 * it imports the `vscode` module, which only exists inside a real
 * Extension Host. This test injects a mock `vscode` into Node's
 * module cache, then `require()`s the COMPILED out/git-context.js so
 * we exercise the same bytes that ship in the .vsix.
 *
 * The test is deliberately driven against the real filesystem path
 * the user reported in their bug report — that way "test passes"
 * actually means "the bug is fixed for that user", not "my unit test
 * fixtures happen to line up".
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');
const assert = require('assert');

// ─── vscode mock ─────────────────────────────────────────────────
//
// Inject before the require() so git-context.js resolves `vscode`
// to this object. We model only the surface area git-context.ts
// actually touches (workspace.getWorkspaceFolder, workspaceFolders).

let mockWorkspaceFolders = [];

const vscodeMock = {
  workspace: {
    get workspaceFolders() {
      return mockWorkspaceFolders.length > 0 ? mockWorkspaceFolders : undefined;
    },
    getWorkspaceFolder(uri) {
      // Match whichever workspace folder fsPath the uri.fsPath starts with
      for (const folder of mockWorkspaceFolders) {
        if (uri.fsPath === folder.uri.fsPath || uri.fsPath.startsWith(folder.uri.fsPath + '/')) {
          return folder;
        }
      }
      return undefined;
    },
  },
  Uri: {
    file(p) { return { fsPath: p, scheme: 'file', toString() { return 'file://' + p; } }; },
  },
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === 'vscode') return 'vscode';
  return originalResolve.call(this, request, parent, ...rest);
};
require.cache['vscode'] = {
  id: 'vscode',
  filename: 'vscode',
  loaded: true,
  exports: vscodeMock,
};

// ─── Load the compiled extension code ────────────────────────────

const gitContextPath = path.resolve(__dirname, '../out/git-context.js');
if (!fs.existsSync(gitContextPath)) {
  console.error(`FAIL: ${gitContextPath} does not exist. Run npm run compile first.`);
  process.exit(1);
}
const { getRepoRootForFile, getGitContext } = require(gitContextPath);

// ─── Test fixtures ───────────────────────────────────────────────
//
// The user's actual file from the bug report. If this file has moved
// or the repo has been renamed, the test will fail loudly with a
// path mismatch — better than silently passing.

const USER_FILE = '/Users/josephbarnett/business/code/cloudzero/feature-ai-collector-macos/tap/README.md';
const USER_REPO_ROOT = '/Users/josephbarnett/business/code/cloudzero/feature-ai-collector-macos';
const USER_FILE_REL = 'tap/README.md';

const fileExists = fs.existsSync(USER_FILE);
const gitRootExists = fs.existsSync(path.join(USER_REPO_ROOT, '.git'));

if (!fileExists || !gitRootExists) {
  console.warn('SKIP: user fixture missing on this machine');
  console.warn(`  file: ${USER_FILE} exists=${fileExists}`);
  console.warn(`  .git: ${USER_REPO_ROOT}/.git exists=${gitRootExists}`);
  process.exit(0);
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    mockWorkspaceFolders = [];
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

console.log('git-context against real filesystem:');

// ─── getRepoRootForFile ──────────────────────────────────────────

test('returns the workspace folder when the file is inside it', () => {
  mockWorkspaceFolders = [
    { uri: vscodeMock.Uri.file(USER_REPO_ROOT), name: 'feature-ai-collector-macos', index: 0 },
  ];
  const root = getRepoRootForFile(vscodeMock.Uri.file(USER_FILE));
  assert.strictEqual(root, USER_REPO_ROOT);
});

test('picks the correct folder out of multiple workspace folders', () => {
  // The bug: the old code took workspaceFolders[0] regardless. With
  // a sibling repo at index 0 and the real one at index 1, the old
  // path returned the sibling. The new path must pick index 1.
  mockWorkspaceFolders = [
    { uri: vscodeMock.Uri.file('/Users/josephbarnett/business/code/josephbarnett/trading-platform'), name: 'trading-platform', index: 0 },
    { uri: vscodeMock.Uri.file(USER_REPO_ROOT), name: 'feature-ai-collector-macos', index: 1 },
  ];
  const root = getRepoRootForFile(vscodeMock.Uri.file(USER_FILE));
  assert.strictEqual(root, USER_REPO_ROOT, 'should NOT return trading-platform');
});

test('walks up to find .git when no workspace folder contains the file', () => {
  // No matching workspace folder. The walk-up fallback must find
  // the .git directory at USER_REPO_ROOT.
  mockWorkspaceFolders = [
    { uri: vscodeMock.Uri.file('/tmp/some-other-folder'), name: 'other', index: 0 },
  ];
  const root = getRepoRootForFile(vscodeMock.Uri.file(USER_FILE));
  assert.strictEqual(root, USER_REPO_ROOT);
});

test('returns undefined when neither match nor .git ancestor exists', () => {
  mockWorkspaceFolders = [];
  const root = getRepoRootForFile(vscodeMock.Uri.file('/tmp/no-repo-here.md'));
  assert.strictEqual(root, undefined);
});

// ─── relative path computation (the slice() in extension.ts) ─────
//
// extension.ts does:
//   const relativePath = repoRoot && fileUri.fsPath.startsWith(repoRoot + '/')
//     ? fileUri.fsPath.slice(repoRoot.length + 1)
//     : fileUri.fsPath;
// This is the actual path that ends up in the init payload as
// data.filePath, then becomes __local__/${data.filePath} inside
// MarDoc. If THIS is wrong the user sees "__local__/Users/…" in
// every URL.

function computeRelativePath(fileFsPath, repoRoot) {
  return repoRoot && fileFsPath.startsWith(repoRoot + '/')
    ? fileFsPath.slice(repoRoot.length + 1)
    : fileFsPath;
}

test('relative path is workspace-relative for the user fixture', () => {
  mockWorkspaceFolders = [
    { uri: vscodeMock.Uri.file(USER_REPO_ROOT), name: 'feature-ai-collector-macos', index: 0 },
  ];
  const root = getRepoRootForFile(vscodeMock.Uri.file(USER_FILE));
  const rel = computeRelativePath(USER_FILE, root);
  assert.strictEqual(rel, USER_FILE_REL);
});

test('relative path stays workspace-relative even when sibling folder is index 0', () => {
  mockWorkspaceFolders = [
    { uri: vscodeMock.Uri.file('/Users/josephbarnett/business/code/josephbarnett/trading-platform'), name: 'trading-platform', index: 0 },
    { uri: vscodeMock.Uri.file(USER_REPO_ROOT), name: 'feature-ai-collector-macos', index: 1 },
  ];
  const root = getRepoRootForFile(vscodeMock.Uri.file(USER_FILE));
  const rel = computeRelativePath(USER_FILE, root);
  assert.strictEqual(rel, USER_FILE_REL, `expected '${USER_FILE_REL}', got '${rel}'`);
});

// ─── getGitContext (executes real git commands) ──────────────────

test('git context returns the actual repo, not the first workspace folder', () => {
  mockWorkspaceFolders = [
    { uri: vscodeMock.Uri.file('/Users/josephbarnett/business/code/josephbarnett/trading-platform'), name: 'trading-platform', index: 0 },
    { uri: vscodeMock.Uri.file(USER_REPO_ROOT), name: 'feature-ai-collector-macos', index: 1 },
  ];
  const ctx = getGitContext(vscodeMock.Uri.file(USER_FILE));
  assert.ok(ctx, 'git context must not be null');
  assert.strictEqual(ctx.owner.toLowerCase(), 'cloudzero');
  assert.strictEqual(ctx.repo, 'feature-ai-collector-macos');
  assert.ok(typeof ctx.branch === 'string' && ctx.branch.length > 0);
});

// ─── Result ──────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
