> # ✅ RESOLVED — fixed **2026-08-10** by #637. Kept as a forensic record only.
>
> Four of the five asks reproduced against local source and are fixed; ask 2 shipped under a different
> name than the report proposed; ask 4 was **already fixed** before this report was written. Each
> verdict below was established by driving the real exported functions and capturing their output,
> *before* any code was changed.
>
> | Ask | Verdict | Evidence |
> |---|---|---|
> | 1 — "Do NOT delete" is backwards | **REPRODUCED**, fixed | Banner emitted `Do NOT delete a key just because it is reported unknown — that is how valid config gets gutted.` Note it lives in `config-error-banner.ts`, **not** `load-config.ts`, which only delegates |
> | 2 — no mechanical cleanup | **REPRODUCED**, fixed | 17 `wp-*` bins, none pruned config; grep for `prune-unknown\|--fix\|stripUnknown` hit only *worktree* pruning |
> | 3 — fallback never says RETIRED / `~/.webpieces` | **REPRODUCED**, fixed | For an unknown `brand-new-rule` the message named neither |
> | 4 — name `~/.webpieces/config.json` when it fails | **ALREADY FIXED — no change** | All four failure modes already print `[~/.webpieces/config.json]` plus a resolved `File:` path, and never mention the repo config. A drafted wording tweak was reverted; regression tests pin it instead |
> | 5 — one run says both things about `pnpm install` | **REPRODUCED**, fixed | The `brand-new-rule` banner contained both strings ~4 lines apart |
>
> **The fix.** Deletion is now the primary cure, named in the banner and in `unknownRuleError`, and made
> mechanical by a new `wp-prune-unknown-config` bin (`ConfigPruner` in `rules-config`, CLI in
> `code-rules`). It ships as a dedicated bin rather than the report's proposed `--fix` /
> `--prune-unknown` flag because a flag on `wp-validate-code` would have to run *before* config load —
> the whole point is operating on a file that fails validation.
>
> **What resolved ask 5 is worth recording, because it is not obvious.** The two `pnpm install`
> instructions were not merely inconsistent; one of them was unreachable. The shim's version-drift guard
> denies every tool call *before* the validator runs, so a validation error appearing on screen is itself
> proof that the pin and `node_modules` already agree. The positive "run `pnpm install` first" was
> therefore always wrong at the moment it could be read, and was deleted; the banner's
> "Do NOT run `pnpm install`" is the correct survivor. The stale-pin case is demoted to a secondary note
> that explains *why the reader is not in it*.
>
> **A latent installer bug this work uncovered.** `migrateRetiredRuleNames` treated every rule-scope
> retirement as a rename, so `wp-install-ai-hooks` would have "cured" `whole-repo-build-guard` by
> creating a `hookGuards` key literally named `~/.webpieces/config.json → experimental.whole-repo-build-guard`
> — a fresh unknown rule on the next run. `RetiredConfigKey.prunable` is now the discriminator, shared by
> the migrator and the pruner.
>
> **And the fix's own cure was blocked by the guard that prescribes it** — `wp-prune-unknown-config` had
> to ship as an L0 cure-allowlist entry in the same change. A prescribed remedy that the guard denies is
> its own defect class, and worth checking for whenever a guard message names a new command.

# BUG: the "Unknown rule" message FORBIDS deleting the key (it should force deletion) and never names `~/.webpieces/config.json` — so a retired machine-local guard reads as a repo-config error with no valid exit

**Package:** `@webpieces/rules-config` (message text), with `@webpieces/ai-hook-rules` as the amplifier
**Version seen:** consumer on `0.4.611`, then `0.4.616`; misleading text still reachable on any tree whose validator is older than `0.4.614`
**Severity:** High — on `0.4.611` this cost a consumer most of a day and three aborted agent runs. Both
halves of the message actively steer AWAY from the correct action, and because the guard denies every
Bash call while the config is invalid, there is no way to run anything while working it out.

**Source:** the unknown-rule branch in `packages/.../rules-config/src/validate-config.js`
(shipped as `node_modules/@webpieces/rules-config/src/validate-config.js`)

## What the consumer hit

