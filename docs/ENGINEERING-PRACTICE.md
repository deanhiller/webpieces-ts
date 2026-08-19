# Org engineering practice — the conventions, and the machine that enforces them

> **Read this if you are evaluating this repository, adopting it, or trying to understand why
> `packages/tooling/` is roughly as large as the framework itself.** The framework is the smaller
> of the two things shipped here. The larger one is an **engineering practice for an organization**
> — a set of conventions about testing, contracts, errors, and git — together with a **three-stage
> enforcement machine** that makes every team, and every AI agent working alongside them, actually
> follow it.
>
> Conventions that live in a wiki are advisory. Conventions that live in a PreToolUse hook, a build
> gate, and a PR gate are *the shape of the codebase*. That difference is the whole document.

---

## Why a practice layer at all

Every organization above about two teams has the same failure: it *knows* what good looks like and
cannot make it happen. The design review said "don't couple tests to internals." The onboarding doc
said "always chain the cause when you rethrow." The architecture decision record said "no Symbol DI
tokens." Six months later the codebase does all three things wrong, in a hundred places, and nobody
can point to the moment it went wrong — because it never went wrong at a moment. It drifted.

The standard responses all fail for the same reason: they depend on a human noticing at review time.

| Response | Why it drifts |
|---|---|
| Wiki / style guide | Nobody reads it at the moment of writing the line. |
| Code review | Reviewers catch what they happen to look at; consistency varies per reviewer and per Friday afternoon. |
| Linter with a big allowlist | The allowlist grows monotonically. Nobody ever removes an entry. |
| Big-bang migration project | Never finishes. Gets deprioritized at 60%. |

And then AI arrived and made it strictly worse, because an agent writes ten times the code and has
read *none* of your wiki. An agent is a perfectly compliant engineer who has never been told the
rules. If your conventions are not machine-enforced at the moment of the edit, an AI-accelerated
team does not drift — it stampedes.

**The thesis of this repo's tooling layer: an engineering convention is only real if a machine
refuses the violating change.** Everything below is the implementation of that sentence.

---

## Part 1 — The practice (what an adopting org actually adopts)

Four conventions. Each is a position the market mostly does *not* hold, each has a document
explaining the reasoning, and each has enforcement behind it.

### 1. Feature tests, api-to-api, append-only

Full argument: [`architecture/testing-philosophy.md`](./architecture/testing-philosophy.md).

Tests drive the **public contract** through the real filter chain (`createApiClient(...)`), never a
mocked internal. Many live in the *consuming* service, not here. The org rule that makes it work:

> **Tests may be added to, never modified.** A test is only deleted on a *pivot* — an endpoint
> removed or replaced — and only after that endpoint has zero production traffic.

The payoff is not test-suite aesthetics, it is that **a refactor touches zero tests, so the still-green
suite is real evidence nothing broke.** The market pattern — rewrite the test until the build is green
— destroys the safety net at the exact instant the net was for. It also means a human or an AI can
refactor an *entire microservice* and the tests it never read are the ones still holding every legacy
path in place.

### 2. One contract, no codegen cascade

Full argument: [`architecture/api-first-vs-codegen.md`](./architecture/api-first-vs-codegen.md),
[`architecture/one-contract-many-transports.md`](./architecture/one-contract-many-transports.md).

One decorated API interface is the only source of truth, read at runtime by client *and* server. No
`server → generate spec → generate client` chain, so a one-line server fix does not trigger a
regenerate-and-rebuild cascade across the monorepo. The **compiler**, not a generator, catches
contract drift. Organizationally this removes an entire class of cross-team coordination cost.

### 3. Explicit error, context, and logging discipline

