# Build verification

Moved verbatim out of `CLAUDE.md`. Read this before you run a build, when a build failed and you need
its log, when a build is REFUSED for contention, or when you are tempted to add a leg to the verify
chain.

## Build Verification (CRITICAL)

**RULE: verify with `pnpm wp-build`. Never build the whole monorepo, and never hand-compose a verify
chain of your own.**

```bash
pnpm wp-build
```

That runs `commands.pr-gate.buildCommand` from `webpieces.config.json` **verbatim** — through the same
resolver the PR gate's own build stage uses, so a green result locally is evidence about the gate. It
prints the command it resolved before running it, so you always know what actually ran. A
whole-workspace build is a *different, wider* command whose green tells you nothing extra — it only also
compiles projects your change cannot reach.

**The build's output goes to a log FILE, not to your terminal.** The console gets a heartbeat (`… size
100 lines`, plus `still` when the count has not moved) and then one summary — `Build success` or
`Build Failed:`, the absolute `FullLog :` path, and a note that the previous run is kept beside it as
`build.log.bak`. Both are gitignored with the rest of `.webpieces/`.

**Read the log at the absolute `FullLog :` path THIS run printed — never type a path from memory.**
`grep -n error "<the FullLog path>"` always works; a remembered relative path silently greps nothing,
which reads exactly like a clean build.

Where that file actually lands — primary clone vs linked worktree, `wp-build` vs the PR gate's stages —
is **`.webpieces/instruct-ai/webpieces.buildlog.md`**, regenerated on every `wp-*` command. Read it
there rather than here: the namespacing is webpieces' to change, this file is hand-written, and a path
copied into a hand-written file is exactly the thing that goes stale under us (see the corollary in
`.claude/rules/no-backwards-compat.md`).

**So read the FILE; never re-run the build to see a different slice of it.** That is the whole reason
the log exists: one measured session spent 23.9 minutes across nine builds, five of them with no code
change in between, walking `| tail -50` → `> /tmp/file` → `| grep` → `| sed -n '1100,1230p'` over
output that had already scrolled past. Every one of those is a `grep` of the `FullLog :` file now, and
the run before it is still on disk as `.bak`.

`wp-build` ships from `@webpieces/pr-gate`, so like every other `wp-*` bin it arrives with a RELEASE —
see `.claude/rules/published-vs-local-source.md`. If `pnpm wp-build` says *command not found* in this
repo, the pin in `pnpm-workspace.yaml` is simply older than the release that added it; run the resolved command it
wraps (`commands.pr-gate.buildCommand`) until the next publish + `pnpm install`. That is the ordinary
one-release lag, not a broken install.

**Do not assemble your own verify chain.** `wp-build` deliberately runs one command and adds no
format/lint/test leg of its own, because that composition is exactly what drifts: a sibling repo's
`ci:local` grew into `prettier --check .` + `wp-ci` + `nx affected -t test` with no `--base` — three
whole-world passes on every inner loop, none of them the command the gate runs. If something must run on
every build, it belongs *inside* `buildCommand`, where the gate runs it too.

Tighter loops, for while you are actually writing code:

```bash
pnpm exec vitest run <path>          # one spec file or one directory — the inner loop
pnpm nx run <project>:test           # one project's tests
pnpm nx run <project>:ci             # one project, full gate
pnpm nx run-many -t ci -p a b        # a couple of projects, named explicitly
```

`pnpm run build-all` (and `nx run-many` with no `-p`, `nx affected` with no `--base`, and a bare
`pnpm exec vitest run`) is what `whole-repo-build-guard` refuses, naming `pnpm wp-build` in its place.
That guard is **EXPERIMENTAL and OFF unless this machine opts in** — the one thing that turns it on is

```json
{ "experimental": { "whole-repo-build-guard": true } }
```

in the optional, untracked `~/.webpieces/config.json`. There is no `webpieces.config.json` entry for it.
A missing file, a missing `experimental` section, a missing key and an explicit `false` are all the same
state: OFF. That direction is policy — every `experimental.*` flag ships OFF and stays OFF for two
years. The rule above holds either way: run `pnpm wp-build`, guard or no guard. The `build-all` script
stays in `package.json` on purpose — a human running it once is fine; an agent running it in a loop is
the problem, and a PreToolUse hook only ever sees the agent.

### Does `affected` cover the workspace-global validators?

**Yes — verified, not assumed.** The architecture / dependency-graph / nx-wiring / versions-locked /
runtime-architecture validators all hang off `architecture:validate-complete`, and **every project's
`ci` target `dependsOn` it** (see `createCiTarget` in the nx plugin). So the moment *any* project is
affected, one `nx affected --target=ci` run schedules the whole `architecture:validate-*` set. A
tooling-only change on this branch scheduled 47 tasks across 7 projects, including all eleven
`architecture:*` validators. There is no class of check that only a whole-workspace run reaches.

The one thing that is genuinely repo-wide and does NOT ride on a project's `ci` is the
"regenerated design files are committed" check — and that runs in `pnpm wp-review-upsert-pr`, so the
gated flow covers it for you.

### What actually makes builds slow (it is not the target list)

Do not expect `affected` to be fast just because it is narrower — measured honestly:

- For a change in a **base** package (`core-util`, `core-context`), `affected` can select **nearly
  everything**: on one measured `core-util` change it selected the identical 20 projects / 104 tasks
  the whole-workspace build did. Nothing sits below it in the graph, so nothing prunes. The pruning
  win is real for **leaf** projects and roughly zero for base ones.
- The long builds people blamed on scope were **cold nx cache** and **CPU contention between agents
  running full sweeps at the same time** — measured at ~3.2x total test time under contention, with
  individual suites 3x slower than the same suite minutes later on an idle box. A narrower target
  list does not fix either.

Practical consequence: a full `pnpm exec vitest run packages apps` sweep is expensive under
contention. Run it **once**, before you post the PR — not after every edit. During the edit loop, run
the one spec file you are changing.

**Contention is now MEASURED, not guessed at, and `wp-build` acts on it.** Every build on this machine
— `wp-build` and both PR-gate stages — writes a row to one machine-wide ledger, and `wp-build` REFUSES
when the box is already at its limit rather than making a fourth build everybody's problem. The gate
stages are never refused. When you meet that refusal, take its first cure: run the gate you were going
to run anyway, which runs the same `buildCommand`. **`.webpieces/instruct-ai/webpieces.buildlog.md` has
the ledger's location, its row format, the grep recipes, the limit's config key and the `--force`
escape** — read it there, not here, for the reason in the corollary in
`.claude/rules/no-backwards-compat.md`: a path copied into this hand-written file is exactly what goes
stale on the next release.

**A green build is NOT the finish line.** None of those greens mean the work is ready for review.
When the feature is actually complete, proceed to `.claude/rules/finishing-a-feature.md` — do not stop
at a green build.
