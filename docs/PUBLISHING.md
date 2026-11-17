# Publishing CodeFlow

CodeFlow 1.0.1 is extension id `rezis-work.rezis-codeflow` (`name` `rezis-codeflow`). The Marketplace rejected the name `codeflow`. Open VSX 1.0.0 was published as `rezis-work.codeflow` and stays that listing.

- Cursor installs 1.0.1 from [Open VSX](https://open-vsx.org/extension/rezis-work/rezis-codeflow).
- VS Code installs 1.0.1 from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=rezis-work.rezis-codeflow).

The owner publishes by pushing a tag after the release commit is on `main`. This repository does not store tokens. GitHub Actions reads them from secrets named `OVSX_PAT` and `VSCE_PAT`. A missing secret skips that registry and warns. The other registry still runs, and the VSIX is still attached to a GitHub Release.

Do not print a token, commit one, or paste one into an issue, a pull request, or a log.

## 1. Open VSX token (`OVSX_PAT`)

The Open VSX account is GitHub user `rezis-work`, with the Eclipse account linked and the Publisher Agreement signed.

1. Sign in at [open-vsx.org](https://open-vsx.org/).
2. Open [open-vsx.org/user-settings/tokens](https://open-vsx.org/user-settings/tokens).
3. Create an access token and copy it. That value is the GitHub secret `OVSX_PAT`. Open VSX shows the token once.

The release workflow runs `npx ovsx create-namespace rezis-work`. If the namespace already exists, that command fails, the workflow warns, and publish continues.

## 2. VS Code Marketplace token (`VSCE_PAT`)

The Marketplace publisher id is `rezis-work`. The token is an Azure DevOps personal access token. It is not a GitHub token.

1. Sign in at [https://dev.azure.com](https://dev.azure.com) with the account that owns the `rezis-work` publisher.
2. If that account has no Azure DevOps organization, create one. The organization name is not the publisher id. Any name works.
3. Open **Personal access tokens**. From the user settings icon next to your avatar, choose **Personal access tokens**. After an organization exists, the page is `https://dev.azure.com/{organization}/_usersSettings/tokens`.
4. Choose **New Token**.
5. Name it `codeflow-marketplace`.
6. Set **Organization** to **All accessible organizations**. A token scoped to one organization cannot publish to the Marketplace.
7. Set an expiration. When it lapses, replace the `VSCE_PAT` secret. Until you do, the Marketplace step fails and Open VSX is unaffected.
8. Scopes: choose **Custom defined**, then **Show all scopes**. Under **Marketplace**, check **Manage**. Do not grant full access.
9. Create the token and copy it. Azure DevOps shows it once. That value is the GitHub secret `VSCE_PAT`.

### If Azure DevOps will not issue a token

Leave `VSCE_PAT` unset. The workflow still publishes to Open VSX and still attaches the VSIX to the GitHub Release. It prints a warning for the Marketplace step.

Upload that VSIX by hand:

1. On a checkout of the tag, run `npm ci` and `npm run package`. The file is `rezis-codeflow.vsix` at the repository root. The Release asset `rezis-codeflow-1.0.1.vsix` is the same package.
2. Open [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage) and sign in as publisher `rezis-work`.
3. Create the extension, or open CodeFlow and choose to update it.
4. Upload the `.vsix`.

Repeat the upload for each later version. The manual page does not read `VSCE_PAT`.

From a laptop, when a token does work:

```bash
npx @vscode/vsce publish --packagePath rezis-codeflow.vsix --pat "$VSCE_PAT"
```

## 3. Add the GitHub Actions secrets

1. Open [the repository's Actions secrets](https://github.com/rezis-work/codeflow/settings/secrets/actions).
2. **New repository secret**. Name: `OVSX_PAT`. Value: the Open VSX token.
3. **New repository secret**. Name: `VSCE_PAT`. Value: the Azure DevOps token. Skip this one if you will use the manual Marketplace upload.

Secret values are masked in Actions logs. The workflow never echoes them. Do not pass them with `set -x`.

## 4. Tag the release

Merge the 1.0.1 pull request first. The tag has to point at the commit on `main` whose `packages/extension/package.json` version is `1.0.1`. The workflow rejects a tag that does not match that version. `v1.0.0` already published Open VSX as `rezis-work.codeflow`. Do not move that tag.

```bash
git checkout main
git pull origin main
git tag v1.0.1
git push origin v1.0.1
```

Do not create the tag before that commit is on `main`.

Pushing `v1.0.1` runs [`.github/workflows/release.yml`](../.github/workflows/release.yml):

1. Check out the tag and confirm it matches the extension version.
2. Lint, check formatting, typecheck, run unit tests, build, run integration tests.
3. Package **one** VSIX (`npm run package`), then rename it to `rezis-codeflow-1.0.1.vsix`.
4. Open VSX, only when `OVSX_PAT` is set: `npx ovsx create-namespace rezis-work` (an existing namespace is a warning, not a failure), then `npx ovsx publish rezis-codeflow-1.0.1.vsix --pat "$OVSX_PAT"`.
5. Marketplace, only when `VSCE_PAT` is set: `npx @vscode/vsce publish --packagePath rezis-codeflow-1.0.1.vsix --pat "$VSCE_PAT"`.
6. Attach that same VSIX to a GitHub Release. This step still runs when a registry was skipped. It also runs when a publish step failed, so the file is not lost. A failed publish still fails the job.

Both publish commands pass `--skip-duplicate`, so running the workflow again for a version that is already listed does not fail.

## 5. Publish again without a new tag

Use this after you add a secret that was missing, or to retry a failed publish. In the GitHub Actions tab, open **Release**, choose **Run workflow**, and enter the tag `v1.0.1` (the `v` is required). The workflow checks out that tag, packages again, and publishes the same version. `--skip-duplicate` makes an already-published version a no-op.

A new version needs a version bump in `packages/extension/package.json` (the tag check reads that file), a changelog section, a merge to `main`, and a new tag such as `v1.1.0`. The Marketplace and Open VSX will not replace an existing version.

## 6. Check the listings

- Open VSX 1.0.1: [open-vsx.org/extension/rezis-work/rezis-codeflow](https://open-vsx.org/extension/rezis-work/rezis-codeflow). The 1.0.0 listing remains [open-vsx.org/extension/rezis-work/codeflow](https://open-vsx.org/extension/rezis-work/codeflow).
- Marketplace: [marketplace.visualstudio.com/items?itemName=rezis-work.rezis-codeflow](https://marketplace.visualstudio.com/items?itemName=rezis-work.rezis-codeflow)
- Cursor: Extensions, search CodeFlow, publisher **rezis-work**, id `rezis-work.rezis-codeflow`. Cursor does not read the VS Code Marketplace.
- VS Code: Extensions, the same publisher and id.
- GitHub Release: the asset `rezis-codeflow-1.0.1.vsix`.

The README images load from `raw.githubusercontent.com` on `main`. They appear on the Marketplace page after this commit is on `main`, which is why the tag is pushed after the merge.

## 7. Publish from a laptop

Use this when Actions cannot reach a registry. Check out the tag first so the version matches.

Open VSX:

```bash
npm ci
npm run package
npx ovsx create-namespace rezis-work --pat "$OVSX_PAT" || true
npx ovsx publish rezis-codeflow.vsix --pat "$OVSX_PAT"
```

`|| true` is only there so an existing namespace does not stop the publish. A bad token still fails on `ovsx publish`.

Marketplace, with a token:

```bash
npx @vscode/vsce publish --packagePath rezis-codeflow.vsix --pat "$VSCE_PAT"
```

Marketplace, without a token: upload `rezis-codeflow.vsix` at [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage) as publisher `rezis-work`. The extension name in that VSIX is `rezis-codeflow`.

`npm run package` is the only pack command. It copies the repository README, changelog, and MIT license into the VSIX, then removes those copies from `packages/extension`.
