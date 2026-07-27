# BUG: `finish-upsert-pr` assumes auto-merge is allowed — breaks on repos with `allow_auto_merge: false`

**Package:** `@webpieces/pr-gate`
**Where:** `packages/tooling/pr-gate/src/scripts/commands/finish-upsert-pr-command.ts` (line 132)
**Severity:** High — on any consuming repo that **deliberately disallows auto-merge**, the merge
call errors out, the PR is left un-queued and un-stamped, and a later manual UI merge lands the
internal `Squash merge of <branch>` subject in `main`'s history instead of the PR title. Many orgs
turn auto-merge off on purpose as a policy control; the tool must not require it.

**Already fixed in `webpieces-ts30`** — see "Reference implementation" below. This is a port.

## The bug

`finish-upsert-pr-command.ts` line 132 unconditionally enables auto-merge, with no fallback:

```ts
spawnSync('gh', ['pr', 'merge', baseBranch, '--auto', '--squash'], { stdio: 'inherit' });
```

If the repo has `allow_auto_merge: false`, `gh` fails with:

```
GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)
```

`spawnSync`'s status is never checked, so `finish` prints its normal "✅ PR finished" summary and
exits 0. The failure is invisible unless you read the scrollback.

The published `0.4.450` line makes the consequence worse — it moved the commit subject/body onto
that same `--auto` call:

```ts
gh pr merge <branch> --auto --squash --subject "<PR title> (#N)" --body-file merge-commit-body.md
```

so on a manual-merge repo the subject/body are **never registered at all**. GitHub then falls back
to the repo's `squash_merge_commit_title` default, which for `COMMIT_OR_PR_TITLE` means the branch's
internal squash commit subject.

## Observed impact (consuming repo)

Repo: **`/Users/deanhiller/workspace/onetablet/monorepo-nx2`** → `mealco-internal/monorepo-nx`,
which has `allow_auto_merge: false` **by policy**.

PR #702 ("Upgrade webpieces 0.4.435 → 0.4.450") ran `wp-finish-upsert-pr` at 11:16:20, which wrote
a correct `.webpieces/pr-review/<branch>/merge-commit-body.md`:

```
Risk: 🟨🟨🟨⬜⬜⬜⬜⬜⬜⬜ 30/100 🟡 (yellow)
Flags (non-green): …
PR: https://github.com/mealco-internal/monorepo-nx/pull/702
```

…then the `--auto` call errored. The PR timeline shows **no** `auto_merge_enabled` event, only
`merged` 27 minutes later — a manual UI merge. What landed in `main`:

```
commit 733628b…
    Squash merge of dean/webpieces-upgrade (#702)

    Co-authored-by: Dean Hiller <deanhiller@Deans-MacBook-Pro.local>
```

The rendered risk/flags body was written to disk and thrown away. Reproduced again on PR #707:
`wp-finish-upsert-pr` printed `GraphQL: Auto merge is not allowed for this repository` and still
reported success.

## Reference implementation (already done in `webpieces-ts30`)

`webpieces-ts30` at `packages/tooling/pr-gate/src/scripts/commands/finish-upsert-pr-command.ts`
lines 148–169 solves exactly this: **merge directly with the explicit subject/body, and only fall
back to auto-merge when a direct merge isn't possible yet.**

```ts
const ref = this.prRef(baseBranch);
const subject = ref.number !== '' ? `${title} (#${ref.number})` : title;
const mergeBodyFile = path.join(prDir, 'merge-commit-body.md');
fs.writeFileSync(mergeBodyFile, this.dashboard.renderCommitBody(input, ref.url) + '\n');

// A direct `gh pr merge --squash --subject --body-file` writes exactly this subject/body to main's
// history regardless of the repo's squash_merge_commit_title/message defaults — and does NOT depend
// on allow_auto_merge.
const direct = spawnSync('gh', ['pr', 'merge', baseBranch, '--squash', '--subject', subject, '--body-file', mergeBodyFile], { stdio: 'inherit' });
if (direct.status !== 0) {
    // Not mergeable yet (required checks still running). Fall back to auto-merge carrying the SAME
    // subject/body. gh records them only when auto-merge is FIRST enabled, so disable-first re-stamps
    // on every re-run (harmless no-op when auto-merge is not enabled).
    spawnSync('gh', ['pr', 'merge', baseBranch, '--disable-auto'], { stdio: 'ignore' });
    spawnSync('gh', ['pr', 'merge', baseBranch, '--auto', '--squash', '--subject', subject, '--body-file', mergeBodyFile], { stdio: 'inherit' });
}
```

Porting that block is the fix. Note ts40 line 132 currently passes **neither** `--subject` nor
`--body-file`, so the port needs the `prRef` / `renderCommitBody` / `merge-commit-body.md` plumbing
too, not just the direct-vs-auto branch.

## Design question the porter should settle first

The ts30 fix makes `wp-finish-upsert-pr` **merge the PR itself** whenever it is already mergeable.
On a repo that disallows auto-merge *as a policy control*, that may be exactly what the policy was
meant to prevent — the objection is often "no merge without a human clicking", not narrowly "no
GitHub auto-merge queue". Worth confirming the intent before porting as-is. Three options:

1. **Port ts30 verbatim** — direct merge, auto-merge fallback. Best commit messages; `finish` now
   merges.
2. **Never merge; stamp only** — skip both merge calls, and write the compact
   `renderCommitBody(...)` into the **PR body** instead. With the repo set to
   `squash_merge_commit_message=PR_BODY` + `squash_merge_commit_title=PR_TITLE`, a manual UI merge
   then produces the right subject and body with no merge performed by the tool. Preserves
   "a human clicks merge".
3. **Make it configurable** — a `webpieces.config.json` knob (e.g. `pr-gate.mergeMode:
   "direct" | "auto" | "none"`), defaulting to whichever of the above matches the repo's
   `allow_auto_merge`.

Independent of which is chosen, two things are bugs on their own and should be fixed regardless:

- **Check `spawnSync(...).status`.** The current code ignores it, so a failed merge call is
  reported as success. This is what hid the problem for weeks.
- **Detect the condition explicitly.** `gh api repos/{owner}/{repo} --jq .allow_auto_merge` is one
  call; branching on it beats discovering it via a GraphQL error string.
