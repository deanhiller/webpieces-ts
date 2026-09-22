---
name: bootstrap-npm-package
description: Claim a NEW @webpieces/* package name on npm so the automated release can publish it. Use when a PR adds a package under packages/**, when a release 404s on a package name, when scripts/publish-packages.sh preflight names a package missing from ORDER, or when someone asks to "bootstrap the npm package", "claim the npm name", or "set up trusted publishing" for a new package. Encodes the three steps that need a real TTY and the version choice that cannot collide with a release.
---

# Bootstrap a new @webpieces/* package on npm

CI publishes with npm **trusted publishing** (OIDC), and a trusted publisher is configured **per
existing package**. It therefore cannot bring a brand-new name into existence. A new scoped name must
be claimed by ONE authenticated local publish first; every release after that is automated.

Skip all of this only when `npm view @webpieces/<name> version` already returns a version.

## Why it is not optional, and why the failure arrives late

- `scripts/publish-packages.sh` PREFLIGHT fails if a publishable package is missing from `ORDER`, so a
  new package MUST be listed there.
- Once listed, the release loop tries to publish it — and **npm masks an auth failure on an unknown
  name as a 404**. `publish_one()` retries, the loop records the outcome and ends with a
  partial-release summary, so the release goes red at the very end and that package ships nothing.

`core-mock`, `ipc-bridge` and `mcp-server` each needed this step, and each was bootstrapped only
AFTER a release had already failed on it. Doing it before the package lands is strictly better, and
the bootstrap does not depend on the PR being merged.

## Step 0 — build and inspect the artifact (the agent does this)

Publish the REAL build output, never the source directory.

```bash
pnpm nx run <project>:build          # writes <tree>/dist/packages/<path>/
```

Then, in that `dist/packages/<path>/` directory:

1. **Set `version` to `0.0.1`** in the dist `package.json`.

   **Why `0.0.1` and not the current release line.** `scripts/set-version.sh` emits
   `${BASE_VERSION}.${BUILD_NUMBER}` — always `0.4.<n>` — or `0.0.0-dev` when `BUILD_NUMBER` is unset.
   It can never emit `0.0.1`, so the bootstrap version cannot collide with a release. Claiming the
   name at a `0.4.x` instead risks a rerun of that exact release seeing "already published", which
   `publish_one()` treats as SUCCESS — silently skipping the real artifact.

2. **`npm pack`**, then read the file list. Expect compiled `.js`, `.d.ts`, maps, README and the
   manifest. Check `dependencies` carries no `workspace:` specifier.

3. If the package declares executables, confirm `publishConfig.bin` was hoisted into `bin` in the DIST
   manifest — npm does not do it, the publish script does. See `.claude/rules/packaging-and-bins.md`.

## The steps that need a REAL TTY (the human does these)

**`npm publish` cannot be completed from an agent's shell.** It requires interactive 2FA, and in a
non-TTY it does not prompt — it fails immediately with `EOTP`. Passing `--otp=<6 digits>` inline does
work, but the code expires in ~30 seconds, so in practice it just fails again.

`npm login` is different and that difference is not obvious: it prints a browser URL and waits on the
NETWORK rather than on stdin, so it survives a non-TTY shell. Keep both together anyway, so the human
gets one copy-paste sequence.

Hand the human these, for their own terminal:

**1. Log in**

```bash
npm login
```

**2. Publish the tarball** — npm opens browser auth in a real terminal

```bash
cd <absolute path to dist/packages/<path>>
npm publish ./<name>-0.0.1.tgz --access public
```

Success looks like `+ @webpieces/<name>@0.0.1`.

**3. Save the trusted publisher**

```
https://www.npmjs.com/package/@webpieces/<name>/access
```

Trusted Publisher → Add trusted publisher → GitHub Actions:

| Field | Value |
|---|---|
| Organization or user | `deanhiller` |
| Repository | `webpieces-ts` |
| Workflow filename | `release.yml` |
| Environment | *(blank — the release job declares none)* |
| Allowed actions | npm publish |

A screenshot of a filled form is not proof of Save — verify the saved trust card.

## Step 4 — verify (the agent does this)

```bash
npm view @webpieces/<name>
```

Check the version and the dependency list, and confirm the published `.shasum` MATCHES the tarball
that was inspected in step 0 — that is what proves the published artifact is the reviewed one.

**A green `npm view` does not prove trusted publishing works.** The trust card is not exercised until
the next release publishes a NEW version of that package. Say that plainly rather than implying the
verification covered it.

## Do not

- Do not `npm unpublish` or overwrite a version as a retry strategy.
- Do not loop identical publishes on failure — read the error first. `EOTP` means the TTY problem
  above; a 404 on a name you own usually means an auth failure, not a missing package.
- Do not ask the human to paste an OTP into the chat. Hand them the command; credentials stay in their
  terminal.
