# BUG: L-1 enforces a coordinator-only rule on everyone, and a documented one-line env var makes the whole layer unnecessary

**Package:** `@webpieces/ai-hook-rules`
**Severity:** **MEDIUM as a correctness bug** (guard text states a coordinator-only rule as universal),
**HIGH as a simplification** — L-1 exists to maintain an invariant Claude Code will maintain for us, on
request, with one environment variable.
**Versions:** measured on `0.4.616` (harness: Claude Code, Opus 5), 2026-08-10. Documentation checked
directly on the same date.

**Supersedes the original framing of this file.** It was filed as "a `cd` inside the workspace did not
persist, contradicting our measured premise". That observation was real but it is **not a harness bug —
it is documented behaviour**, and the documentation also hands us a much better answer than the layer we
built. Rewritten accordingly.

---

## What the documentation actually says

From [tools-reference](https://code.claude.com/docs/en/tools-reference.md), verified verbatim:

> "When Claude runs `cd` in the main session, the new working directory carries over to later Bash
> commands as long as it stays inside the project directory or an additional working directory you added
> with `--add-dir`, `/add-dir`, or `additionalDirectories` in settings."

> "If `cd` lands outside those directories, Claude Code resets to the project directory and appends
> `Shell cwd was reset to <dir>` to the tool result."

> **"Subagent sessions never carry over working directory changes."**

> "To disable this carry-over so every Bash command starts in the project directory, set
> `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1`."

Three consequences, in increasing order of importance.

## 1. The measurement is explained — and our premise is half true

The probe that prompted this file (an ordinary subagent `cd`-ing into a worktree, then `pwd` returning
the primary on the very next Bash call, 3 seconds later, with no intervening tool) is **exactly the
documented subagent behaviour**. Not an anomaly, not a version regression.

But our own text states the rule **unconditionally**. `effective-tree.ts`, `guarantee-root.ts`'s header,
`guards/L1-location.md` question 4, and the user-facing `DENY_SUBDIR` message all say:

> "a `cd` that stays INSIDE the workspace PERSISTS to your next call"

That is true for the **coordinator only**. For a subagent — which is most of the agents this repo runs —
it is false, and the deny message tells the reader something about their own session that is not so. The
word "main session" is doing all the work in the real docs and appears nowhere in ours.

**Fix (small, do this regardless):** qualify the claim everywhere it appears — persistence is a
main-session property; subagents always start each Bash call at the project directory. Cite the doc.

## 2. For a SUBAGENT, L-1's subdirectory denial buys nothing

L-1's entire justification is the inductive invariant: *if the shell can never be parked outside a tree
root, then the relative hook path always resolves.* The induction needs `cd` to persist.

In a subagent it never persists. The shell is returned to the project directory before every Bash call,
so it **cannot** be parked in a subdirectory across calls — the invariant holds for free. Yet L-1 denies
`cd packages` for subagents just as hard as for the coordinator, which is pure cost: it is the source of
the `force-to-root` bug class, the reaped-worktree `cd`, and the worktree-subdir deadlock. (A `cd` inside
a single compound command — `cd x && cmd` — is unaffected either way, since it never outlives the
command.)

## 3. The layer can likely be retired entirely — `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1`

This is the important one. That documented variable makes **every** Bash command start in the project
directory — for the coordinator too. It is, precisely, the invariant L-1 was built to enforce, supplied
by the harness.

With it set:

- the shell can never be parked in a subdirectory, so the relative `.claude/webpieces/ai-hook.sh` always
  resolves — **which is the only thing L-1 exists to guarantee**;
- `cd` into subdirectories becomes harmless and can be ALLOWED, deleting the denial and its bug class;
- per-tree governance via the relative registration is untouched — that is what actually delivers "each
  git tree is governed by its own release".

**This is a far smaller change than the alternatives.** It was previously weighed against re-registering
the hooks absolutely (loses per-tree governance) or adding an absolute dispatcher that re-resolves the
tree per call (works, but is new machinery). Setting an env var and deleting a layer beats both.

### What must be verified before acting

Do NOT flip this on the strength of the doc alone — this repo's rule is to verify against the artifact
that actually runs.

1. **Does the hook process's `cwd` still follow a `cd` within one command?** The relative registration
   resolves against the hook's cwd. If the variable also pins the *hook's* cwd to the project directory,
   then `cd <worktree> && <cmd>` would start being judged by the PRIMARY's shim — which would be a
   regression, not a fix. This is the single decisive question.
2. **Where is it set?** `env` in `.claude/settings.json` is itself an auto-reloaded surface; confirm it
   reaches the Bash tool.
3. **What breaks that currently relies on a persisted `cd`?** Grep the `wp-*` bins and any multi-call
   flow that assumes the shell stayed where it was put.
4. **The transition.** L-1 ships in the committed `guarantee-root.sh`, so removing it is a shim change
   under the usual one-release lag (source first, then publish, then the config/registration change).

Until (1) is answered, keep L-1 on.

## Related

- [`bug-l1-prescribes-a-subagent-remedy-that-cannot-be-launched-and-would-not-fix-the-governance-split-anyway`](./bug-l1-prescribes-a-subagent-remedy-that-cannot-be-launched-and-would-not-fix-the-governance-split-anyway.md)
  — same session; its §"Correction 2" is the measurement that led here.
- [`bug-a-write-with-an-absolute-path-into-another-worktree-is-allowed-and-judged-against-the-wrong-tree`](./bug-a-write-with-an-absolute-path-into-another-worktree-is-allowed-and-judged-against-the-wrong-tree.md)
  — the file tools bypass this whole layer regardless, since L-1 is registered for Bash alone.
- [`bug-force-to-root-still-uses-pre-cd-cwd-so-cd-root-and-git-is-blocked-from-a-nested-clone`](./bug-force-to-root-still-uses-pre-cd-cwd-so-cd-root-and-git-is-blocked-from-a-nested-clone.md)
- [`bug-bash-guards-judge-the-shell-cwd-not-the-paths-the-command-touches`](./bug-bash-guards-judge-the-shell-cwd-not-the-paths-the-command-touches.md)

## Appendix — one more documented fact that contradicts a working assumption

Hooks are **not** read once per session. From [settings](https://code.claude.com/docs/en/settings.md):

> "Claude Code watches your settings files and reloads them when they change, so edits to most keys apply
> to the running session without a restart. This includes `permissions`, `hooks`, and credential helpers
> like `apiKeyHelper`."

Only `model` and `outputStyle` are documented as restart-only. Any reasoning in this repo that begins
"hook registration is fixed at session start, so…" needs re-checking. What remains genuinely undocumented
is **which** `settings.json` a worktree-isolated subagent reads (session project dir vs its own worktree),
and whether `$CLAUDE_PROJECT_DIR` is fixed at session start — the latter is observed here but appears
nowhere in the docs.
