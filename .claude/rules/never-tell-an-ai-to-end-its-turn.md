# Never tell an AI to end its turn

Read this when you are writing or editing ANY string webpieces prints at an agent — a gate banner, a
guard's cure, a `wp-*` command's output, a template under `packages/tooling/rules-config/templates/**`,
or a `.claude/**` instruction — and especially when that string is about WAITING.

## The rule

**webpieces NEVER tells an AI to end its turn.** No banner, no guard cure, no docstring, no template.

**What webpieces DOES control is the stupid poll**: `echo .` every three seconds, `echo idle`, `true`,
`date`, the same `gh pr checks <n>` asked for the two-hundredth time. Blocking that is legitimate and
stays — it was measured at 18.3% of every token the fleet spent in the 24h to 2026-09-07 (issue #874).

So every piece of wait guidance has exactly three moves, in this order, and then it stops talking:

1. **Name the efficient option** — wait on the subagents you spawned, or block in one call with
   `pnpm wp-await-checks --pr <n>` / `pnpm wp-await-reviews`.
2. **Name the wasteful thing not to do** — status checks every few seconds, `echo` keep-alives.
3. **Say nothing about when to end a turn.**

The shape to reach for:

> Try to be efficient with tokens — wait on subagents you spawned, or block in one call with
> `pnpm wp-await-checks --pr <n>`, instead of sending status checks every few seconds.

## Why

**An agent already knows how to wait.** It waits on spawned subagents routinely and reliably; the main
agent does it constantly, without being told. A script that blindly prints "END YOUR TURN" is
substituting a fixed rule for a judgement the agent is better placed to make, in a situation the script
cannot see. It is dumber than the thing it is instructing.

Blocking a bad command is a different act entirely, and that is why the guard survives this rule
unchanged. A refusal says "not this specific wasteful command"; it decides nothing about the agent's
control flow. A turn-level prescription decides the control flow and knows nothing about the situation.

The history is the argument. #874 justified the blocking wait by asserting a worktree subagent *cannot*
end its turn — false, and #878 corrected it by making ENDING THE TURN the recommended, cheapest wait
everywhere. #900 then measured the mechanism that correction rested on and found it does not reliably
fire: three stalls, two subagents, one session, every background-task notification reading "no live
background children of its own". #901 fixed the one string the incident landed on. Two releases, two
opposite instructions, and at one point `finish-banner.ts` and `SUBAGENT_CURE` shipped in the SAME
release contradicting each other — because each fix argued about which turn-level rule was right instead
of noticing that webpieces should not be issuing one. #902 deleted every one of them.

## The carve-out: "do NOT end your turn" is the OPPOSITE instruction, and it stays

The rule is **never tell an AI to STOP**, not "never mention turns". Two sites tell an agent NOT to stop
and ask permission before posting a PR, and they are the finish-the-feature contract:

- `packages/tooling/rules-config/templates/webpieces.git-workflow.md` — `Do NOT end your turn with
  "want me to open a PR?"`
- `.claude/rules/finishing-a-feature.md` — the same sentence

`SUBAGENT_CURE` in `wait-spin-guard.ts` carries a third — "Do NOT end your turn expecting a backgrounded
wait to re-invoke you" — which is what #900 bought. Leave all three alone.

Prose that RECORDS what an earlier version said, and why it changed, is history and evidence, not an
instruction. It stays too. The test is one question: **does this sentence TELL the reader to end their
turn, or DESCRIBE that something once did?**

## Enforcement

Two spec files, both named `no-turn-ending-instructions.spec.ts`:

- `packages/tooling/pr-gate/src/scripts/workflow/` — renders `FinishBanner` for every merge outcome and
  `ReviewReport` for every variant.
- `packages/tooling/ai-hook-rules/src/core/rules/` — collects every refusal `wait-spin-guard` can print,
  for both agent kinds and every spin shape, plus its `description` and `fixHint`.

Both assert over the **strings actually emitted**, never over source text — a grep of the source is
satisfied the moment somebody moves the sentence into a constant or builds it from two halves. Both
strip the negated spelling first, so the carve-out above passes, and both pin the detector in each
direction so the assertion cannot rot into decoration.
