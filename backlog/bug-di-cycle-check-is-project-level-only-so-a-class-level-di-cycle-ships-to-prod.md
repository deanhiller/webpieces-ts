# BUG: the cycle check is PROJECT-level only, so a class-level DI cycle ships to production — three times in the same consumer repo

**Package:** `@webpieces/nx-webpieces-rules`
(`src/executors/validate-no-architecture-cycles/executor.ts`, `src/lib/di-graph/**`)
**Version seen:** `0.4.723`
**Severity:** High — not a build failure. The DI graph the generator already emits contains the cycle,
`assertAcyclic` already exists, and nothing connects the two. The consumer's build goes green and the
browser app fails to bootstrap for every user.

**Source:**
- `packages/tooling/nx-webpieces-rules/src/executors/validate-no-architecture-cycles/executor.ts` —
  its own header says it plainly: *"This is a fast check that only validates acyclicity **at the
  project level**."*
- `packages/tooling/nx-webpieces-rules/src/lib/di-graph/analyzer.ts` — builds the CLASS-level edges,
  writes them to each project's `design.json`. Nobody walks them for cycles.

Found in `ctoteachings/monorepo` (lang-angular), production outage 2026-09-03.

## The bug

The DI graph generator emits class-level edges into `design.json`, and `di-graph-generate` already
runs inside the `ci` target of every project. So the data needed to detect a class-level DI cycle is
already generated, on every build, in every consumer repo. It is never examined.

The three cycle checks that DO exist all pass on a graph that is cyclic:

| Existing check | Operates on | Why it passed |
|---|---|---|
| `validate-no-architecture-cycles` | nx **project** graph | both classes are in the same project |
| `generate` executor's `assertAcyclic` | nx **project** graph (build graph) | same |
| `no-file-import-cycles` | **file imports** | the edge is a DI **token**, not an import |

A DI edge and an import edge are not the same edge. `GlobalErrorHandler` injects
`NavigationTrackerService` by class, and `NavigationTrackerService` injects the `ErrorHandler` TOKEN —
which resolves back to `GlobalErrorHandler` through a provider, with no import between them to see.
That is the whole gap in one sentence.

## What it cost

Angular resolves `ErrorHandler` before anything else, so every eager field below it is constructed
while `ErrorHandler` is still half-built. A cycle there is not a degraded feature — it throws
`NG0200` during bootstrap, the app never starts, and a native shell's watchdog retries forever with
nothing naming the cause.

```
global-error-handler.ts:38  export class GlobalErrorHandler implements ErrorHandler
global-error-handler.ts:43      private navTracker = inject(NavigationTrackerService);
nav-tracker.service.ts:24       private errors     = inject(ErrorHandler);
```

**This has now taken the same site down three times** — twice in 2026 via the service-worker stack,
and again when an unrelated lint sweep added `inject(ErrorHandler)` to a service that the error
handler already injected. Each time the cure was applied to the one edge that broke and the invariant
was written down as PROSE, which is why it returned.

Worth stating because it shapes the fix: **a LAZY edge is not a fix.** `inject(Injector)` +
resolve-at-call-time and `forwardRef` leave the cycle in the design and only hide it from Angular's
detector. The consumer's rule is to push the shared code DOWN into a lower module both sides depend
on (`A → D`, `C → D`, with a listener on `D` when the lower layer must notify the upper ones). That
matters here because it decides the rule's shape: **if lazy were an accepted cure the check would
need to exempt lazy edges, and that exemption rots.** With push-down as the rule, "the class DI graph
is acyclic" is absolute and needs no per-edge escape hatch.

## Proposed fix

‼️ **`design.json` IS NOT ENOUGH, and this was measured rather than assumed.** The obvious fix —
walk the edges already in `design.json` and hand them to `assertAcyclic` — DOES NOT WORK, and the
consumer verified it while fixing the outage:

- `di-graph-generate` builds its trees from **component roots**. `GlobalErrorHandler` is not a
  component and is not reachable from one, so it appears in **neither** app's `design.json`
  (grep count: 0).
- `ErrorHandler` appears there only as a **spec-derived constant** — the generator picked
  `new ErrorHandler()` out of `*.spec.ts` files — not as the app's real provider.

So the cyclic pair is absent from the very artifact a `design.json`-based check would read. A rule
built that way would report zero cycles on the exact commit that took production down, which is
worse than no rule: it would be believed.

**Two things the executor therefore has to do that the generator does not:**

1. **Enumerate from the injector's real roots**, not from component roots — `ErrorHandler` and every
   other root-provided service, including classes no component references.
2. **Resolve provider ALIASES.** The cycle only exists once `useExisting`/`useClass` is followed:
   `NavigationTrackerService` injects the `ErrorHandler` TOKEN, and only the provider mapping says
   that token is `GlobalErrorHandler`. Without alias resolution the edge does not exist at all.

The consumer's working implementation reads SOURCE and resolves those aliases, and demonstrates the
rule failing on the pre-fix commit (naming
`GlobalErrorHandler -> NavigationTrackerService -> GlobalErrorHandler (via the ErrorHandler token)`
with file:line per hop) and passing after. Either extend `di-graph-generate` to emit root-provided
services and alias-resolved edges — which would also make `design.json` itself more truthful — or
have the executor do its own pass. The first is better, because a `design.json` that omits the
application's error handler is a defect on its own.

**Scope note:** eager edges only. A lazy edge (`inject(Injector)` + resolve later, `forwardRef`) is
deliberately NOT reported, so the rule stays exemption-free — see the push-down argument above. Lazy
cycles are review's job, not the build's.

## Rollout — this MUST land dark

Turning a new cycle check on unconditionally would hard-fail the build of every consumer that already
has a cycle, at upgrade time, with no warning. That is the opposite of useful. It needs the same
staged controls the other rules have, so a repo can adopt it deliberately:

1. **`mode`** — ships `OFF` (or report-only), not `RUN_EVERY_TIME`. Per `addToWebpiecesConfig.md`
   step 4: *"a rule that arrives armed and a rule that arrives OFF are different promises to a
   consumer."* This one must arrive disarmed.
2. **`turnOffRuleUntilEpoch`** — the existing escape so a repo can adopt the version, see its
   cycles reported, and fix them on a deadline instead of stopping work.
3. **An EXCLUDED-PROJECTS list** — so a repo can arm the rule for the projects it has cleaned and
   keep the rest reporting. Without it adoption is all-or-nothing, which in practice means the rule
   is switched off entirely and protects nothing. A per-project opt-in is what makes an incremental
   cleanup possible in a large monorepo.

A report-only phase is worth more than usual here, because the finding is a CHAIN rather than a line
number — a consumer needs to see its real chains before deciding how to push them down.

Note the two-PR sequence in `backlog/addToWebpiecesConfig.md` applies: PR 1 is source only
(`packages/tooling/**`), then publish, then PR 2 is `webpieces.config.json` + the `catalog:` pin in
one commit. Adding the key in the same PR as the code wedges the consumer, because the INSTALLED
validator has never heard of it.

## Also worth fixing alongside

The `design-graph-reviewer` checklist that ships as guidance tells its reviewer to **skip
cycle-checking**. In the outage above, that reviewer read the diff, reported *"124 added edges, every
one targeting Angular's `ErrorHandler` token"*, verified only that the direction looked sensible, and
passed it. The one reviewer looking at the DI graph was instructed not to look for the defect. Even
before the executor exists, removing that instruction would have caught this.
