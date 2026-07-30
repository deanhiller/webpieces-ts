# BUG: the checklist manifest lives in an HTML comment inside a markdown doc instead of `webpieces.config.json` — unschemable, uneditable by tooling, and its one real invariant (the subagent exists) is never checked

**Package:** `@webpieces/rules-config` (`checklist-manifest.ts`, `validate-config.ts`, `pr-gate-config.ts`)
**Version seen:** `0.4.479` (introduced by f2e4519 — "Replace checklist array config with a single `{ doc }` manifest + distinct-subagent review" (#487))
**Reported from:** `ctoteachings/monorepo` (consumer), 7 checklists in `.claude/review/index.md`
**Severity:** Medium — nothing is silently bypassed (see "What is NOT broken"), but the configuration
surface is invisible to every tool that reads `webpieces.config.json`, and the one invariant the
manifest actually needs — that `subagent` names a real `.claude/agents/<name>.md` — is not validated,
which lets a typo hand the coding agent a checklist no reviewer can satisfy.

**Source:**
- `packages/tooling/rules-config/src/checklist-manifest.ts:18` — `MANIFEST_RE = /<!--\s*webpieces:checklists\s*([\s\S]*?)-->/`
- `packages/tooling/rules-config/src/checklist-manifest.ts:56-79` — `validateItems()`, the whole schema
- `packages/tooling/rules-config/src/pr-gate-config.ts:57-58,123-124` — `checklists.doc` is the entire config surface
- `packages/tooling/rules-config/src/validate-config.ts:325-341` — `validateChecklistsSection()`

Related: [`bug-pr-gate-checklists-have-no-ci-side-enforcement`](./bug-pr-gate-checklists-have-no-ci-side-enforcement.md)
— that one predates #487 and quotes the *old* `prGate.checklists` array-in-config shape, which is the
shape this report asks to restore. Also related:
[`bug-wp-start-upsert-pr-checklist-message-gives-the-ai-unresolvable-doc-paths`](./bug-wp-start-upsert-pr-checklist-message-gives-the-ai-unresolvable-doc-paths-and-silently-truncates-matched-files.md)
— the downstream half, where the un-validated `subagent` name is printed as an instruction.

## What is NOT broken (checked first, so this report is not chasing a phantom)

Before #487 the checklist array lived in `webpieces.config.json`. Moving it to a markdown comment
*sounds* like it should silently disable review on any typo. **It does not.** I probed the installed
0.4.479 against a scratch copy of a real 7-checklist repo, mutating `.claude/review/index.md` and
calling `loadAndValidate()` + `ChecklistManifestService.load()`:

| Mutation | `loadAndValidate()` | `load()` |
|---|---|---|
| A. pristine | OK | 7 checklists |
| B. malformed JSON (trailing comma) | **THREW** — "the `<!-- webpieces:checklists -->` block … is not a valid JSON array" | 0 |
| C. manifest block deleted | **THREW** — "has no `<!-- webpieces:checklists [...] -->` block" | 0 |
| D. `subagent` renamed to a name with no `.claude/agents/` file | **OK — no error** | 7, incl. the bogus one |
| E. marker typo `webpieces:checklist` (singular) | **THREW** — same as C | 0 |

So B/C/E fail loud, because `loadAndValidate()` reaches `validateChecklistsSection()` with a defined
`repoRoot` (`load-config.ts:80-87`) and that calls `ChecklistManifestService.validate()`. Credit where
due: the tolerant `load()` returning `[]` is never the thing the gate relies on. **Row D is the bug.**

## The bug, part 1 — `subagent` is validated for everything except the thing it names

`validateItems()` (`checklist-manifest.ts:56-79`) checks exactly three things: `subagent` is a non-empty
string, `subagent` is distinct across entries, and `doc` exists on disk. It never checks that
`.claude/agents/<subagent>.md` exists — even though its own error string at line 63 tells the reader
that is what the field means:

```ts
errors.push(`[pr-gate] ${docRel} checklists[${i}].subagent must be a non-empty string (the reviewer agent name, matching .claude/agents/<subagent>.md).`);
```

`doc` — the *optional* field — gets an existence check at line 71. `subagent` — the required field, and
the one the distinct-reviewer guarantee rests on — gets none.

The consequence is not cosmetic. `wp-start-upsert-pr` prints `Spawn EACH of these as a SEPARATE
subagent … • subagent "deploy-infra-revewer-TYPO"`, and `wp-finish-upsert-pr` then requires a passing
`review-deploy-infra-revewer-TYPO.json` before it will open the PR. No such agent can be spawned, so
the coding agent is left with two options: give up, or **write the reviewer's verdict file itself**.
The second is exactly the self-certification that `WORKFLOW.md` and the distinct-subagent rule exist to
prevent, and the manifest walks the agent into it. `SubagentProvenanceService.verifyDistinct()` is the
backstop here, but it degrades to a warning outside a Claude Code session (per the template's own
footnote), and "the backstop caught it" is a poor substitute for "the config was rejected at load."

## The bug, part 2 — the location itself

`pr-gate-config.ts:57-58` states the rationale: *"The checklist SET lives in that doc (content), never
here (config)."* From a consumer's chair the content/config split does not survive contact:

1. **It is not content.** `patterns: ["terraform/**", "scripts/.lib/**"]` is a path-glob dispatch table.
   `subagent` is a DI-style name binding. Those are config by any reading. The *prose* — what
   `deploy-infra.md` says to look for — is the content, and it already lives in a separate file per
   checklist. The manifest is the routing table pointing at the content, and it got filed with it.
2. **Nothing can read it.** `webpieces.config.json` is discoverable, greppable, and schemable. A JSON
   array inside `<!-- -->` inside markdown is reachable only by `MANIFEST_RE`. No JSON Schema can cover
   it, no editor completes it, no `jq` reads it, and a consumer writing repo tooling has to re-implement
   an HTML-comment scraper. In this consumer repo the manifest is also duplicated by hand into a
   human-readable markdown table directly beneath it, and into `CLAUDE.md` — three copies, one of them
   machine-read, with nothing keeping them in step.
3. **The error messages are already awkward about it.** They read
   `[pr-gate] .claude/review/index.md checklists[3].subagent must be…` — a `webpieces.config.json`-style
   dotted config path, prefixed with a markdown filename, pointing into a comment that has no line
   numbers a reader can jump to.
4. **It regressed a working shape.** #487 replaced an array that was already in config. The other half
   of #487 — the distinct-subagent rule — is good and is not what this report objects to; that rule
   works fine with the array in config.

## Asked-for fix

Accept the array in `webpieces.config.json` as the primary form:

```jsonc
"pr-gate": {
  "checklists": [
    { "subagent": "deploy-infra-reviewer",
      "doc": ".claude/review/deploy-infra.md",
      "patterns": ["terraform/**", "scripts/deploy-sha.sh", ".github/workflows/**"] }
  ]
}
```

Concretely:

- `validateChecklistsSection()` should accept **either** an array (new/restored) or `{ doc }` (keep it
  working, it is shipped) — it already branches on `Array.isArray`, and today that branch only produces
  the error `"checklists" must be an object { "doc": ... }`.
- With the array form, `doc` should resolve **repo-relative**, not relative to a manifest file that no
  longer exists. That also fixes the unresolvable bare `deploy-infra.md` the AI is handed downstream.
- **Independently of the location decision, add the existence check** — it is three lines next to the
  `doc` check at `checklist-manifest.ts:71`, and it is the actual defect:

  ```ts
  if (!fs.existsSync(path.join(repoRoot, '.claude', 'agents', `${item.subagent}.md`))) {
      errors.push(`[pr-gate] ${docRel} ${label}.subagent names no reviewer — .claude/agents/${item.subagent}.md does not exist.`);
  }
  ```

  (Gate it on the agents dir existing at all, so non-Claude-Code consumers are not broken.)

## Repro

```bash
# in a repo with pr-gate.checklists.doc set and >=1 checklist
sed -i '' 's/"deploy-infra-reviewer"/"deploy-infra-revewer"/' .claude/review/index.md
node -e 'const{loadAndValidate}=require("@webpieces/rules-config");loadAndValidate(process.cwd());console.log("no error")'
# → prints "no error"; expected a [pr-gate] error naming the missing .claude/agents/deploy-infra-revewer.md
touch terraform/x.tf && git add -A && git commit -m wip
pnpm wp-start-upsert-pr
# → 'Spawn EACH of these as a SEPARATE subagent: • subagent "deploy-infra-revewer"' — an agent that does not exist
```
