# BUG: the gate-token check races `wp-finish-upsert-pr` — the push fires `synchronize` before the PR body is edited, so CI reads the PREVIOUS head's token and goes red

**Package:** `@webpieces/pr-gate`
**Version seen:** `0.4.470` (present since the gate token shipped in #484)
**Severity:** High **for the feature's stated purpose.** The token logic is correct; the *ordering* is not.
`wp-finish-upsert-pr` pushes and only then edits the PR body, but GitHub fires `pull_request:
synchronize` on the push — so `wp-check-pr` frequently runs against a body that still carries the token
for the **previous** head sha and fails. It self-heals only if a later `edited` event happens to fire a
second run, which is not guaranteed. A gate that intermittently red-flags correctly-gated PRs cannot be
marked **required**, which is the entire point of the feature.

**Source:**
- `packages/tooling/pr-gate/src/scripts/commands/finish-upsert-pr-command.ts` — `ensurePushed(...)` runs before `upsertPr(...)`
- `packages/tooling/rules-config/src/gate-token.js` — `token = HMAC-SHA256(gateSalt, HEAD_sha)`, bound to the head sha
- `packages/tooling/pr-gate/src/scripts/commands/check-pr-command.ts` — reads `headRefOid` + `body` and compares

## The bug

The token is bound to the head sha, correctly. But the two things it binds are written to GitHub in the
wrong order:

1. `ensurePushed(...)` — pushes the new commit. **GitHub fires `pull_request: synchronize` here.**
2. `upsertPr(...)` — `gh pr edit` writes the body containing `HMAC(gateSalt, NEW_head_sha)`.

Any CI run started by (1) reads the body as it existed *before* (2). That body holds the token for the
**old** head sha, so `verifyGateToken(body, salt, newHeadSha)` fails and the check goes red — on a PR
that went through the gated flow perfectly.

There is no ordering guarantee in the other direction either: if the workflow is slow to start, the edit
may land first and the run passes. **The outcome depends on a timing coin-flip**, which is the worst
property a required check can have.

## Measurement

Consuming repo: **`/Users/deanhiller/workspace/onetablet/monorepo-nx2`**, PR
[#740](https://github.com/mealco-internal/monorepo-nx/pull/740), `gateSalt` configured, workflow running
`pnpm wp-check-pr` on `pull_request` with `types: [opened, synchronize, reopened, edited]`.

Four consecutive runs of the SAME workflow on the SAME branch, every one of them after a correct
`wp-start-upsert-pr` → review → `wp-finish-upsert-pr` cycle:

```
08:21:45  a2409e2  FAILURE     synchronize fired before the body edit
08:27:21  a978dde  cancelled   (concurrency)
08:27:24  a978dde  SUCCESS     the `edited` event re-ran it — passed
08:41:20  ac19de5  FAILURE     no follow-up run fired this time
```

The failing run's log shows the check working exactly as designed — it resolved the PR and the head sha
without trouble, then found the wrong token:

```
GH_TOKEN: ***
WP_PR_NUMBER: 740
❌ wp-check-pr: PR #740 (head ac19de52cc33) has no valid webpieces gate token.
```

Verified the token itself was never wrong. Recomputing by hand *after* the body edit landed:

```
head sha : ac19de52cc334d89e9dbc5e1d587f6cbefd1896a
body tok : 8971b32e029d9f40...
HMAC(gateSalt, headSha) → MATCH
```

and `gh run rerun 30436511088` — same commit, same body, no code change — went **green**. So the only
variable is *when* the run read the body.

Note `types: [... edited]` is already in that workflow, and it is what rescued the 08:27 run. It is a
mitigation, not a fix: at 08:41 no `edited`-triggered run appeared at all, leaving a required-shaped
check sitting red on a fully compliant PR.

## Suggested fix

The root cause is that CI is triggered by an event that fires *before* the artifact it validates exists.
Three options, best first.

### 1. Post a commit status directly, instead of relying on a workflow re-reading the body (preferred)

Have `wp-finish-upsert-pr` — which already has `gh` and already knows the head sha — write the result to
the commit itself, after the body edit:

```ts
// after upsertPr(), so ordering is inside our control rather than GitHub's event timing
gh api -X POST repos/{owner}/{repo}/statuses/{headSha} \
  -f state=success -f context='webpieces/pr-gate' \
  -f description='gated flow ran and passed'
```

A commit status is attached to the sha, so it cannot be read "too early" — it simply does not exist until
we create it, and GitHub shows the check as pending until then. `wp-check-pr` remains for the unhooked
case. Cost: needs a token with `statuses: write`, which the local `gh` already has.

### 2. Make the workflow tolerate the race instead of failing on it

If the body carries a *valid token for an ancestor of the current head*, the gated flow demonstrably ran;
what is stale is the run, not the PR. Re-read the PR once after a short delay before failing:

```ts
if (!verify(body, salt, headSha)) {
    await sleep(15_000);
    const fresh = this.resolvePr();          // re-read; the edit usually lands within seconds
    if (verify(fresh.body, salt, fresh.headSha)) return;
}
```

Cheap and self-contained, but it is a sleep-and-hope — it narrows the window without closing it.

### 3. Edit the body BEFORE pushing

Reverses the order so the token is in place when `synchronize` fires. Rejected on inspection: the token
is `HMAC(salt, HEAD_sha)` and the PR's head sha is not the branch's until the push lands, so there is
nothing correct to write yet. Recording it here so the next person does not re-derive it.

## Notes for whoever fixes it

- **Do not "fix" this by dropping `synchronize` from the trigger list.** The check must run on every push
  — that is what catches an unhooked teammate pushing over a previously-gated PR.
- **`concurrency: cancel-in-progress: true` interacts badly here.** At 08:27 two runs started 3 seconds
  apart and the first was cancelled; whichever survives is whichever GitHub scheduled last, so the
  cancellation policy silently decides pass/fail. Worth calling out in the scaffolded workflow, or
  scoping the concurrency group to include the event name.
- **The scaffolded `.github/workflows/webpieces-pr-gate.yml` should ship with `types:` including
  `edited`** — it is the only thing that made the 08:27 run recover — but the docs should be explicit
  that it is a mitigation, not the mechanism.
- **Regression test:** simulate the race directly — write a body containing `HMAC(salt, PARENT_sha)`,
  then assert `wp-check-pr` against `HEAD_sha`. Today that is an unconditional red; under fix (1) the
  status is absent rather than wrong, and under fix (2) it retries. Testing only the happy path (body
  already correct) passes today and would keep passing with the bug intact.
- **Consumer-visible symptom to document:** "the gate check is red but `wp-finish-upsert-pr` said it
  passed" — the fix for a consumer today is `gh run rerun <id>`, which is not discoverable from the
  failure message. The message currently tells them to re-run the whole `wp-start`/`wp-finish` cycle,
  which is both unnecessary and (because it pushes again) reproduces the race.
