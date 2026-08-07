# FEATURE: `pr-gate.checklists[]` — a diff-triggered extension point for company review processes

**Package:** `@webpieces/rules-config` + `@webpieces/pr-gate`
**Requested by:** the `acme-internal/consumer-monorepo` consumer (`/Users/deanhiller/workspace/acme/consumer-monorepo2`)
**Why it matters:** adopting the webpieces gated flow silently **disabled** that repo's existing PR-time review trigger, and webpieces currently offers no supported way to put it back.

> Note: this is authored in `webpieces-ts30` because `webpieces-ts40` is busy with other work. Same
> project, different checkout — reconcile before implementing if the two have diverged.

## The problem, concretely

The consuming repo had a company review process wired into two Claude Code hooks:

- `.claude/hooks/pre-commit-review.sh` on `git commit` — maps staged paths to `.claude/review/checklist-*.md` checklists and returns `permissionDecision: deny` with `additionalContext` naming the docs the AI must read.
- `.claude/hooks/pr-quality-gate.sh` on `gh pr create` — the same idea at PR time.

The second one is now **dead code**. `pr-creation-or-push-guard` blocks `gh pr create` outright, so the hook's trigger command never runs. Nobody removed the gate; its trigger disappeared. That is a webpieces-adoption regression, and every consumer that had a `gh pr create`-triggered gate has the same silent hole.

**What is missing is a way to say: "when the diff touches X, make the AI read doc Y before it writes review.json, and refuse to open the PR until it acknowledges."**

## Why the existing surface cannot express this

I checked every extension point:

| Surface | Why it doesn't work |
|---|---|
| `pr-gate.gates[]` | Purely visual. The class comment says it outright: *"warningColor is purely visual — even 'red' never fails/blocks the PR (only the build gate can)"*. Also path-glob only. |
| `pr-gate.buildCommand` | The only configurable blocker, but it is one opaque shell string run **twice** (advisory in `wp-start-upsert-pr`, authoritative in `wp-finish-upsert-pr`). To behave differently per phase a consumer must sniff `ps -o args= -p $PPID` to tell which bin invoked it — a hack that breaks silently the moment `build-affected.ts` changes how it spawns. Exit-code-only, so no BLOCK/WARN distinction. |
| `commands.upsertPr` / `mergeComplete` | Hint strings printed in guard messages. Nothing executes them. |
| `rulesDir` custom rules | `scope: 'bash'` could intercept the literal `wp-finish-upsert-pr` command, but that fires *before* review.json is read and is Claude-hook-local — same bypass surface, worse position. |
| `match-rules` | Declarative regex content guards; cannot participate in the PR flow. |
| `rules-config/templates/*.md` | Rewritten by `writeTemplate` (not `writeTemplateIfMissing`) on **every** `wp-*` run, so consumer edits are clobbered. |
| `reviewJsonSchemaHint` | Hardcoded. It is the only text the AI gets about what to write, and it cannot be conditioned on the diff. |

## Proposed API

### 1. `packages/tooling/rules-config/src/checklist-config.ts` (new)

```ts
export const CHECKLIST_BLOCK = 'BLOCK';
export const CHECKLIST_WARN = 'WARN';
export const CHECKLIST_SEVERITIES = [CHECKLIST_BLOCK, CHECKLIST_WARN];

// A company review checklist, triggered by what the branch actually CHANGED.
export class ChecklistDefinition {
    id: string;                 // stable key echoed in review.json, e.g. "migrations"
    title: string;              // dashboard label
    patterns: string[];         // path globs, same semantics as GateDefinition.patterns; [] = any file
    contentPatterns: string[];  // regexes matched against ADDED diff lines only; [] = path-only trigger
    docs: string[];             // repo-relative docs the AI MUST read before writing review.json
    severity: string;           // 'BLOCK' | 'WARN'
    blockMessage: string;       // consumer-owned wording shown when it blocks
    disabled: boolean;          // same convention as GateDefinition.disabled

    constructor(id: string, title: string, patterns: string[], contentPatterns: string[],
                docs: string[], severity: string, blockMessage: string, disabled = false) { /* assign */ }
}
```