Errors chain their cause (`throw-cause-required`), catches follow one shape
(`catch-error-pattern`), nothing throws un-modelled (`no-unmanaged-exceptions`). Request context is
typed at the key (`ContextKey<V>`), propagates across async/process/**queue** boundaries, and
**deliberately excludes credentials** so a caller's token cannot ride to the next hop or into a
Cloud Task. See [`architecture/context-propagation.md`](./architecture/context-propagation.md) and
[`architecture/observability-and-recording.md`](./architecture/observability-and-recording.md).

### 4. A git workflow with no unattended sharp edges

Branch off `main` before editing; PRs go through `wp-start-upsert-pr` → `wp-finish-upsert-pr` (an
authoritative build gate, not an honour-system one); merged branches are reaped by `wp-cleanup`,
which deletes only *provably* dead branches and logs a `recover=` command with the pre-delete SHA
for each. Documented in [`git-workflow.md`](./git-workflow.md) and refreshed into the agent's
context on every `wp-*` command — so the instructions cannot go stale relative to the tool.

---

## Part 2 — The machine (three enforcement points, three latencies)

The same rule is enforced at up to three places. This is not redundancy; **each stage catches
exactly what the previous one structurally cannot.**

```
   AI agent edits a file            Engineer runs the build          PR is opened
            │                                │                             │
            ▼                                ▼                             ▼
  ┌──────────────────────┐        ┌──────────────────────┐      ┌──────────────────────┐
  │  @webpieces/         │        │  @webpieces/         │      │  @webpieces/         │
  │  ai-hook-rules       │        │  code-rules          │      │  pr-gate             │
  │  PreToolUse hook     │        │  wp-ci (nx affected) │      │  wp-finish-upsert-pr │
  ├──────────────────────┤        ├──────────────────────┤      ├──────────────────────┤
  │ blocks the write     │        │ fails the build on   │      │ authoritative gate;  │
  │ BEFORE bad code      │        │ the diff, whoever    │      │ nothing merges       │
  │ exists — with the    │        │ wrote it — human,    │      │ around it            │
  │ fix in the message   │        │ agent, or IDE        │      │                      │
  └──────────────────────┘        └──────────────────────┘      └──────────────────────┘
      milliseconds                       seconds                       minutes
```

**Edit time — `packages/tooling/ai-hook-rules/`.** A PreToolUse hook that inspects the agent's
proposed write and *refuses it*, returning the reason and the fix. The bad code is never written, so
it is never reviewed, never committed, never in a blame trail. This is the stage that has no
equivalent in a pre-AI toolchain, and it is the one that matters most now: it is the only place you
can put a convention where an agent cannot skip it, because the agent does not get to choose whether
the hook runs.

Beyond the code rules, this layer holds **workflow guards**, switched by THREE `hookGuards` keys — one
per policy, not one per class. `branch-state-guard` covers "may I work here, and is what I read
current?" (don't edit on `main`, don't reason about an already-merged branch, don't `cat` a stale tree);
`branch-creation-guard` covers which branches and worktrees may exist; `pr-lifecycle-guard` covers "do
PRs and merges go through the gated flow?". Alongside them sits `whole-repo-build-guard`, which has no
repo config key at all (don't build the whole monorepo — run `pnpm wp-build`). These encode process, not
syntax: an agent physically cannot start work in the wrong place. Configured under `hookGuards` in
`webpieces.config.json` — except `whole-repo-build-guard`, which has no repo-config entry at all: it is
EXPERIMENTAL and OFF for every tree, and the only way to switch it on is per MACHINE, from the optional
`~/.webpieces/config.json` (`experimental.whole-repo-build-guard: true`). That split is deliberate, and
so is the direction of the default. A guard must never become something every consumer has to CONFIGURE
before their next command works — that is the shape that once blocked every upgrading consumer's shell —
and every `experimental.*` flag ships OFF for two years besides, because a flag that arrives switched on
is not an experiment, it is a behaviour change delivered by an upgrade nobody asked for.

**Build time — `packages/tooling/code-rules/`.** ~30 validators run from `wp-ci`, which the affected
build (`pnpm nx affected --target=ci --base=<fork point>`) invokes per project. This catches anything
that bypassed the hook: a human in an editor, a
different agent, a merge that reintroduced something. Also where the whole-repo invariants live that
a single-file hook cannot see — `di-graph`, `no-file-import-cycles`, `runtime-architecture`,
`nx-wiring`, `missing-design-annotation`.

**PR time — `packages/tooling/pr-gate/`.** `wp-finish-upsert-pr` re-runs the gate authoritatively
before the PR is created or updated. Local greens are convenience; this one is the record.

### Why the rules are config-driven, not ESLint rules

Rules are declared in **`webpieces.config.json`**, validated by a published schema
(`packages/tooling/rules-config/`), and shared by all three stages from one implementation. A rule is
not a lint plugin an engineer can add a plugin-local disable to; it is an org policy with a *mode*, an
*epoch*, and an explicit *may-this-be-suppressed* flag. That triple is the interesting part.

---

## Part 3 — The ratchet: how a practice lands in a codebase that predates it

This is the mechanism that makes the difference between "we should do X" and "X is now true," and it
is the piece most orgs never build. Every rule carries three dials:

```jsonc
"no-any-unknown": {
    "mode": "NEW_AND_MODIFIED_CODE",     // WHAT the rule looks at
    "disableAllowed": true,              // MAY an engineer opt out, with a written reason?
    "turnOffRuleUntilEpoch": 1783409251  // WHEN does it start biting
}
```

**`mode` is the ratchet.** The modes are scoping decisions, not severity:

| Mode | Scope |
|---|---|
| `OFF` | Not enforced. |
| `NEW_AND_MODIFIED_CODE` | Only lines in the diff. |
| `NEW_AND_MODIFIED_METHODS` | Any method you touched, whole. |
| `NEW_AND_MODIFIED_FILES` | Any file you touched, whole. |
| `MODIFIED_CLASS` / `MODIFIED_PROJECTS` | Any class / project you touched. |
| `RUN_EVERY_TIME` | Whole repo, every run — for graph-level invariants that have no diff. |

`NEW_AND_MODIFIED_*` is the key idea: **legacy code is grandfathered, but the moment you touch it, it
must comply.** No migration project, no 60%-finished cleanup epic, no allowlist that only grows. The
codebase converges on the standard at exactly the rate it is being worked on — which is the rate at
which the conversion is actually cheap, because you are already in the file. Turn a rule on at
`NEW_AND_MODIFIED_CODE` and the org's *newest* code is compliant tomorrow; the rest follows the churn.

**`turnOffRuleUntilEpoch` time-boxes a rollout.** A rule can be committed, wired, and visible while
still not blocking anyone until a date the org picked. It is the sanctioned way to announce a
convention ahead of enforcing it — and unlike a "we'll turn it on later" Slack message, the date is in
version control and it arrives by itself.

**`disableAllowed` decides whether the escape hatch exists at all.** Where it is `true`, an engineer
may write:

```typescript
// webpieces-disable no-symbol-di-tokens -- framework primitive; token is imported by external impls
```

A suppression must name the rule and state a reason on the same line. Where it is `false`
(`throw-cause-required`, `no-destructure`, `max-file-lines`), there is no hatch — comply or change the
config, and changing the config is a reviewed diff to a policy file.

### Reading the suppression census — the calibration loop

Because every suppression is a greppable, reasoned line, the census is a **first-class health metric
about the rules, not about the engineers**:

```bash
grep -rho "webpieces-disable [a-z-]*" --include="*.ts" packages apps | sort | uniq -c | sort -rn
```

Interpretation, and this is the part orgs get backwards:

- **A handful of suppressions** — the escape hatch working as designed. Ignore.
- **A rule suppressed in a specific *cluster*** (one package, one layer) — the rule is right but its
  scope is wrong. Add an `allowedPaths` entry, as `no-symbol-di-tokens` does for `libraries/apis/**`.
- **A rule suppressed in the *hundreds*, spread across the repo** — the rule is miscalibrated, and the
  org is paying a per-file annotation tax to keep a rule that is not describing the codebase it
  guards. **Fix the rule, not the files.** In this repository `no-any-unknown` and
  `no-function-outside-class` are both in that territory today, and that is a standing item, not a
  steady state.

A rule you cannot honestly suppress produces lies (dead code written to please a linter). A rule you
suppress by the hundred is not a rule. The census is what keeps the system between those two failures,
and running it should be a recurring agenda item, not an archaeology expedition.

---

## Part 4 — Why this is *org* practice and not repo config

The distinction that matters: **the engine is published, the dials are per-repo.**

`@webpieces/ai-hook-rules`, `@webpieces/code-rules`, `@webpieces/rules-config`, and
`@webpieces/pr-gate` ship to npm and are consumed as versioned dependencies. An adopting company
installs them and writes its own `webpieces.config.json`. So:

- N companies share **one** implementation of "what a rule is, how modes resolve, how epochs expire,
  how a suppression is spelled" — and each sets its own policy.
- A rule improved for one org is available to all of them on upgrade.
- A company can run the *process* guardrails (feature branches, gated PRs, stale-branch reads) with
  every code rule `OFF`, and adopt the code conventions later, one `mode` flip at a time.
- None of it requires adopting the webpieces *framework*. The practice layer and the framework are
  separable products that happen to live in one repository.

This is what makes it a practice rather than a config file: it is a **transferable mechanism for
installing conventions into an organization**, with the conventions themselves as swappable data. It
is deployed across multiple companies today — see [`ADOPTION.md`](./ADOPTION.md) for the track record.

---

## Part 5 — Rolling this out in your org

A sequence that does not produce a revolt:

1. **Install the engine, everything `OFF`.** Add `@webpieces/code-rules` + `@webpieces/ai-hook-rules`,
   write a `webpieces.config.json` with every rule `mode: "OFF"`. Nothing changes; the machinery is
   now present.
2. **Turn on the process guards first.** `branch-state-guard` and `branch-creation-guard` — two
   `hookGuards` keys. These are uncontroversial, they pay off immediately with AI agents, and they
   teach the org that the hook exists and is survivable.
3. **Pick your two highest-pain code conventions** — the ones you have already lost a code review
   argument about twice. Set them to `NEW_AND_MODIFIED_CODE` with an
   `turnOffRuleUntilEpoch` two weeks out. Announce the date; let the machine be the one that
   starts enforcing.
4. **Set `disableAllowed: true` initially** for anything new. Watch the census. Promote to `false`
   only once the suppression count is near zero — that is your evidence the rule fits.
5. **Adopt the testing rule last and hardest.** "Tests may be added to, never modified" is the one
   with the largest payoff and the largest cultural cost, because it forbids the reflex the whole
   industry has trained. Introduce it with
   [`architecture/testing-philosophy.md`](./architecture/testing-philosophy.md), not with a lint error.
6. **Review the census quarterly.** Delete rules nobody obeys. Widen `allowedPaths` where the
   suppressions cluster. The rule set is a living artifact; a static one rots into ceremony.

---

## Part 6 — Why this exists *now*

The practice layer would have been over-engineering in 2019. Three things changed.

**Volume.** An AI-accelerated team writes far more code per reviewer-hour. Human review was already
the bottleneck on consistency; it is now hopelessly outnumbered. The only conventions that survive
are the ones a machine holds.

**Agents don't read your wiki.** An agent has your prompt and your files. It does not have the
hallway conversation, the design review it wasn't in, or the tribal knowledge about why that module
is the way it is. A convention encoded as a hook message — *"here is what you did, here is why it is
wrong, here is the fix"* — is the only form of institutional knowledge an agent reliably receives,
and it arrives at the exact moment it is needed.

**Refactor scope exploded.** An agent can restructure an entire microservice in an afternoon. That is
only *safe* if the tests were never coupled to internals and were never allowed to be rewritten to
match — which is precisely convention #1, enforced by an append-only rule. Feature testing went from
"a nicer way to test" to **the enabling precondition for AI-scale refactoring**. The org that couples
tests to internals cannot use the most valuable thing AI does; it can only use AI to write more
coupled code faster.

That is the connection between the two halves of this document. The testing philosophy is not one
convention among four — it is the one that determines whether an organization can safely let AI
change its systems at all. The enforcement machine is what makes that convention hold across teams
who never met each other, and across agents who have never read a word of this file.

---

## Where to go next

- [`architecture/testing-philosophy.md`](./architecture/testing-philosophy.md) — the argument for
  feature tests, append-only, and why "internals tested only indirectly" is the goal.
- [`git-workflow.md`](./git-workflow.md) — the gated PR flow and the worktree/merge model.
- [`ADOPTION.md`](./ADOPTION.md) — production track record and context for reviewers.
- [`architecture/README.md`](./architecture/README.md) — the four load-bearing framework ideas.
- `webpieces.config.json` — the live policy for *this* repo; the rule schema is in
  `packages/tooling/rules-config/src/rule-configs.ts`.

## How to verify anything here
Every claim cites a real path. If a claim and the code disagree, the **code wins** — fix the doc.
