# Contributing to CodeFlow

CodeFlow is an npm workspace. `packages/shared` is the language-neutral graph. `packages/extension` is the VS Code extension host. `packages/webview` is the React diagram.

The extension id is `rezis-work.rezis-codeflow` (`publisher` `rezis-work`, `name` `rezis-codeflow`). Integration tests look the extension up by that id. Command ids, `codeflow.*` settings, and view ids stay `codeflow`.

## Setup

- Node.js 22 or newer (`nvm use` reads `.nvmrc`)
- npm 10 or newer
- VS Code 1.90 or newer, or Cursor, to launch the Extension Development Host. 1.90 is required because `vscode.lm` joined the stable API then.

```bash
npm ci
npm run build
```

`npm run watch` rebuilds the extension and the webview as you edit. Open this folder and press F5 (**Run CodeFlow**). The pre-launch task builds both packages.

On Linux without a display, integration tests need `xvfb`:

```bash
npm run lint
npm run format:check
npm run typecheck
npm test
xvfb-run -a npm run test:integration
```

`npm test` is Vitest. `npm run test:integration` launches a real extension host. `npm run bench -- --quick` times the in-repo fixtures. `npm run package` writes `rezis-codeflow.vsix` at the repository root. Do not commit the VSIX.

## Pull requests

- Match the existing style. Prettier and ESLint are what CI runs.
- Add or update a unit test for analyzer and graph changes. Use the integration suite when a command, CodeLens, or the webview message changes.
- Keep analysis local. Do not add telemetry or a network call from the extension host or the webview.
- The Marketplace README is the repository `README.md`. `npm run package` copies it, `CHANGELOG.md`, and `LICENSE` into the VSIX. Images in that README must be `https://` URLs. Screenshots live in `docs/images/`.
- Settings the user can change belong in `packages/extension/package.json`, with a description, a default, and an `order`, in one of the CodeFlow groups. Update `docs/SETTINGS.md` and the settings table in `README.md` in the same change.

Behavior notes for the graph and the analyzers are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Publishing is maintainer-only and is documented in [docs/PUBLISHING.md](docs/PUBLISHING.md).

## License

MIT. By contributing, you agree that your contributions are licensed under the repository [LICENSE](LICENSE).
