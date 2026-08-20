# BUG: a Bash block never tells the AI the file it wanted is in `excludePaths` and reachable RIGHT NOW via Read/Write — so the agent burns turns on the block instead of switching tools

**Package:** `@webpieces/ai-hook-rules`
**Version seen:** consuming repo `monorepo-nx2` on `@webpieces/nx-webpieces-rules` 0.4.669
**Reporter context:** hit live **2026-08-20** in `/Users/deanhiller/workspace/onetablet/monorepo-nx2`.
**Severity:** Medium — costs turns on every session, and the recovery it *does* print
(`git checkout -b …`) is strictly more destructive than the one it omits.

**Source:** `packages/tooling/ai-hook-rules/src/core/runner.ts`
(`filterByExcludedPaths` at :45, the Bash path at :456), `stale-main-bash-guard.ts`,
`merged-branch-bash-guard.ts`, plus the `FixHint`/`Option` rendering that builds the deny body.

Related — same root cause, different symptom:
[`bug-bash-guards-judge-the-shell-cwd-not-the-paths-the-command-touches`](./bug-bash-guards-judge-the-shell-cwd-not-the-paths-the-command-touches.md),
[`bug-bash-guards-judge-foreign-repo-exclusion-on-pre-cd-cwd-and-ignore-excludepaths`](./bug-bash-guards-judge-foreign-repo-exclusion-on-pre-cd-cwd-and-ignore-excludepaths.md).
This one is **not** asking for those to be fixed. It asks the deny message to *tell the truth about
the escape that already exists* even while they remain broken.

---

## 1. What happened

Agent, on `main`, ran:

```
cat /Users/deanhiller/workspace/onetablet/monorepo-nx2/.webpieces/tasks.md
```

`.webpieces/**` is in that repo's `excludePaths`. The Read tool would have succeeded instantly.
Instead `stale-main-bash-guard` denied it and printed ~25 lines whose every remedy is a **git state
change** — `git pull --ff-only origin main`, `git checkout -b <new-branch> origin/main`,
`pnpm wp-checkout-clean-main`, or turning the guard off in `webpieces.config.json`.

Nowhere does it say the one thing that was true: **that exact file was already reachable, this
instant, with no git operation at all, through Read/Write.**

The agent did what the message told it to. It created a branch in the human's working tree — moving
the human's uncommitted work onto it — purely to record a row in a **gitignored** scratch file. The
cheap, side-effect-free path was one sentence away and never mentioned.

## 2. Why the message is wrong, not merely terse

The Bash guard matches on the shell's **cwd** (`relativeCwd`, `runner.ts:456`), not on the paths in
the command. At the repo root that is `''`, which matches no glob — so the guard fires even though
the file the command names is exempt. That is the sibling bug above.

But note what the guard *has in hand at deny time*: the command string, and `loaded.excludePaths`.
It already prints an `exemptTreesHint(groups, loaded.excludePaths.paths)` (`runner.ts:495`), so the
exclusion list is **literally already threaded into the deny path**. The information needed to say
"use Read/Write instead" is present and is being partially rendered — it just never draws the
conclusion that matters to the caller.

So this is a message defect that is independently fixable, and worth fixing *first*: it makes the
cwd bug survivable rather than turn-costing, without touching the matching semantics that the other
two tickets have to be careful about.

## 3. Asked-for behaviour

When a Bash command is denied, scan the command string for file paths. If **any** referenced path
falls under `excludePaths`, prepend a few lines to the deny body — **at the top, above the git
remedies**, because the agent acts on the first actionable thing it reads:

```
✅ YOU CAN USE THE READ/WRITE TOOLS RIGHT NOW — no git operation needed.
   These paths are in excludePaths and are exempt from every guard:
     .webpieces/**
     repositories/**
   Your command referenced: .webpieces/tasks.md
   Use Read/Write/Edit on it instead of bash. The remedies below are only
   needed for files OUTSIDE those directories.
```