`contentPatterns` is not optional cleverness — the consumer's real detector keys on *added lines*
(`@Post(`, `@Cron(`, `CloudTasksClient`), which `GateDefinition.patterns` structurally cannot express.

### 2. `pr-gate-config.ts`

Add `checklists: ChecklistDefinition[]`, defaulting to `[]`. **`PrGateConfig`'s constructor is positional**, so this touches the constructor, `buildPrGateConfig`, `defaultPrGateConfig`, and every construction site. Absent config ⇒ `[]` ⇒ behavior byte-identical to today.

Mirror the existing `toGate` with a `toChecklist`.

### 3. `review-json.ts`

```ts
export class ChecklistAck {
    id: string;
    acknowledged: boolean;   // "I read the doc and walked every item"
    notes: string[];         // per-item findings
}

export class ReviewJson { /* existing 8 fields */ checklists: ChecklistAck[]; }

// What the caller computed from the diff — drives validation AND the printed schema hint.
export class RequiredChecklist { id: string; title: string; severity: string; docs: string[]; blockMessage: string; matchedFiles: string[]; }

// Signature change, back-compatible via the default:
loadReviewJson(filePath: string, required: readonly RequiredChecklist[] = []): ReviewJson
reviewJsonSchemaHint(filePath: string, required: readonly RequiredChecklist[] = []): string
```

Validation folds into the existing `errors[]` accumulation so the AI gets **one** message listing everything:

- every `required` entry with `severity === 'BLOCK'` must appear in `checklists[]` with `acknowledged: true`
- unknown ids in `checklists[]` are ignored (forward-compat)
- `WARN` entries are never validated — absence just renders a yellow row
- error text = the consumer's `blockMessage` verbatim + the doc paths, so the consumer owns the wording and webpieces owns the mechanism

`reviewJsonSchemaHint` grows a section **only when `required` is non-empty**, so nothing changes for repos not using it. This is the real prize: conditional, diff-derived instructions injected at exactly the moment the AI writes `review.json`, instead of static text it learns to skip.

### 4. `packages/tooling/pr-gate/src/scripts/workflow/checklist-detector.ts` (new)

```ts
export class TriggeredChecklist { def: ChecklistDefinition; matchedFiles: string[]; matchedContent: string[]; }

@injectable(bindingScopeValues.Singleton)
export class ChecklistDetector {
    detect(defs: readonly ChecklistDefinition[], changedFiles: readonly string[], addedLinesByFile: ReadonlyMap<string, string[]>): TriggeredChecklist[];
    toRequired(triggered: readonly TriggeredChecklist[]): RequiredChecklist[];
}
```

**Reuse `DiffScope` (`rules-config/src/diff-scope.ts`) — do not add new git plumbing.** It already has `detectBase`, `resolveBase`, `getChangedFiles`, `getFileDiff`.

⚠️ **Trap:** `ChangedFilesOptions.tsOnly` **defaults to `true`** and also drops test files. Checklists key on `*.sql`, `*.gql`, `Dockerfile`, `.env*`, `hasura/metadata/**` — every one of which `tsOnly: true` discards. The detector must pass `tsOnly: false` explicitly, and that deserves a comment, because the default silently produces "no checklists triggered".

For `contentPatterns`: `getFileDiff(root, file, base)` per changed file, keep lines starting `+` excluding `+++`.

### 5. One glob matcher, not three

`Dashboard` has a **private, hand-rolled** `globToRegex` + `matchesAny` (`dashboard.ts:205`), while `exclude-paths.ts` uses `minimatch`. Adding a third implementation for checklists guarantees drift — a pattern that flags a gate but not a checklist, or vice versa, with no error.

