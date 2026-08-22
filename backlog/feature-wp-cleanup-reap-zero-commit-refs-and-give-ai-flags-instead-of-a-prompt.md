# wp-cleanup: reap zero-commit refs by default, and give a non-TTY caller FLAGS + the same full report

## Who asked and why

Dean, after running `pnpm wp-cleanup` in a terminal in `webpieces-ts50` and getting stopped by a
prompt listing two branches with **zero unique commits** (`dean/investigate-home-config-deadlock`,
`worktree-agent-a10a638a56e93bbe2`), both identical to `origin/main`.

His words: *"this is really dumb ... wp-cleanup should just reap if no commits and no agents working,
right?? this kind of sucks and I want to optimize (we can make mistakes - we want SPEED!!!!!!!!)"*

The current NEVER-PROPOSED policy is calibrated for a loss that cannot happen here. A ref with **0
unique commits, identical to `origin/main`,** holds no work by construction — deleting it loses a
NAME, not a commit. The caution exists for one real case: a worktree someone is standing in with
**uncommitted** files. That case is *detectable*, and it is the only thing that should be spared.

## What to change

### 1. Reap zero-commit refs by default, spare only what is provably in use

`CLASSIFICATION_NEVER_PROPOSED` (0 unique commits / identical to `origin/main`) stops being
"never taken unattended". It becomes reapable — **interactive and unattended alike** — unless one of
these is true, each of which the tool can already check or can cheaply check:

- a worktree holds the branch and that worktree has **uncommitted changes** (`git status --porcelain`
  non-empty) — spare, and say so;
- a worktree holds the branch and is **LOCKED** by a live holder — a lock reason naming something
  still present, or a claude-agent pid that is still running — spare, and say so;
- it is the branch **the current tree is standing on**;
- it is a detached HEAD.

Everything else with 0 unique commits is a husk: reap it, archive it first, log the `recover=` line.
The bar moves from "prove it is dead" to "prove somebody is holding it" — deliberately, because the
downside is a re-`git checkout -b`, and the recovery tag makes even that unnecessary.

Keep the safety for refs that DO carry unique commits. This change is only about the zero-commit
group.

### 2. Every delete is TAGGED for recovery — including these

Dean: *"when it runs, we can tag the work for recovery as well!!!"* Archiving already happens for
branch reaps (`archive/<date>/<branch>` + `recover=` in `.webpieces/logs/branch-mutations.log`).
Make it unconditional across every path this change touches — the new zero-commit reaps, and the
branch a reaped worktree carries with it — so the report can truthfully say *every* removal is
recoverable. A zero-commit ref still gets a tag: the tag is what makes reaping it a non-decision.

### 3. A non-TTY run gets the SAME full report a human sees, PLUS how to act on it

Dean: *"AI needs all the same info in there PLUS options on how to delete itself if it knows"*.

Today the unattended path prints a one-line summary of what it took and a bare list of names it left
alone. That is strictly less than the human sees. It must print the **identical numbered, classified
block** — path, branch, unique-commit count, per-classification reason — and then, for anything it
did not take, the **exact command that takes it**:

```
Left for you to decide (2):
  [1] dean/investigate-home-config-deadlock  — <reason>
  [2] worktree-agent-a10a638a56e93bbe2       — <reason>

To delete them yourself, re-run with:
  pnpm wp-cleanup --delete-branches=1,2      # or =all / =none
  pnpm wp-cleanup --delete-worktrees=all
Every delete is archived to a tag first; `recover=` lines land in .webpieces/logs/branch-mutations.log
```

The numbers in the flag MUST be the numbers just printed, and the report must say so — a numbering
that shifts between the report and the flag is the one way this can delete the wrong ref.

### 4. Flags, so the decision is not made by sniffing the terminal

- `--delete-branches=all|none|<n,n>` and `--delete-worktrees=all|none|<n,n>` — decide without a prompt.
- `--report` — print the full classified report and exit **without deleting anything** (the
  print-and-exit case; useful for an agent that wants to show a human before acting).
- `--interactive` — force the prompt even when stdin is not a tty.
- `--help` — list all of the above. A bare `wp-cleanup` with nothing to do should point at `--help`.

**Why flags matter more than the tty check:** `process.stdin.isTTY !== true` is what currently
distinguishes "an agent" from "a human", and it is a proxy, not a fact. A human running
`pnpm wp-cleanup | tee log` is non-tty; an agent on a pty is a tty. The tty check stays as the
*default* selector, but an explicit flag always wins over it, so the caller who knows can say so.

## Definition of done

- A zero-commit branch with no worktree is reaped by a plain `pnpm wp-cleanup`, in a terminal, with no
  prompt — and the run prints its archive tag and `recover=` command.
- A worktree with uncommitted changes, a live-locked worktree, and the tree you are standing in are
  all still spared, each with a stated reason.
- A non-tty run prints the same numbered classified block a tty run prints, plus the exact
  `--delete-branches=` / `--delete-worktrees=` command for whatever it left.
- `--report` deletes nothing. `--interactive` prompts with no tty. `--help` lists every flag.
- Specs in `cleanup-command.spec.ts` cover: zero-commit reap, uncommitted-work spare, live-lock spare,
  each flag, flag-beats-tty, and that the report's numbering equals the flag's numbering.
- No second spelling of any of this left behind (see the backwards-compat rule in CLAUDE.md).

## Where the code is

- `packages/tooling/pr-gate/src/scripts/commands/cleanup-command.ts`
  (`askWhichToDelete`, `unattendedPicks`, `classifiedBlock`, `promptable`,
  `CLASSIFICATION_NEVER_PROPOSED`)
- `packages/tooling/pr-gate/src/scripts/commands/worktree-cleanup.ts` (`promptable`, `promptBlock`)
- `packages/tooling/pr-gate/src/scripts/commands/cleanup-command.spec.ts`

## Release note

`wp-cleanup` ships from `@webpieces/pr-gate`, so this only changes what Dean sees after a publish +
`pnpm install` (the one-release lag). Verify with the package's own vitest suite, not by running the
installed `wp-cleanup`.
