# Hard-coded `.webpieces/...` paths in a GENERATED template, and in two printed strings that had a resolver available

## Who asked and why

Dean, after being told `wp-cleanup` prints `.webpieces/logs/branch-mutations.log` as a literal:

> *"is it in *.md files!!!!!!  we should NEVER put paths there as all of our tooling RETURNS the
> CURRENT path so as they change, they are always correct."*

and, on the TypeScript hits:

> *"*.ts files is desired, right??? ie. as long as it uses code to calculate path!! it is the *.md
> files that are bad."*

**That distinction is the whole spec.** `.ts` is the CORRECT place for a path — provided it CALLS the
resolver. A string literal in `.ts` is the same defect as one in `.md`, just with a smaller blast
radius. `.md` is worse because the file persists, is regenerated into every governed repo, and is
handed to an AI by absolute path as instruction.

This is CLAUDE.md's own corollary, which was written from an incident where a copied `review.json`
path sent agents writing to a file nothing reads:

> *"webpieces owns the `wp-*` workflow, and this file must POINT AT it rather than restate it. Any
> path, filename or command output hand-copied into CLAUDE.md drifts out from under us silently on
> the next release."*

## Why the path is actually wrong, not merely fragile

`branch-mutations.log` is deliberately **per-worktree**, one writer each (`O_APPEND` is indivisible
only to `PIPE_BUF` = 512 bytes on macOS, and a `REAP_WORKTREE` `recover=` line exceeds that):

- primary clone → `.webpieces/logs/branch-mutations.log`
- linked worktree → `<primary>/.webpieces/worktrees/<name>/logs/branch-mutations.log`

So in a linked worktree the printed path **does not exist**. The reader `cd`s there, greps nothing,
and the silence reads like *"no deletions were logged"* — the opposite of the truth, from the one
file whose entire job is to prove every deletion is recoverable.

`BranchMutationLog.branchMutationLogPath(root)` already returns the right path for the tree it is
called in. Nothing needs inventing.

## What to change

### 1. The generated template — the real offender

`packages/tooling/rules-config/templates/webpieces.git-workflow.md:233` hard-codes
`` `.webpieces/logs/branch-mutations.log` ``. It is regenerated into
`.webpieces/instruct-ai/webpieces.git-workflow.md` on every `wp-*` command.

The template engine **already substitutes** — `webpieces.mergeprocess.md` uses `{{RUN_STATE}}`,
`{{FINISH_COMMAND}}`, `{{START_COMMAND}}`, `{{MERGE_DIR}}`, `{{FILE_LIST}}`, `{{SQUASH_BRANCH}}`,
`{{EXPLANATION_FILE}}`. Add a placeholder (e.g. `{{BRANCH_MUTATION_LOG}}`) rendered from
`branchMutationLogPath(root)` for the tree the doc is being written into. Follow whatever the
existing render path does; do not invent a second substitution mechanism.

### 2. The two printed strings — same defect, in `.ts`

- `packages/tooling/pr-gate/src/scripts/commands/cleanup-command.ts:175`
- `packages/tooling/pr-gate/src/scripts/commands/worktree-cleanup.ts:93`

Both concatenate the literal. Make both **call** `branchMutationLogPath(root)`. Dean's point stands:
the file type was never the problem — computing versus restating is.

While you are there, the flag-hint string #706 left (the one its error-output reviewer flagged
non-blocking, recorded in that PR's `risks`) names the same literal. Fix all of them in this pass so
there is one spelling; fixing one of three is what made the reviewer's note declinable last time.

### 3. A rule so the next one cannot land

Nothing enforces this today, which is why one sat in a template. Add a check that FAILS on a literal
`.webpieces/` path inside `packages/tooling/rules-config/templates/**/*.md`.

Follow this repo's conventions for where an invariant rule lives — it is a `webpieces.config.json`
engine rule (mode / epoch / disableAllowed), **not** an eslint rule. **Do NOT add the live
`webpieces.config.json` entry in this PR** — the running validator is a release behind and will
reject an unknown key, deadlocking the session. Ship the source + defaults; the config entry is a
follow-up after publish. Read the "Adding a code rule checklist" conventions and the
"webpieces.config.json is NEVER released backwards-compatible" section of CLAUDE.md first.

Scope the rule to templates. Do **not** widen it to `backlog/**` (frozen records of past requests —
rewriting them falsifies the record) or to `docs/tooling-logs.md` (a table of stream NAMES and their
source files, which is correct as written).

## Explicitly OUT of scope

- `docs/tooling-logs.md:101,108` and `ai.logging.md:7` — these name the FILE, not a path. Dean:
  *"that is ok probably but still a bit risky."* Leave them; note them in the PR body so the judgement
  is on the record rather than silent.
- The five `backlog/*.md` hits — historical request records. Do not touch.

## Definition of done

- `grep -rn '\.webpieces/logs/branch-mutations\.log' packages/tooling/rules-config/templates` returns
  nothing.
- The generated `.webpieces/instruct-ai/webpieces.git-workflow.md` shows the path for the tree it was
  written into — verified for a primary clone AND for a linked worktree, with a spec pinning both.
- `wp-cleanup`'s deletion/removal/flag-hint messages print the resolved path, not a literal.
- The new rule fires on a literal `.webpieces/` path added to a template, and has a spec proving it.
- No `webpieces.config.json` edit in this PR.
- No second spelling of anything left behind (CLAUDE.md backwards-compatibility rule).

## Release note

Ships from `@webpieces/*`, so it only changes what a governed repo sees after publish +
`pnpm install`. Verify with the packages' own vitest suites, not by running the installed bins.
