# FEATURE: `CLAUDE.md` is a ~12k-token tax on every session and every reviewer — make it a routing index

**Package:** none — this is a repo-content change (`CLAUDE.md` + a new `.claude/rules/**`), plus one
`commands.pr-gate.checklists` pattern edit in `webpieces.config.json`.
**Requested by:** Dean, verbally, off the back of the `retbytes` collector landed in #742.
**Why it matters:** it is the single largest FIXED token cost in the system, and it is paid before
anyone reads a line of diff.

## The problem, measured

`retbytes`' `always_loaded_md` row, over a 72h window across 13 governed repos:

| repo | `CLAUDE.md` | approx tokens |
|---|---|---|
| `webpieces-ts50` (this one) | 48,386 chars | ~12k |
| `monorepo3` | 100,739 chars | ~25k |

For scale: the **largest guard message in the fleet** is ~1.9KB. `monorepo3`'s `CLAUDE.md` is ~50x that,
and unlike a guard message it is not paid once when something goes wrong — it is paid on **every**
session start, and again on **every** reviewer subagent the gate spawns.

## Why it matters beyond the token bill

Reviewer cost turns out to be almost entirely fixed overhead. On one framework-upgrade PR the four
required reviewers cost **48.6k / 47.2k / 43.0k / 46.0k** tokens against diffs of **5 / 5 / 3 / 8**
files. Nearly triple the diff for near-identical cost: what the reviewer actually reads is a rounding
error next to what it is handed before it starts. `CLAUDE.md` is a large, and growing, part of that
prologue — on every reviewer, on every PR.

The compounding shape is the problem, not the current number. Every incident this repo survives adds a
paragraph to `CLAUDE.md`, correctly (see "what is NOT broken" below), and every one of those paragraphs
is then billed to a `backwards-compat-reviewer` that will never look at an `experimental.*` flag.

## Why the existing surface does not cover it

| Surface | Why it doesn't work |
|---|---|
| Shortening the prose | Forbidden by the constraint below — the rationale IS the rule. |
| `pr-gate.checklists[].doc` | Already does exactly the right thing, for reviewers only. A checklist doc is read by the ONE subagent spawned for it. There is no equivalent for the main session, and no way for a reviewer to skip the part of `CLAUDE.md` that is not its subject. |
| Guard messages | Wrong lever. They are paid on a block, which is the moment the information is actually wanted. |
| Trimming guard messages instead | Measured as the smaller win by an order of magnitude, and a far less delicate edit. The two should never be scored together. |

## The ask

`CLAUDE.md` becomes a **routing index**: for each topic file, one line on what it holds and — the part
that does the work — **WHEN you would need to read it**, so a reviewer can decide *"not my diff, skip
it"* without opening the file. It keeps inline only the rules an agent must obey without being prompted
to go and look anything up, because by the time it knows to look it has already broken them: the
code-style principles, the one-line build rule, the one-line finish-the-feature rule, and the
"Common Mistakes to Avoid" list — which is itself already an index of failure modes.

Everything with a long rationale, a matrix, an incident narrative or a worked example moves to
`.claude/rules/*.md`.

This follows a precedent already half-built in this repo: `.claude/review/backwards-compatibility.md`,
`.claude/review/error-output.md` and `.claude/review/experiment-lifecycle.md` already hold the reviewer
detail, and `CLAUDE.md` already points at them ("full detail, with what to grep, in …").

## Why this is the file's own rule, applied to itself

`CLAUDE.md` § "Corollary for instructions generally" already says it:

> *"webpieces owns the `wp-*` workflow, and this file must POINT AT it rather than restate it."*

That corollary was written from an incident where a hand-copied `review.json` path sent agents writing
to a file nothing reads. It has been applied to every path in the file and never to the file's own
structure.

## What is NOT broken — the constraint that beats the size target

**This is a MOVE, not a rewrite.** No rule is reworded, condensed, modernized or summarized. Every rule
in that file is there because something went wrong, and several paragraphs name the live incident that
bought them:

- **PR #711** deleted `buildGateLogCapture` and made build-log capture unconditional; the owner's
  `~/.webpieces/config.json` said `true`, and after that release his opt-in silently meant nothing.
- **0.4.575** shipped with no `bin` at all in any of the four packages — every `wp-*` command gone —
  because the packaging change was verified against `pnpm pack` and not against what the release
  pipeline produces.
- **PR #585** deleted the `workspace:` dependency, and one release later `wp-ai-guards-hook` was gone
  from every consumer's tree.
- **Issue #589**: an agent wrote `@Authentication(new AuthenticationConfig(true))` — the widest possible
  grant — onto an admin contract, then asserted in a comment that the framework had no role support.

Those narratives ARE the rules. An agent obeys "never delete an experimental flag" far better when it
can see whose opt-in was silently voided. **Losslessness beats the size target**: if the target cannot
be hit without dropping a rule, stop short of the target and say so.

## The trap to close in the same change

`commands.pr-gate.checklists` registers required reviewers against **path patterns**, and
`experiment-lifecycle-reviewer` is registered over `packages/**`, `webpieces.config.json` **and
`CLAUDE.md`** — precisely because the experiment policy prose lives in `CLAUDE.md`.

Move that prose without re-pointing the patterns and a future PR editing the policy fires **no
reviewer**. That is a silent enforcement hole, and it is strictly worse than the token cost being
fixed. Every checklist naming `CLAUDE.md` must gain the `.claude/rules/**` paths that now carry its
subject matter — and `checklist-validator.spec.ts` pins that list exactly, so the spec is the thing
that goes red if a later change narrows it back.

Same rule for every doc that points INTO `CLAUDE.md` by section name (`.claude/review/*.md`,
`README.md`, `GUARD_MATRIX.md`, `pnpm-workspace.yaml`, `setupDebugging.md`, the audit skill): updated in
the SAME diff, exactly as `CLAUDE.md` demands for a deleted symbol.