**And — equally important — print the `cd` form that makes BASH ITSELF work.** The guard already
resolves a leading `cd` (`EffectiveTreeResolver.effectiveCwd(command, cwd)`), so a command whose
effective cwd lands inside an excluded tree is allowed *today*, with no fix required. The agent is
never told this either, so it abandons bash entirely when it did not have to:

```
✅ OR KEEP USING BASH — put a `cd` into the excluded tree FIRST:
     cd .webpieces/logs && cat ../tasks.md
   The guard resolves a LEADING `cd` and judges that directory, so this runs.
   It must be the first thing in the command: no leading VAR= assignment,
   no subshell wrapper — those defeat the resolution.
```

Requirements:

- **Trigger on a reference ANYWHERE in the command**, not just a leading `cd`. `cat x`, `grep -n foo x`,
  `sed -n '1,5p' x`, absolute paths, and paths inside a `&&` compound all count.
- **Emit a `cd` form that actually matches**, not a naive one — see the trap in §3.1 below. Generating
  `cd .webpieces && cat tasks.md` would be worse than saying nothing: it looks authoritative and is
  still denied.
- **List the actual `excludePaths` globs** from the loaded config, not a hard-coded example — a repo
  that excludes `vendor/**` must see `vendor/**`.
- **Name which referenced path matched**, so the agent does not have to re-derive it.
- **Top of the message.** Below the git remedies it will not be read; the agent will already have
  started a checkout.
- Absolute paths must normalise to workspace-relative before matching, the same way the file-scoped
  guards do.

## 3.1 The trap: `<dir>/**` does not match `<dir>`

The Bash path matches `relativeCwd` with **`globMatches`** (`load-rules.ts:246`), which compiles the
glob to an anchored regex: `.webpieces/**` becomes `/^\.webpieces\/.*$/`. The trailing `/` is a
literal, so the directory itself fails to match. Verified:

| command | effective cwd | verdict |
| -- | -- | -- |
| `cat .webpieces/tasks.md` | `''` | **blocked** |
| `cd .webpieces && cat tasks.md` | `.webpieces` | **blocked** |
| `cd .webpieces/logs && cat ../tasks.md` | `.webpieces/logs` | allowed |

The same holds for the existing entry: `repositories` is denied, `repositories/fuji` is allowed. It
works in practice only because nobody `cd`s to the bare `repositories/`.

Two consequences the fix has to respect:

1. **The generated hint must name a real subdirectory**, or advise adding the bare directory to
   `excludePaths` alongside the glob (`[".webpieces", ".webpieces/**"]`) so the plain
   `cd .webpieces && …` works. Emitting an unmatched `cd` is worse than emitting none.
2. **Two different matchers are live for one config key.** The top-level `excludePaths` is evaluated
   by the runner's strict `globMatches`, while per-rule `excludePaths` goes through
   `isPathExcluded` (`rules-config/src/exclude-paths.ts`), which *additionally* matches a bare
   segment anywhere in the path and retries the pattern as `${pattern}/**`. So `.webpieces` as a
   pattern exempts `.webpieces/tasks.md` under one matcher and not the other. That divergence is
   worth closing on its own — the same string in the same config key should not mean two things.

## 4. Why "the agent should just know" is not a fix

The harness actively pushes the other way. In auto mode the agent is instructed to *prefer* Bash for
file reads — "read files with cat, head, or sed -n… fall back to a dedicated tool only when Bash
genuinely cannot do the job." An agent following its own operating instructions will reach for `cat`
first, every time. The guard is the only component that knows the path is exempt, so it is the only
component that can redirect.

## 5. Scope note

This asks for **no change to what is blocked**. Same verdicts, same matching, same guards. Only the
deny body gains a leading stanza when the command names an excluded path. That makes it safe to ship
ahead of the two cwd-matching bugs, and it reduces their cost in the meantime.
