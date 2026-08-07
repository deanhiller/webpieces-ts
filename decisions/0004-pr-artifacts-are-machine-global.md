# 0004 — An artifact belongs to the scope of the fact it describes

**Status:** taken and implemented (PR merge bodies)
**Measured:** 2026-08-07, macOS (darwin 25.3.0), git 2.x
**Implements:** [0001](0001-tree-identity-and-governance.md) § D1 (partially), § D3 (in full), § O3 (partially)
**Where:** `packages/tooling/rules-config/src/machine-state-home.ts`,
`packages/tooling/rules-config/src/pr-body-store.ts`,
`packages/tooling/rules-config/src/aged-tree-sweep.ts`,
`packages/tooling/pr-gate/src/scripts/workflow/merge-body-filer.ts`,
`packages/tooling/pr-gate/src/scripts/commands/land-pr-command.ts`

---

## 1. The incident

`pnpm wp-land-pr` squash-merges a branch's PR with `gh pr merge --subject --body-file`, passing the
compact risk/flags body that `wp-finish-upsert-pr` rendered into `merge-commit-body.md`. That file was
located through `prDirFor()` → `ReviewJsonService` → `DotWebpieces.localFile(...)`, i.e.
`<primary>/.webpieces/worktrees/<name>/pr-review/<branch>/` — **per-worktree state**.

The gated flow ran in the primary clone. Landing happened from a linked worktree. `wp-land-pr` looked
under the worktree's namespace, found nothing, and printed **"Nothing to land — no rendered merge
body"** at a perfectly good PR. An agent worked around it by copying the directory across.

## 2. Why this is a scope mismatch, not a missing fallback

`pr-review/<branch>/` is keyed by BRANCH. A branch is a **repo-wide** fact — git forbids two worktrees
checking out the same branch — so a per-tree home for a per-branch artifact is correct only while the
branch never changes trees. Nothing enforces that, and the `wp-*` workflow actively encourages moving
work into worktrees.

Adding a search path would have "fixed" the symptom and left the real defect: **the artifact was stored
at a narrower scope than the fact it describes.** The rule this doc records is the general one:

> **Key an artifact by the scope of the fact it describes.**

Applied to the three scopes now in play:

| the fact | its scope | where it lives |
|---|---|---|
| in-flight merge, review.json, per-checklist verdicts, logs | ONE TREE | `DotWebpieces.local()` |
| which branches are merged, main-sync status + lock | ONE CLONE | `DotWebpieces.shared()` |
| **the gated commit body for PR #N** | **the REMOTE REPO** | `MachineStateHome` + `PrBodyStore` |

The body is not even the widest instance of its own scope — a PR is a fact of the remote, so in
principle it is shared across machines. This stores it per-machine, which is the largest scope reachable
without a network round-trip, and the refusal message says MACHINE for exactly that reason.

## 3. The layout

```
~/.webpieces/prs/<host>/<owner>/<repo>/<prNumber>/merge-commit-body.md
                                                  origin.json
```

**Keyed by the REMOTE, which 0001 § D2 explicitly rejects — for a different scope.** D2 rejects the
remote URL as the key for CLONE state because two clones of one repo have different branches, worktrees
and in-flight merges and must not share. That reasoning is intact. This is its mirror image: PR #604 is
the same object seen from every clone, and **sharing is the requirement** — landing must work from any
worktree and from a second clone. Two rules would be a contradiction; one rule, applied to two scopes,
is not.

**Nested, not flattened.** D2 flattens because it keys on an absolute PATH whose separators are data.
Here every segment is already a single opaque token (`github.com`, `deanhiller`, `webpieces-ts30`,
`604`). Nesting buys two things flattening cannot: a human debugging a landing can browse it, and the
retention sweep prunes a reaped PR's empty parents for free. Segments are sanitised to
`[A-Za-z0-9._-]`, and `.`/`..` are REFUSED rather than folded — folding them would key two distinct
repos to one directory.

**Not guessed.** A remote URL shape we do not recognise yields an UNKNOWN slug and nothing is stored. A
wrong key would file the receipt under a repo the PR is not on, which reads to the next reader as "the
body was never written" — i.e. it would reproduce the original bug while looking like a fix.

**`origin.json`** records the tree that posted the PR, its primary clone, the branch, the feature, the
PR number/URL and the timestamp. It is both the provenance § 5 needs and the marker 0001 § O3 planned.

## 4. The invariant that survived: the bytes that land are the bytes finish produced

`land-pr-command.ts` must never regenerate the body. It is the PRODUCT of the gate — re-deriving it at
land time would create a second authoritative gate whose result nobody reads, and it could silently
disagree with what was reviewed. Moving the file changed WHERE it is read from and nothing else.

Two consequences:

- **Hard cut, per CLAUDE.md.** Finish does not also write the old in-repo path, and land does not read
  it. Two homes for one receipt is two answers to "which bytes land", and the stale one wins in exactly
  the situation that broke — finish and land in different trees. When land finds a body left by the
  previous release it prints a LOUD one-time signpost naming the file, says it is deliberately not read,
  and tells the reader to re-run finish. Signpost, never fallback: the RETIRED_CONFIG_KEYS pattern
  applied to an artifact.
- **NOT FOUND fails, and says what is true.** "PR #N was not found on this machine", plus that the body
  is written by `wp-finish-upsert-pr` on the machine that posted the PR.

### 4.1 The fallback must not reach for the PR description

The first instinct was "fall back to the PR title AND description". **The description is exactly wrong.**
In a real consuming repo the PR description IS the full PR Gate Dashboard, and GitHub's default
`squash_merge_commit_message=PR_BODY` dumping that dashboard into the commit is the ugly git log this
entire mechanism exists to prevent (compare commit `533c82d` in the client repo with `f7384d2` here). A
fallback that used it would produce a WORSE commit than doing nothing, while looking more complete.