Extract the matcher into `rules-config` and have `Dashboard.computeGateResults` and `ChecklistDetector` share it. Decide deliberately whether the shared one is minimatch-based or the existing hand-rolled one; changing gate semantics is a behavior change and needs its own test pass.

### 6. Wiring

`start-upsert-pr-command.ts` — after the advisory build gate, before the handoff:

```ts
const cfg = loadAndValidate(repoRoot).prGate;
const required = this.checklistDetector.toRequired(this.checklistDetector.detect(cfg.checklists, changed, addedLines));
// ... reviewJsonSchemaHint(reviewPath, required)
```

`finish-upsert-pr-command.ts` — same computation, then `loadReviewJson(reviewJsonPath(...), required)`. An unacknowledged BLOCK throws `InformAiError` **before** `gh pr create`, matching the guarantee `buildCommand` already provides.

`dashboard.ts` — one row per triggered checklist, so the acknowledgment lands in the PR body:

```
**Checklist — DB migrations:** 🟡 WARN — acknowledged
**Checklist — Hasura metadata:** 🔴 BLOCK — acknowledged
```

This matters beyond cosmetics: `.webpieces/` is gitignored in consuming repos, so the **rendered PR body is the only artifact of the local flow that ever reaches a server**. Anything CI might later want to verify has to be visible there.

### 7. Validation (`validate-config.ts`)

Inside `validatePrGateSection`, beside the existing `gates` block, following the per-index `validateGate(gates[i], i)` error style:

- `id` non-empty and unique across checklists
- `severity` ∈ `CHECKLIST_SEVERITIES`
- `severity: BLOCK` requires a non-empty `blockMessage`
- `docs` non-empty, and **each file must exist at load time** — a checklist pointing at a deleted doc is otherwise a silent no-op, which is exactly the failure mode this whole feature exists to prevent
- each `contentPatterns` entry compiles as a `RegExp` — report the bad pattern, don't throw

## Consumer config this enables

```json
"checklists": [
  { "id": "migrations", "title": "DB migrations",
    "patterns": ["**/migration*/**/*.ts", "**/migration*/**/*.sql"], "contentPatterns": [],
    "docs": [".claude/review/checklist-migrations.md"],
    "severity": "BLOCK", "blockMessage": "Walk the migration checklist before opening this PR.", "disabled": false },
  { "id": "hasura", "title": "Hasura metadata",
    "patterns": ["**/hasura/metadata/**", "**/hasura/migration/**"], "contentPatterns": [],
    "docs": [".claude/review/checklist-hasura.md"], "severity": "BLOCK", "blockMessage": "...", "disabled": false }
]
```

## Tests

- `checklist-detector.spec.ts` — path-only trigger; content-only trigger; both; `disabled: true` skipped; no match; **non-`.ts` files trigger** (the `tsOnly` trap); `contentPatterns` ignores `+++` header lines.
- `review-json.spec.ts` — BLOCK unacknowledged throws; acknowledged passes; `acknowledged: false` throws; WARN absent passes; unknown id ignored; **`required: []` produces byte-identical output to today**.
- `validate-config.spec.ts` — duplicate id; bad severity; BLOCK without `blockMessage`; missing doc file; uncompilable regex.
- A dashboard snapshot with zero checklists, to prove non-adopting repos see no change.

## Out of scope (deliberately)

- **Identity / authorization.** `acknowledged: true` is written by the AI. This is a *surfacing and audit* mechanism, not an authorization one. A consumer needing real sign-off must use CODEOWNERS plus a required approving review on GitHub. Do not let this feature grow a `signOff` field that pretends otherwise.
- **Overridable templates.** Real and adjacent (`writeTemplate` clobbers consumer edits every run), but a separate change.
- **Server-side enforcement.** Everything here is local to a Claude Code session in that checkout. A human in a terminal or a cloud Claude session bypasses it entirely. Only a required GitHub check catches those.