`0.4.611` shipped `whole-repo-build-guard` (#627) as an ordinary validated guard — `mode: ON` by
default, a REQUIRED `hookGuards` entry. #630 later retired it to machine-local
(`~/.webpieces/config.json → experimental.whole-repo-build-guard`), and `0.4.614` carries that fix.
`0.4.611` is the bad window, and inside it the two validator branches contradict each other:

- **key absent** → `wp-validate-code` fails: *"Not configured in webpieces.config.json. Add this entry
  to the `hookGuards` section"*, and prints a ready-to-paste block.
- **key present** → the PreToolUse guard denies with the generic *"Unknown rule — the running
  @webpieces validator has no schema for it"*, which blocks **every Bash call**: no build, no test,
  no commit, no PR.

Adding it and not adding it were both errors, and the guard was down either way. The consumer followed
the message literally — pasted the block it dictated — and deadlocked.

## Ask 1 — invert the advice: an unknown key should be FORCE-DELETED, not protected

The message currently says, verbatim:

> • Do NOT delete a key just because it is reported unknown — that is how valid config gets gutted.
> First check whether package.json pins an @webpieces OLDER than this config was written for (a key
> copied from newer docs/branch); then the fix is to bump that pin, not to delete the key.

This is backwards and it is the single sentence that cost the most time. For a RETIRED key, deleting it
is the entire fix — and the text explicitly tells you not to do the one thing that works. It optimizes
for a rare case (a stale pin, which the drift guard already detects and reports separately, with its
own message and its own cure) at the cost of the common one.

**An unknown key should be deleted, and the tooling should force that cleanup.** A key no validator has
a schema for controls nothing; leaving it in place is dead config that reads as live config to the next
person. Forcing deletion keeps `webpieces.config.json` clean by construction and makes "the file
validates" mean "every key in it is real".

Concretely:
- Flip the advice: name deletion as the primary cure.
- Better, make it mechanical — a `--fix` / `--prune-unknown` that strips unknown keys, so cleanliness is
  the default path and not a judgement call made under a total Bash block.
- Keep the stale-pin case as the SECONDARY note, since drift already has its own dedicated message.

## Ask 2 — name `~/.webpieces/config.json` whenever that file is in play

Nothing in the failing output ever mentioned `~/.webpieces/config.json`, even though a flag in that
file was what turned the requirement on. The consumer had:

```json
{ "experimental": { "whole-repo-build-guard": true, "buildGateLogCapture": true } }
```

Every message pointed at the repo's `webpieces.config.json` instead. The user worked out the real
location themselves; the tooling never offered it.

Two distinct cases, both currently silent about that file:

1. **A retired key.** The message must say where the setting MOVED TO, by full path —
   `~/.webpieces/config.json → experimental.<name>` — and that the file is optional, untracked by any
   repo, and that with it absent every command behaves exactly as it does by default. (The retired-key
   text added in `0.4.614`+ does this; the problem is the FALLBACK below, which does not.)
2. **Validation of `~/.webpieces/config.json` itself fails.** When the machine-local file is the thing
   that is malformed or carries an unknown/expired experimental flag, the error must NAME that file.
   Today the reader is pointed at the repo config for a problem that does not live there — and that is
   the exact misdirection this report exists to close.

## Why the generic fallback still matters after 0.4.614

It stays reachable on any tree whose validator predates the retirement, which is not exotic — it is the
ordinary linked-worktree layout. Measured on the consumer's machine, mid-incident:

| tree | `@webpieces/rules-config` |
|---|---|
| linked worktree (`.claude/worktrees/<agent>`) | **0.4.616** |
| parent checkout (supplies the hook's resolution) | **0.4.579** |

`0.4.579` predates #627 entirely, so it can only emit the generic "Unknown rule → run `pnpm install`"
text — for a key that is correct-to-delete and has nothing to do with an install. The fallback should
therefore mention that RETIRED keys exist and that the cure may be deletion (and may live in
`~/.webpieces/config.json`), so a stale validator still points somewhere useful instead of prescribing
a `pnpm install` that cannot help.

Worth noting the message also asserts *"Do NOT run `pnpm install` — it cannot help"* in the same block
where the unknown-rule branch says *"run `pnpm install` first … so the validator learns the rule."*
Those two lines appear in one output and cancel out.

## Fix

1. Invert the delete advice; add `--prune-unknown` (or equivalent) so removing dead keys is mechanical.
2. In the unknown-rule fallback, state that the key may be RETIRED, that deletion may be the whole fix,
   and that machine-local settings live in `~/.webpieces/config.json`.
3. When `~/.webpieces/config.json` is the file failing validation, name that path in the error.
4. Drop the contradictory `pnpm install` guidance from the branch that also prescribes `pnpm install`.

## Test cases

1. Config carrying a genuinely retired key, validator ≥ `0.4.614` → message names the new
   `~/.webpieces/config.json` location AND deletion as the cure; `--prune-unknown` removes it and the
   config then validates.
2. Same config, validator `0.4.579` (stale parent tree) → generic fallback still mentions retired keys
   and possible deletion; does not assert `pnpm install` as the only cure.
3. Malformed / unknown flag inside `~/.webpieces/config.json` → the error names THAT file, not the repo
   config.
4. Unknown key caused by a genuinely stale pin → drift message still fires with its own cure; the
   delete-first advice does not cause a valid-but-newer key to be silently dropped without warning.
5. A single validator run never emits both "run `pnpm install`" and "do NOT run `pnpm install`".
