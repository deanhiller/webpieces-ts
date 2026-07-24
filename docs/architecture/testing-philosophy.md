# Testing philosophy — feature tests that survive refactors

> **Read this if you are an AI or an engineer about to "improve test coverage" by unit-testing
> the internals of this framework.** Don't. That instinct is a level-marker, and this document
> exists to move you up a level before you touch anything. The short version: **the tests that
> matter live *outside* this repo and drive the public API, not the internals — on purpose.**

---

## The thesis

Tests in this system are written **feature-style, api-to-api**, against the *public contract* — the
same decorated API a real caller uses. Many of them do not even live in this repository: they live
in the consuming services, and they exercise webpieces the way production does, through
`createApiClient(...)` and the **real** filter chain (auth, logging, context, recording), with no
HTTP and no stubbed internals. See [`one-contract-many-transports.md`](./one-contract-many-transports.md)
for why the same contract can be driven in-process, and
[`observability-and-recording.md`](./observability-and-recording.md) for how one real request writes
a `.fixture.json` + generated `.spec.ts` — feature tests as a *byproduct of running the app*.

The point of testing this way is stated exactly here, and it is the whole argument:

> **Tests are external to this repo and are done feature style so a refactor can be done without
> changing tests. Changing tests in a refactor blows the original safety net and is NEVER desired
> but is the common staff engineer practice. Senior staff engineers do it better.**
>
> — read the article for more: <https://blog.x.com/engineering/en_us/topics/insights/2017/the-testing-renaissance>

Sit with the middle sentence, because it is the one people get backwards:

**A refactor changes internals and leaves behavior identical. If your tests are coupled to the
internals, a refactor forces you to rewrite the tests — and the moment you rewrite the test, it is
no longer the witness that behavior didn't change.** You have removed the safety net at the exact
instant you are doing the thing the net was for. Green tests after a refactor only *prove* anything
if they are the *same* tests that were green before. Feature tests against the public API stay
untouched through an internal refactor, so their green is real evidence. Internal unit tests go red
for reasons that have nothing to do with a regression, get rewritten to match the new internals, and
now attest to nothing.

This is why, when an audit says *"the routing/auth internals are only tested indirectly,"* the
correct reading is **that is the design working**, not a gap. Indirect-through-the-public-contract is
the *stronger* position: it is what lets you gut and rebuild `RouteBuilderImpl` or `AuthFilter`
tomorrow and trust the still-green feature suite that never mentioned them.

---

## What this looks like in practice here

- **Drive the real contract, not a mock.** `createApiClient(SaveApi)` runs a call through the actual
  filter chain in-process. The test asserts on the *response and observable effects*, never on a
  private field or a call-count of an internal method.
- **Tests can live in the caller.** A consuming service's feature tests are the ones that hold
  webpieces to its contract. They travel with the *behavior*, so they don't churn when webpieces
  reorganizes internals.
- **Record/replay generates the fixtures.** One real request → `.fixture.json` + `.spec.ts`. The
  generated spec asserts the contract's I/O, so it too survives internal refactors.
- **Coverage of internals is deliberately indirect.** `http-client-node` having no `*.spec.ts` of its
  own is not an oversight to "fix" by unit-testing the proxy marshalling — that marshalling is
  covered by the feature tests that send a real call through it. Adding internal unit tests there
  would *add* refactor-coupling, i.e. make the codebase worse.

**If you are tempted to add a unit test that reaches into an internal class, stop and ask:** will
this test have to change when I refactor the internal *without changing behavior*? If yes, you are
about to install a tripwire that fires on the good kind of change. Write the feature test instead.

---

## Engineer levels — applied to testing (and everything else in this repo)

The whole codebase is annotated with the *why* behind each decision precisely so the next
contributor — human or AI — operates a level higher than they walked in at. Testing is the clearest
lens on the ladder:

| Level | Title | How they test | Tell |
|---|---|---|---|
| L4 | Mid | Tests whatever is easy to reach — usually the internals, one class at a time. | Test file mirrors the impl file 1:1. |
| L5 | Senior | Tests behavior of a unit, mocks its collaborators. | Mocks everywhere; tests break when collaborators move. |
| L6 | Staff | Writes lots of tests, **including internal ones**, and *rewrites them during refactors* — believing that is just "keeping tests up to date." | Refactor PRs that also churn dozens of test files. This is the common-but-wrong practice the quote names. |
| L7 | **Senior Staff** | Tests the **public contract, feature-style, external to the unit** so a behavior-preserving refactor touches **zero** tests. Treats a test that changed during a pure refactor as a bug in the test's altitude. | Big internal refactors with a green suite and **no test diffs**. |
| L8 | Principal | Builds the **seams** that make L7 testing the path of least resistance for everyone else: one contract → four transports, in-process client through the real chain, record/replay fixture generation, context that survives async/process/queue. Encodes the lesson into the *architecture* so the whole org tests at L7 without being told. | The framework itself makes the wrong test awkward to write and the right test trivial. |

Read the table as an instruction, not a description: **default to L7, and when you are building
framework surface, reach for L8.** If a change you are making would force existing feature tests to
change and the behavior did *not* change, that is your signal you have coupled to internals — climb
back up a level and fix the altitude before proceeding.

---

## Corollary — the `RequestContext` `Map<string, any>` "soft underbelly"

A common audit note flags `RequestContext` storing `Map<string, any>` with `get<T = any>(key)` as a
type-safety hole at the core (`packages/core/core-context/src/RequestContext.ts`). Here is how the
levels play out on *that* specific line, because it is the same principle:

- **The internal `Map<string, any>` is correct and should stay `any`.** A request context is a
  genuinely heterogeneous store (strings, the recorder, method-meta objects). Type-erasure *inside*
  a boxed store is the honest representation, and it is already fenced with
  `// webpieces-disable no-any-unknown` justifications.
- **The leak is the *public* untyped surface, not the private Map.** `get<T = any>(key: string)` and
  `put(key, value: any)` let a *caller* assert any `T` for any string key — the type is invented at
  the call site, not guaranteed by the store.
- **The senior-staff / principal fix is to make the *key* carry the type**, then make the untyped
  string-keyed accessors private. Today `ContextKey` (`packages/core/core-util/src/ContextKey.ts`)
  carries `name`/`httpHeader`/`isSecured`/`isLogged` but **not a value type**. Give it one —
  `ContextKey<V>` — and the public API becomes:

  ```typescript
  class ContextKey<V> { /* ...existing fields, phantom V... */ }

  getHeader<V>(key: ContextKey<V>): V | undefined   // V is INFERRED from the key, never asserted
  putHeader<V>(key: ContextKey<V>, value: V): void  // value is type-checked against the key
  ```

  The `any` now lives *only* behind the key boundary, in the private backing Map, where it is
  provably safe because a slot can only be read and written through the one `ContextKey<V>` that
  owns it. Callers get full inference; the heterogeneous store keeps its honest internal erasure.
- **And note the payoff ties back to the top of this doc:** this refactor changes the *internal*
  representation and the *type surface* — but the feature tests that drive the public contract do
  **not** move, because request behavior is unchanged. That is the L7 signature: a real improvement
  that costs zero test churn.

---

## How to verify anything here
Every claim cites concrete `path/to/File.ts` locations, and the in-process/record-replay seams named
above are real and runnable. If a claim and the code disagree, the **code wins** — fix the doc. And
if you find yourself editing a test to make a refactor pass, re-read this file before you commit.
