# FEATURE: service-URL resolution should be an injectable strategy, not ONE process-global deriver

**Package:** `@webpieces/core-util` (`src/http/ClientRegistry.ts`)
**Version seen:** the `ClientRegistry` / `ServiceUrlDeriver` pair as of the 0.4.6xx line
**Severity:** Low — **this is a design request, NOT a defect. Nothing is blocked. Read "What is
already supported" FIRST so nobody spends a day fixing a non-bug.**

**Source:**
- `packages/core/core-util/src/http/ClientRegistry.ts` — `addMapping` / `addUrlMapping` /
  `setDeriver` / `tryResolve` / `resolve`, and the `ServiceUrlDeriver` type above them.

## What is already supported — please read before starting

The precedence chain in `ClientRegistry.tryResolve` is **already** mapping-then-deriver, and the
docblock documents it:

> 1. a registered mapping wins — the localhost port table, AWS, an external API, another region or
>    project, a host that is not Cloud Run at all.
> 2. else the installed `ServiceUrlDeriver`, if any
> 3. else the caller's fallback

So all three of these work TODAY and need no change:

- a per-service exception — `ClientRegistry.addUrlMapping('svc-x', 'https://...')`, which beats the
  deriver because step 1 precedes step 2;
- arbitrary deriver logic — the `resolve()` error message itself suggests
  `setDeriver(s => gcpCloudRunDeriver()('tf-' + s))`;
- a deployed-name alias — the docblock's `serviceName` in the module's `project.json`.

We hit a real outage-shaped problem in a consumer repo (below) and the fix turned out to be a
one-line `addUrlMapping` in the consumer's own startup. **Webpieces was not at fault.** This ticket
is only about the ergonomics that made the right answer hard to find.

## The concrete incident that prompted this

In `acme-internal/consumer-monorepo`, a company-tier wrapper installs a deriver that unconditionally
prepends an environment prefix:

```ts
private static deployedNameDeriver(): (svcName: string) => Promise<string> {
  const derive = gcpCloudRunDeriver();
  return (svcName: string) => derive(`${TF_PREFIX}${svcName}`);   // ALWAYS prefixes
}
```

Every Cloud Run service in that estate follows the prefixed convention **except one legacy BFF**,
which predates it and is deployed under its bare name. A new server-to-server client naming that
peer resolved to `<prefix>-<peer>` — a service that does not exist.

**The failure mode is the bad part.** Cloud Run URLs are deterministic (`svc + projectNumber +
region`), so the deriver does not fail — it *successfully constructs* a syntactically valid URL for
a host that was never deployed. There is no `No URL for service "..."` throw, because resolution
"succeeded". The call goes out to a hostname that resolves to nothing. A wrong-host call is much
harder to read than a missing-mapping throw, and none of the existing safety nets fire:
`architecture:validate-runtime-architecture` verifies the MODULE name (which was correct), and the
build is green because nothing here is a type error.

## The request

Two things, either independently useful.

### 1. Make resolution injectable per client, not one global per process

`setDeriver` is a single process-global slot. A process that talks to two estates with different
naming conventions cannot express that in a deriver — it must fall back to enumerating explicit
mappings, which is exactly the table the deriver exists to avoid.

Sketch: let a client (or `ClientConfig`) carry an optional resolver, consulted before the global
chain, so the exception lives next to the client that needs it instead of in shared startup:

```ts
new ClientConfig('legacy-bff', { resolveUrl: () => process.env.LEGACY_BFF_URL })
```

This is the same shape `ClientRegistry` already uses for failure classifiers —
`addFailureClassifier(apiClass, ...)` is per-apiClass and consulted *before* the process default.
Resolution is the one axis that is still global-only, which reads as an inconsistency in an
otherwise per-client-overridable registry.

### 2. Give the prefixing convention a first-class exception list

If a per-client resolver is too big a change, a much smaller one: let a prefixing deriver be
built with exclusions, so the convention is declarative rather than an `if` inside a hand-rolled
lambda every consumer writes slightly differently:

```ts
prefixDeriver('tf-', gcpCloudRunDeriver(), { except: ['legacy-bff'] })
```

## Also worth considering: make the silent-success case loud

Independent of both options above, `gcpCloudRunDeriver` returning a well-formed URL for a service
that does not exist is the thing that actually cost us the time. Options, cheapest first:

- document the hazard on `ServiceUrlDeriver` — derivation is *string construction*, not existence
  proof, so a name typo surfaces as a connection failure at first call rather than at startup;
- an opt-in startup probe that resolves every svcName a process holds a client for and logs (not
  throws) the ones that do not answer.

## Not asking for

- Any change to the mapping-beats-deriver precedence — that is right, and it is what unblocked us.
- Removal of the process-global registry. The no-DI global is a deliberate, documented choice
  (matching `HeaderRegistry` / `LogManager`) and it is browser-safe. This asks only that resolution
  gain the same per-client override tier the failure classifiers already have.
