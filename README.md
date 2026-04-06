# MarDoc for VS Code

Rich markdown editing and GitHub PR review inside VS Code, powered by [mardoc.app](https://mardoc.app).

## Install

Download the `.vsix` from [Releases](https://github.com/mardoc-io/mardoc-vscode/releases), then:

```
code --install-extension mardoc-*.vsix
```

## Usage

- **Right-click any `.md` file** in the explorer → **"Edit with MarDoc"** — opens the file in a rendered WYSIWYG editor alongside your code
- **Command palette** → **"MarDoc: Open"** — opens the full MarDoc app with your workspace's repo context

The extension automatically detects your workspace's GitHub remote and branch. If VS Code has GitHub auth configured, it passes the token so PRs load without separate setup.

## Development

```
npm install
npm run compile
```

Open this folder in VS Code, press **F5** to launch the Extension Development Host.
