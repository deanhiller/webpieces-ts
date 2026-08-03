# L4 — PR lifecycle

**Goal: does every merge and PR go through the gated flow?**

**Config key: `pr-lifecycle-guard` (proposed).** Today four keys, all pure boilerplate
(`mode` plus the two escape hatches, no real settings): `redirect-how-to-merge-main`,
`pr-creation-or-push-guard`, `pr-merge-guard`, `merge-in-progress-guard`.

**Code:** `ai-hook-rules/src/core/rules/{redirect-how-to-merge-main,pr-creation-or-push-guard,pr-merge-guard,merge-in-progress-guard}.ts`
· the flow itself in `pr-gate`.

> **STUB.** This layer is not yet tabled. What follows is what is known from analysing it alongside
> L0–L2; the table and use cases still need the same treatment L2 just received.

## The four guards and what each blocks

| guard | blocks | notably ALLOWS |
|---|---|---|
| `redirect-how-to-merge-main` | `git merge` and `git rebase` **in every form**, to protect the fork-point invariant | `--abort` / `--quit` (they UNDO, so cannot create a merge commit or rewrite history). `--continue` is deliberately blocked — it COMPLETES the operation. `--ff-only` is blocked too: *"a successful `--ff-only` IS the merge."* |
| `pr-creation-or-push-guard` | every direct way to push or open/update a PR, so the only path left is the gated flow — whose internal `git push` / `gh pr create` run as child processes the hook never sees | read-only `gh pr list`, `gh api …/pulls` GET. Its hint now BRANCHES ON INTENT: a push whose refspec targets the dev namespace/branch gets the `wp-push-dev` remedy, everything else the `wp-start-upsert-pr` one |
| `pr-merge-guard` | `gh pr merge` outside the flow | — |
| `merge-in-progress-guard` | a named list of commands while a merge marker is unvalidated | its hint RENDERS ITSELF from those lists |

## The three flows this layer protects

- **upsert-pr**: `wp-start-upsert-pr` ① → `wp-review-upsert-pr` ② → `wp-finish-upsert-pr` ③
- **update**: `wp-start-update` ① → `wp-finish-update` ② (② only needed on conflict)
- **dev-deploy**: `wp-push-dev` ① → `wp-finish-push-dev` ② (② only needed on conflict)

Stage ② is where verification happens: it fails on an unresolved merge or a red build BEFORE any
reviewer is spawned, records the sha it verified, and stage ③ skips its own build when HEAD has not
moved — three stages, one build.

### Why dev-deploy is a third flow and not a mode of the other two

Its DESTINATION is different, and that is the whole distinction the layer has to keep straight. The
first two flows exist to get work onto `main`; dev-deploy exists to get work onto a shared dev
environment **without** it. Folding it into the PR flow would mean opening a PR to main to answer a
question the dev environment exists to answer — the exact wrong-direction failure the guard hint was
rewritten to prevent.

Two consequences worth stating, because they look like omissions:

- **No build gate, deliberately.** The consumer's CI builds the *composed* tree (main + every published
  copy). A local build here would prove the branch compiles against `main` alone, which is not the
  question the shared environment is asking.
- **It does NOT invalidate an upsert-pr receipt.** It never touches the feature branch or the PR head,
  so nothing the receipt attests to has changed. (Contrast the known gap below: it is switching between
  the *other two* flows that silently loses verification, because both rewrite the branch.)

The state file is `.webpieces/push-dev-in-progress.json` (LOCAL scope). It is deliberately NOT under
`merge-info/`, so `merge-in-progress-guard`'s marker scan does not pick it up and send the AI at
`wp-finish-upsert-pr` — the wrong command, which would strand the throwaway branch. `PushDevStateStore`
does the blocking for it, and — per the lesson below — renders its hint from the blocked list.

## The lesson `merge-in-progress-guard` already learned

Its fix-hint used to hand-write "do not run other commands" — *"an unbounded claim that forbade the
reads, the `git add`, the build and the tests that finishing a merge actually requires, and that survived
every edit to these lists."* It now generates the sentence from the blocked lists so the two cannot drift
apart again.

**This is why L2 has a merge-in-progress row that stands down.** Finishing a merge requires reading and
writing exactly the files L2 would otherwise call stale. L4 owns that state; L2 defers to it.

## Known gaps, not yet fixed

- **A missing stage-② receipt BLOCKS, but a DRIFTED one only WARNS.** The BEHIND remedy banner walks
  through that gap: it tells the AI to re-run ① then ③, skipping ②, so the re-squashed merge is never
  validated and the reviewers' verdicts describe a pre-re-sync tree — yet a PR is still produced.
- **Only stage ① ever fetches `origin/main`.** ② and ③ never do; that is the freshness window the BEHIND
  verdict falls into. (The dev-deploy flow does not repeat this: `wp-finish-push-dev` refetches the
  remaining queue before resuming, because a long resolution session would otherwise rehearse a
  composition CI is not going to build.)
- **The two flows share no state.** The update flow writes no receipt, so switching flows mid-branch
  silently loses the verification the upsert-pr flow depends on.
- `git-validateUpToDate.ts` is a fully-written "behind → exit 1" hard gate with **zero call sites** —
  dead code and an attractive nuisance. Wire it in deliberately or delete it. It was considered and
  deliberately NOT wired into dev-deploy: staleness is structurally impossible there, since CI rebuilds
  the dev branch from `origin/main` on every run.

## Code anchors

| section | file | symbol |
|---|---|---|
| merge/rebase block | `ai-hook-rules/src/core/rules/redirect-how-to-merge-main.ts` | — |
| push/PR-create block | `ai-hook-rules/src/core/rules/pr-creation-or-push-guard.ts` | — |
| PR merge block | `ai-hook-rules/src/core/rules/pr-merge-guard.ts` | — |
| unvalidated-merge block | `ai-hook-rules/src/core/rules/merge-in-progress-guard.ts` | `blockedCommandList` |
| dev-deploy commands | `pr-gate/src/scripts/commands/{push-dev,finish-push-dev}-command.ts` | — |
| dev-deploy refs + invariant | `pr-gate/src/scripts/workflow/dev-deploy-refs.ts` | `assertPushable` |
| dev-deploy resolve machine | `pr-gate/src/scripts/workflow/dev-resolve-runner.ts` | `drain` |
| dev-deploy block list | `pr-gate/src/scripts/workflow/push-dev-state.ts` | `BLOCKED_DURING_RESOLVE` |
