# BUG: `pr-gate.checklists[]` is enforced only inside a local Claude Code session — any other way of opening a PR skips every checklist silently

**Package:** `@webpieces/pr-gate` (schema in `@webpieces/rules-config`)
**Version seen:** `0.4.463` (present since checklists shipped in #472)
**Severity:** High — the gate's *stated* guarantee ("the PR will NOT open until you acknowledge it")
holds only for the one code path that runs `wp-finish-upsert-pr`. A human typing `gh pr create`, a
cloud Claude session, a web PR, or any CI-opened PR bypasses **every** BLOCK checklist with no error,
no warning, and nothing on the dashboard to show a checklist was skipped. The failure is silent and
indistinguishable from "no checklist was triggered."

**Source:**
- `packages/tooling/pr-gate/src/scripts/commands/finish-upsert-pr-command.ts:81-86` (the only enforcement point)
- `packages/tooling/rules-config/src/review-json.ts:235-250` (`requiredChecklistErrors`)
- `packages/tooling/nx-webpieces-rules/src/validation-targets.ts` (no checklist target exists)

Related but distinct: [`bug-no-file-import-cycles-has-no-path-exclusion-only-excludepackages`](./bug-no-file-import-cycles-has-no-path-exclusion-only-excludepackages.md)
is about a missing *config* surface. This one is about a missing *enforcement* surface.

## The bug

Enforcement lives in exactly one place — `finish-upsert-pr-command.ts:81-86`:

```ts
// 2. REQUIRE the AI-authored review.json (throws InformAiError with the schema if missing/invalid).
//    Compute the consumer checklists this diff triggered FIRST so an unacknowledged BLOCK throws
//    here — BEFORE any `gh pr create`, matching the guarantee buildCommand already provides.
const checklists = loadAndValidate(repoRoot).prGate.checklists;
const required = this.checklistDetector.toRequired(this.checklistDetector.detectForRepo(repoRoot, checklists));
const review = loadReviewJson(reviewJsonPath(repoRoot, this.aiBranchName.getFeatureName()), required);
```

That is a **local CLI command**. It reasons about `process.cwd()`, reads `.webpieces/pr-review/<branch>/review.json`
from the working tree, and then shells out to `gh pr create`. Nothing about it is reachable from, or
observable by, the server that actually receives the PR.

Three consequences follow directly:

1. **The bypass is trivial and undetectable.** `gh pr create` opens exactly the same PR with none of
   the checks. `.webpieces/` is gitignored in consuming repos, so no artifact of the local flow ever
   reaches the remote. A reviewer looking at the PR cannot tell whether checklists were walked,
   skipped, or never triggered.
2. **There is no discrete target to mark as a required check.**
   `packages/tooling/nx-webpieces-rules/src/validation-targets.ts` exposes eight factories —
   `noCycles`, `packageJson`, `code`, `versionsLocked`, `tsInSrc`, `nxWiring`, `apiRelations`,
   `apiLibTag`. `grep -rn "checklist" -i packages/tooling/nx-webpieces-rules/src/` returns **zero**
   hits. So a consumer cannot point a required GitHub check at "checklists were satisfied."
3. **Missing `docs:` paths fail as somebody else's error.** The existence assertion lives inside
   `loadAndValidate()` (`validate-config.ts:338-345`), which every executor and hook calls. A typo in
   `checklists[].docs` therefore surfaces as a `[pr-gate]` config banner thrown by, say,
   `validate-code` or `validate-no-file-import-cycles` — validators that have nothing to do with
   pr-gate. It fails loudly, which is right, but it fails *as the wrong check*, which makes the fix
   non-obvious and means the blast radius is "every webpieces command in the repo."

The upstream design doc concedes point 1 explicitly. From
`backlog/feature-pr-gate-checklists-extension-point.md`, "Out of scope":

> server-side enforcement — everything is local to a Claude Code session in that checkout; a human in
> a terminal or a cloud Claude session bypasses it entirely; only a required GitHub check catches those.

That was a reasonable scoping call for the first cut. This report argues the gap is now the dominant
failure mode, because it is **silent**: a repo can believe it has a BLOCK gate and have nothing.

## Measurement

Consuming repo: **`/Users/deanhiller/workspace/acme/consumer-monorepo2`** (an AI can read it directly).

The repo adopted checklists in PR #720 (2026-07-28 09:19), pointing at `.claude/review/checklist-*.md`.
They were removed 82 minutes later in PR #728 (10:41) for an unrelated reason — `loadAndValidate()`
ran inside `nx build` in containers that do not copy `.claude/`, so all 12 service builds went red.

From then until now the repo has run with:

```json
"commands": { "pr-gate": { "mode": "ON", "gates": [ ... ] } }   // no `checklists` key at all
```

**PR #734 in that repo was opened through the full, correct `wp-start-upsert-pr` →
`wp-finish-upsert-pr` flow, passed every gate, rendered a complete dashboard, and received no
checklist review whatsoever.** It touched 12 Dockerfiles, `nx.json`, and `webpieces.config.json` —
a diff that would have triggered the `envvars` checklist under the #720 config. The dashboard showed
green. Nothing anywhere indicated that a review process had silently stopped existing.

That is the shape of the problem: the difference between "configured and satisfied" and "not
configured at all" is invisible in the output. And the repo's *other* two checklist triggers had
failed the same silent way months earlier — `.claude/hooks/pr-quality-gate.sh` became unreachable
dead code the moment `pr-creation-or-push-guard` started blocking `gh pr create`, and nobody noticed
because nothing reports "a gate you configured did not run."

## Suggested fix

Two independent pieces. (1) is the small one and closes the "fails as the wrong check" problem;
(2) is the real fix.

### 1. A discrete `validate-checklist-docs` target

Add a ninth factory to `packages/tooling/nx-webpieces-rules/src/validation-targets.ts` and a matching
executor that validates *only* the pr-gate checklist block: `docs` paths exist, `contentPatterns`
compile, ids are unique, `blockMessage` present on BLOCK entries. The logic already exists in
`validate-config.ts:313-357` — the executor just calls it directly rather than letting it ride along
inside `loadAndValidate()`.

Two wins: a missing doc fails as `architecture:validate-checklist-docs` instead of as an unrelated
validator, and consumers get a cacheable target they can point a required check at.

### 2. `wp-check-pr` — enforcement that runs where the PR lands

A read-only command that takes the same `(repoRoot, base, head)` a CI runner has, recomputes the
triggered checklists, and verifies acknowledgement — without touching git state, pushing, or calling
`gh pr create`:

```ts
// packages/tooling/pr-gate/src/scripts/commands/check-pr-command.ts
async run(): Promise<void> {
    const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
    const checklists = loadAndValidate(repoRoot).prGate.checklists;
    const required = this.checklistDetector.toRequired(
        this.checklistDetector.detectForRepo(repoRoot, checklists));
    // Same validation wp-finish-upsert-pr performs, minus every side effect.
    loadReviewJson(reviewJsonPath(repoRoot, this.aiBranchName.getFeatureName()), required);
}
```

so a consumer can add:

```yaml
- name: Webpieces PR gate
  run: pnpm wp-check-pr        # required status check
```

**The artifact problem, stated honestly.** `.webpieces/` is gitignored, so `review.json` does not
reach CI, and `wp-check-pr` as written above would find nothing. Three ways out, in increasing order
of intrusiveness — this report does not pick one, because it is a product decision:

| Option | Cost |
|---|---|
| Un-gitignore `.webpieces/pr-review/<branch>/review.json` so the ack is committed | Review artifacts land in git history; merge conflicts on rebase |
| `wp-finish-upsert-pr` writes the ack summary into the PR body (it already renders `checklistRows` there) and `wp-check-pr` parses it back | No new files; but the PR body is user-editable, so the check is advisory-grade at best |
| `wp-finish-upsert-pr` posts a commit status / check-run via `gh api` at PR-open time | Real enforcement; needs a token with `checks:write` and only proves *the local flow ran*, not that it ran on the final commit |

The third is the only one that actually satisfies "a required check that cannot be bypassed by not
running the local flow," and even it needs a re-verification on every push, not just at PR open.

## Notes for whoever fixes it

- **Do not let `wp-check-pr` mutate anything.** `wp-finish-upsert-pr` currently interleaves
  validation with `assertCleanTree`, `ensurePushed`, the build gate, and `gh pr create`
  (`finish-upsert-pr-command.ts:64-113`). CI needs the validation half in isolation; extracting it
  is also the natural place to fix the fact that `loadAndValidate(repoRoot)` is currently called
  **three separate times** in that one command (lines 84, 129, 194), each re-running the full
  `fs.existsSync` docs sweep.
- **`detectForRepo` needs an explicit base/head in CI.** It derives its diff range from the shared
  `DiffScope` (`checklist-detector.ts:84-103`), which is tuned for a local branch vs `origin/main`.
  On a GitHub PR the useful range is the merge base of the PR, and on a `push` event it is
  `HEAD~1..HEAD`. Take them as parameters rather than inferring.
- **Keep `tsOnly = false`.** `checklist-detector.ts:90-94` already documents why: the default
  restricts to `*.ts`/`*.tsx` and drops test files, silently discarding every `.sql`, `.gql`,
  `Dockerfile`, `.env*` and metadata file a checklist most wants to key on. Any re-implementation in
  a new command will reintroduce this bug if it constructs its own `ChangedFilesOptions`.
- **The glob-matcher drift is still open.** The design doc asked for one shared matcher;
  `ChecklistDetector` uses `isPathExcluded` (minimatch) while `Dashboard.computeGateResults` keeps a
  hand-rolled `globToRegex`/`matchesAny`. A pattern can therefore flag a *gate* and not a
  *checklist*. A CI-side checker makes that divergence externally visible, so it is worth closing in
  the same pass.
- **Regression test:** a repo with a BLOCK checklist whose diff triggers it, and a `review.json`
  lacking the ack, must fail `wp-check-pr` with exit non-zero. Then assert the *silent* case
  explicitly — config with `checklists: []` and a diff that would have triggered one must be
  distinguishable in the output from config with a satisfied checklist. Today both render as green,
  which is the whole bug.
