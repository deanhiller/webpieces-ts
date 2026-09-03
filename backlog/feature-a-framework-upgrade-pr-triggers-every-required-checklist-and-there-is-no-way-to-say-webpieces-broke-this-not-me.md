# FEATURE: a framework-upgrade PR triggers every REQUIRED checklist, and there is no way to say "webpieces broke this, not me"

**Package:** `@webpieces/pr-gate` (`checklist-detector.ts`), `@webpieces/rules-config` (`checklist-config.ts`)
**Version seen:** `0.4.720` (consumer landed on `0.4.723`)
**Reported from:** `ctoteachings/monorepo` (consumer), 7 checklists configured, upgrading 0.4.697 → 0.4.720
**Severity:** Medium — nothing is unsafe, but every framework upgrade pays a full review tax for a diff
the framework itself dictated, and no reviewer can find anything in it.

**Source:**
- `packages/tooling/pr-gate/src/scripts/workflow/checklist-detector.ts` — `roster()` / `detect()`, which
  match on CHANGED FILE PATHS and nothing else
- `packages/tooling/rules-config/src/checklist-config.ts:8-27` — `ChecklistDefinition.required`, whose
  own doc comment says an optional reviewer that is spawned and comes back red blocks exactly like a
  required one

---

## What happened

Upgrading a consumer from `0.4.697` to `0.4.720` is one line — the `&wp` YAML anchor in
`pnpm-workspace.yaml`. But 0.4.720 moved two framework symbols, so the consumer had to follow:

| Release change | Consumer edit forced |
|---|---|
| `Filter` / `Service` moved `@webpieces/http-routing` → `@webpieces/core-util` | 2 files, import line only |
| `LogApiCall` (process global) → `LogApiCallImpl` (ApiCallContext is now a ctor arg) | 6 files, import line + one module-scope `const` |
| `runtime-architecture.allowedCycles` removed from the config schema | delete one key (ours was `[]`) |

Net consumer diff: **8 `.ts` files, all import-line churn, zero behaviour change** — plus the four
version-carrying root files (`pnpm-workspace.yaml`, `pnpm-lock.yaml`, `webpieces.config.json`, and the
generated `.claude/webpieces/ai-hook.sh`).

Those 8 files then fired **4 REQUIRED checklists**:

```
api-contract-reviewer      5 files matched "libraries/apis/**"
security-auth-reviewer     5 files matched "libraries/apis/**"
server-patterns-reviewer   3 files matched "services/server/**", "libraries/node/**"
error-handling-reviewer    8 files matched "**/*.ts"
```

Measured cost of that one round: **185.4k tokens** (48.6k + 47.2k + 43.0k + 46.0k) and 71s of agent
time, to review a diff whose entire content is *"webpieces renamed a symbol; we followed."* None of the
four could have found anything: no DTO changed, no route changed, no auth annotation changed, no
`try`/`catch` changed, no Firestore document shape changed.

**One thing that is NOT wrong, checked before filing:** mid-run the owner asked to re-target `0.4.723`
instead of `0.4.720`. Moving HEAD does NOT re-charge the bill — `wp-review-upsert-pr` reported all four
verdicts as *"already reviewed on this branch; verdict STANDS, do NOT re-spawn"* and spawned nothing.
Reviews are once per branch by design. So the cost below is paid once per upgrade, not once per bump.

## Why the existing knobs do not cover it

- **`required: false` is not the escape.** Its own doc comment is explicit that it governs whether the
  reviewer must RUN, not whether its verdict counts, and that an optional reviewer actually spawned and
  red blocks finish exactly like a required one. It also cannot be set per-diff — it is a property of the
  checklist, so downgrading `error-handling-reviewer` to optional to survive upgrade PRs would downgrade
  it for every real PR too.
- **`patterns` cannot express it.** `ChecklistDetector` matches file PATHS. The 8 files here are the same
  8 files a genuine feature would touch; what differs is WHY they changed, which no glob can see.
- **A pure-bump diff already fires nothing, and that is the tell.** Had the release forced no consumer
  edits, the diff would be only the four root files, none of which match any configured pattern, so zero
  checklists would fire. The behaviour is already correct for the trivial case — it is exactly the
  API-break case, the one where the framework caused the churn, that costs the most.
- **`excludePaths` is the wrong axis** — those files are not excluded from review in general, only from
  *this* review.

## What we are asking for

Three candidate shapes, ranked. All of them need to preserve the property the gate exists for: **the
coding agent must not be able to self-certify.** A blanket `skipChecklists: true` config key, or a
`--skip-reviewers` flag on `wp-review-upsert-pr`, is NOT acceptable — an agent that hits a red reviewer
would reach for it, and the distinct-subagent guarantee dies quietly.

### 1. Ship the codemod, and let webpieces vouch for its own output (preferred)

The release already knows what it moved — `LogApiCall` → `LogApiCallImpl`, `Filter`/`Service` → another
package, `allowedCycles` deleted. Every consumer on earth writes the same edit by hand and then pays four
reviewers to read it.

Let `pnpm wp-upgrade` (or an extended `wp-upgrade-shim`) apply the migration itself, and record what it
did in a machine-written manifest — old version, new version, and a per-file list of the exact rewrites.
`wp-review-upsert-pr` then skips a checklist when **every** file it matched is accounted for by that
manifest, and reports the skip with its reason:

```
▶ api-contract-reviewer — SKIPPED (5 matched files are all framework-migration rewrites
                                    recorded by wp-upgrade 0.4.697 → 0.4.720)
```

The manifest is written by webpieces, not by the agent, which is what makes it un-forgeable in the way
that matters. Any file the agent touched beyond the codemod's own rewrites falls outside the manifest and
fires the checklist normally, so a "sneak a real change into the upgrade PR" diff is still fully reviewed.

### 2. A verified diff-shape predicate: `frameworkUpgradeOnly`

Weaker but far cheaper to build, and needs no codemod. The gate computes, per matched file, whether the
diff hunks are confined to (a) `import`/`export` specifiers naming an `@webpieces/*` module, and (b)
identifier renames from a table the release publishes. If every matched file passes, the checklist is
skipped with the same explicit reason line. Still machine-decided, still un-forgeable by prose.

### 3. Human-authorized, per-run exemption

If neither of the above is buildable soon: allow the *human* — never the agent — to mark a run as a
framework upgrade, via the existing `wp-authorize` path rather than a config key. Weakest option, because
it puts a human back in a loop the gate exists to keep them out of, and it is unavailable to unattended
runs (`/full-cycle`), which is precisely where the 185k-token bill lands hardest.

## What is NOT broken

- The gate is not bypassed and never was — all four reviewers ran and passed.
- `ChecklistDetector.roster()` correctly reports skipped-vs-never-configured; nothing here is silent.
- The four version-carrying root files correctly fire nothing on their own.
- Verdicts are reused across iterations of the same branch, so re-bumping the target version costs no
  extra reviewer tokens. An earlier draft of this report claimed otherwise; that claim was wrong and is
  removed.
