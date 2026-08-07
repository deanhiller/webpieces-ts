# BUG: the `wp-start-upsert-pr` checklist message hands the AI a doc path it cannot resolve and a silently truncated matched-file list

**Package:** `@webpieces/pr-gate` (`start-upsert-pr-command.ts`), `@webpieces/rules-config` (`review-json.ts`)
**Version seen:** `0.4.479`
**Reported from:** `acme-edu/consumer-repo` — real session, 7 checklists, 1 triggered
**Severity:** Medium — the gate still gates. But this message *is* the AI's entire instruction set for
the review step, and three of its fields are wrong or lossy in ways the AI cannot detect: a doc path
that resolves to nothing, a file list truncated with no indication, and a subagent name nothing has
verified exists. Each one degrades review quality silently, which is the failure mode a review gate can
least afford.

**Source:**
- `packages/tooling/pr-gate/src/scripts/commands/start-upsert-pr-command.ts:130-139` — `printChecklistPlan()`
- `packages/tooling/rules-config/src/review-json.ts:185-192` — `reviewJsonSchemaHint()`
- `packages/tooling/rules-config/templates/webpieces.review-checklists.md` — the instruction template

Companion to [`bug-checklist-manifest-hidden-in-an-html-comment-instead-of-webpieces-config-json`](./bug-checklist-manifest-hidden-in-an-html-comment-instead-of-webpieces-config-json.md)
— defect ③ below is that report's row D arriving at the AI.

## What the AI actually received

Verbatim, from a real `pnpm wp-start-upsert-pr` on a diff touching `.github/workflows/webpieces-pr-gate.yml`:

```
Spawn EACH of these as a SEPARATE subagent (a different one per checklist — do not self-certify):
  • subagent "deploy-infra-reviewer" — reads deploy-infra.md  (matched: .github/workflows/webpieces-pr-gate.yml)
See .webpieces/instruct-ai/webpieces.review-checklists.md for the review-<id>.json format each must write.
...
  • [deploy-infra-reviewer] reviewer subagent: deploy-infra-reviewer
      write: /Users/…/.webpieces/pr-review/upgrade-webpieces-2/review-deploy-infra-reviewer.json
      doc to read: deploy-infra.md
      matched: .github/workflows/webpieces-pr-gate.yml
```

## ① `doc to read: deploy-infra.md` — not resolvable from where the AI stands

Both printers emit `t.def.doc` / `req.doc` raw. That value is relative **to the manifest doc**
(`checklist-manifest.ts:59` resolves it against `path.dirname(manifestDocPath)`), so the real file is
`.claude/review/deploy-infra.md`. The message never says so, and never names the manifest doc it is
relative to.

`write:` on the very next line is an **absolute** path. So a single four-line block mixes an absolute
path with a path relative to an unstated third location. There is no `deploy-infra.md` at the repo root
or in the CWD, so a subagent handed this string verbatim gets ENOENT and either gives up or starts
guessing with `find`. In this session I only got it right because the consumer's `CLAUDE.md` documents
that `doc` paths resolve relative to `index.md` — information the tool has and did not print.

**Fix:** print the resolved repo-relative path (`.claude/review/deploy-infra.md`). The resolution
already happens inside `ChecklistManifestService`; carry it onto `ChecklistDefinition.doc` rather than
re-deriving it at each of the two print sites.

## ② `matched:` is silently truncated — and to two different lengths

```ts
// start-upsert-pr-command.ts:137
process.stdout.write(`  (matched: ${t.matchedFiles.slice(0, 4).join(', ')})\n`);
// review-json.ts:190
lines.push(`      matched: ${req.matchedFiles.slice(0, 5).join(', ')}`);
```

No ellipsis, no `+N more`, no total. My diff matched one file so the truncation was invisible; a
`terraform/**` refactor touching 40 files renders as four filenames that look like the complete set.
The AI writes the reviewer's prompt from this line — that is precisely how a reviewer gets pointed at
4 of 40 files and returns `success: true` having reviewed a tenth of the change.

Two different caps for the same list in two blocks of the same output is its own small tell that
neither was chosen deliberately.

**Fix:** `slice(0, N)` + `` `, +${rest} more` `` when `rest > 0`, one shared helper, one cap. The full
set is already on disk in `pr-context.json` — say so on the line, since that file is what a reviewer
should actually enumerate.

## ③ The instruction names a subagent nothing has verified exists

`printChecklistPlan` prints `subagent "<name>"` straight from the manifest, and
`validateItems()` never checks `.claude/agents/<name>.md` is there (full evidence in the companion
report). So the strongest imperative in the whole message — `Spawn EACH of these as a SEPARATE
subagent` — can name something unspawnable. Because `wp-finish` then blocks on
`review-<that-name>.json`, the path of least resistance for the coding agent is to write the reviewer's
verdict itself, which is the exact self-certification the same sentence forbids. Fix belongs in the
validator; noted here because this is where it surfaces.

## ④ Smaller things, same message

- **The spawn instruction is in the imperative but the payload is elsewhere.** The AI is told to spawn
  reviewers, then told to go read `.webpieces/instruct-ai/webpieces.review-checklists.md` for what to
  put in their prompts (base sha, `pr-context.json`, the verdict schema, the no-self-certify rule).
  Everything a reviewer needs to be *given* is one indirection away from the instruction to give it.
  Inlining the three-line essentials — base sha, `pr-context.json` path, verdict file path — would make
  the printed block self-sufficient; the template stays as the long form.
- **`📂 Wrote PR diff context (1 changed file(s)) → …/pr-context.json`** prints *above* the checklist
  plan and is never referenced by it, so the connection between "here is the base sha and full file
  list" and "here is what to tell each reviewer" is left for the AI to infer.
- **`(matched: …)` does not say what matched.** It lists files but not the glob that fired, so a
  reviewer cannot tell whether it was pulled in by a precise pattern or a broad `**` — useful context
  for judging how coarse the match was, and the template explicitly tells reviewers that matching *is*
  deliberately coarse.

## Suggested shape

```
Spawn EACH as a SEPARATE subagent (a different one per checklist — do not self-certify).
Give each: its doc, the base sha, and the files it matched.

  • deploy-infra-reviewer
      doc:      .claude/review/deploy-infra.md
      matched:  .github/workflows/webpieces-pr-gate.yml   (pattern ".github/workflows/**")
      diff:     git diff 7d39562 HEAD -- <file>     (full set: .webpieces/pr-review/<branch>/pr-context.json)
      verdict:  .webpieces/pr-review/<branch>/review-deploy-infra-reviewer.json
                { "id": "deploy-infra-reviewer", "success": true, "output": "…", "override": "" }
```

## Repro

```bash
# any repo with a checklist whose doc is set and whose patterns match >5 changed files
pnpm wp-start-upsert-pr
# ① "doc to read: <bare filename>" — no such file relative to CWD or repo root
# ② "matched: a, b, c, d, e" with no indication N more were dropped
```
