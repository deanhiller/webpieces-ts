# Testing philosophy — feature tests that survive refactors

> **Read this if you are an AI or an engineer about to "improve test coverage" by unit-testing
> the internals of this framework.** Don't. The short version: **the tests that matter live
> *outside* this repo and drive the public API, not the internals — on purpose.**

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

## Why this is not the way the market tests

Feature testing the way this project does it is a notch above what the typical staff engineer
practices — and that is not a boast, it is just uncommon: something like 99% of the field, staff
engineers included, tests the way the market tests, and does not know the mechanics below or why they
matter. The market way couples tests to internals, so **you cannot refactor a service without blowing
your safety net and rewriting all the unit tests** — and the instant you rewrite the test, it stops
being the witness that behavior did not change. This project instead lets client projects do
**api-to-N-mock-api testing**: a real call driven through the public contract with every *other* API it
touches mocked out, recorded from a real run. That is the seam that lets an AI **refactor an entire
microservice** at once. As long as the client adds a build rule that **tests may only be added to,
never modified**, every legacy path keeps working under the refactor — the tests the AI never saw and
does not know about are exactly the ones still holding the old behavior in place. The *only* time a
test is deleted is on a **pivot** — removing or replacing an endpoint — and even then you delete only
the tests that reference it as dead, and only once that endpoint has **zero traffic in production**.
The result is tests that **live long-term and actually catch bugs**, instead of the market pattern
where an AI (or a human) just keeps changing the tests to make the build green — which guards nothing,
because it does not know which previously working paths still need to keep working.

The one durable heuristic, if you take nothing else: if a change would force existing feature tests to
change while the behavior did *not* change, treat that as a smell — you have probably coupled a test to
internals. Look twice before you rewrite the test. Write the feature test instead.

---

## Corollary — the `RequestContext` `Map<string, any>` "soft underbelly"

A common audit note flags `RequestContext` storing `Map<string, any>` with `get<T = any>(key)` as a
type-safety hole at the core (`packages/core/core-context/src/RequestContext.ts`). The audit is
half-right, and getting the other half right is what produces the fix. **This is now implemented —
`ContextKey<V>` shipped — and the reasoning below is why.**

### Why the store CANNOT be `Record<string, string>`

The instinctive "fix" is to type the map as `Record<string, string>` (or `Map<string, string>`). That
is impossible here, because a request context deliberately holds **four genuinely different kinds of
value**, and only some of them are strings:

1. **Transferrable security / identity keys** — `userId`, `orgId`, `tenantId`, `requestId`, roles.
   Strings, and they ride *over the wire* (their `ContextKey` has an `httpHeader`), so they propagate
   across service hops. See [`context-propagation.md`](./context-propagation.md).
2. **Log / correlation strings** — `requestId`, `actionId`, `requestPath`, `controller`, `method`.
   Strings, stamped so every log line of the request carries them.
3. **The live `TestCaseRecorder` — NOT a string.** This is the advanced bit: a real object sitting in
   the context that *records* an API call as it runs, and on completion **generates a full test case
   with every other API it called mocked out** (see
   [`observability-and-recording.md`](./observability-and-recording.md)). You cannot flatten a
   stateful recorder object into a `string`.
4. **Object payloads for structured logging** — `ApiCallInfo` under the `api` key, nested by the
   winston/bunyan backends into `jsonPayload.api.*`. An object, not a string.

Force all of that into `Record<string, string>` and you would have to serialize the recorder and the
`ApiCallInfo` object to strings and reparse them on every read — throwing away their identity and
their behavior. **A heterogeneous store is heterogeneous. Its backing map is *honestly* type-erased
(`Map<string, unknown>` internally), and that is correct.** The `// webpieces-disable no-any-unknown`
fences on it are not debt; they are the truthful annotation of a box that holds mixed types.

### The real leak, and the shipped fix: `ContextKey<V>`

The problem was never the internal erased map — it was the **public, untyped surface** over it. The
old `getHeader<T = unknown>(key)` and `putHeader(key, value: unknown)` let a *caller* assert any type
for any key: the type was invented at the call site, not guaranteed by the store.

The fix moves the type onto the **key**. `ContextKey` already carried
`name`/`httpHeader`/`isSecured`/`isLogged`; it now also carries the **type of the value stored under
it** as a phantom parameter `V` (`packages/core/core-util/src/ContextKey.ts`):

```typescript
class ContextKey<V> {                      // V = the value's type; REQUIRED, no default
    declare readonly __valueType?: V;      // inference-only phantom, no runtime cost
    // ...name, httpHeader, isSecured, isLogged unchanged...
}

// Each key MUST declare its value type at the one place it is defined — a bare
// `new ContextKey('x')` no longer compiles, so legacy keys are forced to state what they hold:
static readonly USER_ID = new ContextKey<string>('userId', 'x-user-id');
static readonly API_CALL_INFO = new ContextKey<ApiCallInfo>('api', undefined, false, true);
static readonly RECORDER = new ContextKey<TestCaseRecorder>('webpieces-recorder', undefined, false, false);

// The public accessors INFER V from the key — the caller never asserts it:
getHeader<V>(key: ContextKey<V>): V | undefined   // returns exactly the key's value type
putHeader<V>(key: ContextKey<V>, value: V): void  // value is type-checked against the key
```

**Why no default `= unknown`?** A default would let a legacy `new ContextKey('x')` keep compiling as
`ContextKey<unknown>`, silently keeping the old untyped behavior. Removing it turns every un-migrated
key into a **compile error** until it declares its value type — the type system does the migration,
and there is no way to accidentally stay untyped.

A genuinely mixed collection of keys (e.g. the `HeaderRegistry`'s arrays, `getAllHeaders()`) is spelled
with the one sanctioned alias **`AnyContextKey = ContextKey<unknown>`** — never a bare `ContextKey`.
Naming the mixed case makes "I mean a key of any value type" a *deliberate, visible* statement, and
confines the single justified `unknown` (and its `webpieces-disable no-any-unknown`) to that one alias
instead of scattering it across the codebase.

Now `RequestContext.getHeader(WebpiecesCoreHeaders.USER_ID)` is typed `string | undefined`,
`getHeader(RecorderKeys.RECORDER)` is typed `TestCaseRecorder | undefined`, and putting a number under
a `ContextKey<string>` is a **compile error**. The `unknown` lives *only* behind the key boundary, in
the erased backing map, where it is provably safe because a slot can only be read and written through
the one `ContextKey<V>` that owns it. Callers get full inference; the heterogeneous store keeps its
honest internal erasure. (Two genuinely key-agnostic loops — building outbound wire headers and the
flat log-field map — still read by `key.name` as strings via `AnyContextKey`, because there the code
legitimately does not know or care which key it holds.)

### The tie-back to testing

This refactor changed the *type surface* of the core and the *internal* representation — and it
touched **zero** feature tests, because request behavior is identical. The still-green suite is
therefore real evidence the change was safe: a genuine improvement that the safety net witnessed
without being disturbed. That zero-test-churn is the whole point — it is what "tests may only be added
to, never modified" buys you.

---

## How to verify anything here
Every claim cites concrete `path/to/File.ts` locations, and the in-process/record-replay seams named
above are real and runnable. If a claim and the code disagree, the **code wins** — fix the doc. And
if you find yourself editing a test to make a refactor pass, re-read this file before you commit.
