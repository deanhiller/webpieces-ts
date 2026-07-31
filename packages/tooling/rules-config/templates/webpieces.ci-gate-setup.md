# Server-side PR gate — one-time setup (for the AI / repo admin)

Written by `wp-install-ai-hooks`. This is **setup**, run once per repo — deliberately NOT part of the
PR flow. `wp-start-upsert-pr` used to print these instructions on every run, at an agent doing feature
work that could not act on them anyway: step 3 needs a repo admin.

## What this is for

Locally, `pr-creation-or-push-guard` blocks `gh pr create` and manual `git push`, so
`wp-finish-upsert-pr` is the only way a PR gets opened — **for hooked developers**. The gap is an
UNHOOKED teammate who pushes and opens a PR in the GitHub web UI. Nothing local can stop that.

This CI check closes it: `wp-finish-upsert-pr` writes `HMAC(gateSalt, HEAD_sha)` into the PR body, and
the workflow recomputes it from the committed salt and the PR head sha. A PR opened outside the gated
flow carries no valid token and fails the check.

## The three steps

1. **Copy the workflow into place and commit it:**

   ```bash
   cp .webpieces/instruct-ai/webpieces-pr-gate.yml .github/workflows/webpieces-pr-gate.yml
   git add .github/workflows/webpieces-pr-gate.yml
   ```

   It is scaffolded into gitignored `.webpieces/instruct-ai/` rather than written straight into
   `.github/` so it can never dirty your tree mid-flow. Copying it is your decision, not the tool's.

2. **Set a non-empty `gateSalt`** under the `pr-gate` section of `webpieces.config.json` (any string).
   Empty or absent ⇒ no token is minted and the whole feature is a no-op, byte-identical to not having
   it. That is the supported "off" state, not a misconfiguration.

3. **Mark the job REQUIRED in branch protection for `main`:**

   ```
   Webpieces PR Gate / Verify webpieces gate token
   ```

   That is the one required check — there is deliberately nothing else to pick. **Only a repo admin can
   do this; webpieces cannot set branch protection for you.** Until it is required the check runs and
   reports, but blocks nothing.

## Know what this buys you, and what it does not

The salt is **committed**, so it is readable by anyone — and by any coding agent — with repo access. It
is obscurity-grade on purpose: it stops an unhooked teammate who does not know the scheme exists. It
does **not** stop a determined reader who opens `webpieces.config.json` and forges a token. It is not
cryptographically sound and is not trying to be.

If you need a gate an agent cannot forge, the salt must leave the repo (a GitHub Actions secret) — and
`wp-finish-upsert-pr` then needs its own way to obtain the same salt locally in order to MINT the
token. That is a real design change, not a config edit. Do not half-do it: moving the salt to a secret
while leaving local minting broken produces a check that fails every honest PR.

## Upgrading from an older version

Earlier versions also posted a `webpieces/pr-gate` **commit status** and told you to require that
instead of the job. It is gone — it only existed to cover a race where the push happened before the PR
body was written, and the body is now written first. If `webpieces/pr-gate` is still marked required in
branch protection, repoint it at the job name above, or that context sits Pending forever and blocks
every PR.