So the fallback is **PR title + PR link + a line saying the gated body was unavailable**, it is opt-in
behind `wp-land-pr --fallback-title-only`, the flag's `--help` text says a human must decide it, and the
commit body announces itself — an incomplete commit is self-identifying in `git log` forever.

## 5. The half that CANNOT be detached

`wp-land-pr` also does tree-bound bookkeeping: archive the pre-squash tip as `archive/<date>/<branch>`,
promote `merge-info/staged/<feature>` to `merged/`, and reap the landed worktree (`land-pr-command.ts`
records the incident where landing from a linked worktree always left a corpse).

That half belongs to the tree that holds the branch, and doing it from elsewhere is not merely useless,
it is WRONG: `<branch>` in a second clone is a different commit, so `archive/<date>/<branch>` would tag
the wrong objects under the right name, and `merge-info/staged/<feature>` lives in the posting tree's
state, not ours. So landing compares `origin.json`'s `treeRoot` against the tree it is standing in:

- same tree → archive + promote + reap, exactly as before,
- different tree → **merge, then decline the bookkeeping OUT LOUD**, naming the tree that owes it and
  printing `cd '<that tree>' && pnpm wp-cleanup`,
- no `origin.json` at all (only reachable via `--fallback-title-only`) → the pre-existing behaviour,
  because `base` came from THIS tree's HEAD, so this tree does hold the branch.

## 6. Retention (0001 § O3)

`~/.webpieces/prs/` outlives every clone: `rm -rf <clone>` will never reap it. `cleanTmp` — which
already runs at the end of every merge/PR flow — now sweeps it with the same 30-day policy it applies to
`.webpieces/`, from the same implementation (`AgedTreeSweeper`, extracted rather than copied, so the two
roots cannot drift). Age is sufficient HERE specifically: a landed PR's body is never rewritten so it
ages out, and an open PR's is re-stamped by every `wp-finish-upsert-pr` so it is never reaped mid-flight.

## 7. `WEBPIECES_STATE_HOME` and degradation (0001 § D3)

This is the first thing webpieces writes outside a repo, so it carries D3 in full:

- `WEBPIECES_STATE_HOME` is a **full override** — that directory IS the root, no `.webpieces` suffix and
  no per-repo nesting. It is the escape for a sandbox with no writable `$HOME`, and it is what makes the
  whole thing testable against a temp directory.
- `$HOME` is read from the ENVIRONMENT first and `os.homedir()` only after. On macOS `os.homedir()`
  falls back to the password database, so preferring it would both ignore a deliberately scrubbed
  environment and make `HOME=<tmp>` untestable.
- Writability is probed by actually creating the directory and writing a marker — a read-only mount, a
  sandbox denial and a permission error all present differently in `stat` and identically to a write.
- Anything unusable **degrades to `<primary clone>/.webpieces` and never throws**, because this sits
  under code on a hook's blocking path. The degradation is never silent: `StateHome.degraded` travels
  with the path, finish warns that the receipt is only visible from this clone, and land's refusal says
  so too. A receipt written into a clone is the thing that was broken to begin with.

## 8. `pr-merge-guard` was re-examined and LEFT BLOCKING

The guard blocks ANY `gh pr merge`, including a hand-rolled and apparently-correct
`gh pr merge --auto --squash --subject --body-file`. That was reconsidered here and kept, for reasons
that are now stronger than when it was written (the argument is in the guard's own doc comment, per the
"code comments point back here" rule):

- A `--body-file` proves a file was passed, never that it holds the GATED bytes. The guard sees a
  command string; it cannot know the PR number, so it cannot check the path against
  `~/.webpieces/prs/<host>/<owner>/<repo>/<n>/merge-commit-body.md`. Permitting the shape would let any
  file at all — including the PR description — land as the reviewed body, indistinguishably.
- `--fallback-title-only` is a human opt-in that STAMPS the degradation into the commit. A permitted
  hand-rolled merge is the same degraded outcome with no stamp and no opt-in, which makes the opt-in
  pointless.
- Landing now DECIDES whose bookkeeping this is (§ 5). A hand-rolled merge skips that decision
  silently, which is how a landed worktree becomes a corpse.

## 9. Rejected

| option | why not |
|---|---|
| **Have `wp-land-pr` search the old per-worktree path as a fallback** | Two homes for one receipt; the stale one wins exactly when finish and land ran in different trees. Replaced by the loud one-time signpost. |
| **Have `wp-land-pr` re-render the body** | A second authoritative gate whose result nobody reads, free to disagree with what was reviewed. The invariant in § 4 is the whole point of the command. |
| **Fall back to the PR title + DESCRIPTION** | § 4.1 — the description is a PR Gate Dashboard, and putting it in a squash commit is the exact defect this mechanism exists to prevent. |
| **Key the store by D2's flattened clone path** | Would keep landing clone-local, i.e. would not fix the bug for a second clone, and would fragment one PR's receipt across clones. |
| **Store it under `DotWebpieces.shared()` (repo-wide, inside the clone)** | Fixes the worktree case only. `git clean -xdf` and `rm -rf <clone>` still destroy it, and a second clone still cannot land. It is the fallback this degrades to, not the design. |
| **Perform the archive/reap from whichever tree lands** | Tags the wrong commit under the right name (§ 5). |
| **Relax `pr-merge-guard` for a `--body-file` merge** | § 8 — the guard cannot verify the bytes, and two of the mechanisms added here depend on the single sanctioned path. |
