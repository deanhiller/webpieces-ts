# Edge Logging & Record/Replay Test Generation

> `LogApiCall` wraps **every** API edge — client outbound, server inbound, in-process, and the
> Cloud-Task enqueue — with one structured shape. Because both sides of a call log the *same
> contract identity*, the entire distributed call graph is reconstructable from logs alone. The
> **same** instrumentation, plus a recorder riding in context, turns one real request into a
> `.fixture.json` + a generated `.spec.ts`. High-level feature/integration tests become a byproduct
> of running the app.

---

## `LogApiCall` — one logging shape for every edge

`packages/core/core-util/src/http/LogApiCall.ts` (singleton `LogApiCall`, entry point
`execute(methodInfo, requestDto, method)`). Used by **both** sides — "used by BOTH server-side
(`LogApiFilter`) and client-side (`ProxyClient`) for one consistent logging shape across the
framework."

Four log lines per call (text form):
- `[API-{side}-req] {id} request=…`
- `[API-{side}-resp-SUCCESS] {id} response=…`
- `[API-{side}-resp-OTHER] {id} errorType=…` (a user/expected error → `warn`)
- `[API-{side}-resp-FAIL] {id} errorType=… error=…` (a server error → `error`)

where `id = {apiClass}.{methodName}` and `side ∈ {client, server}`. Captured fields: request body +
UTF-8 byte size, response body + byte size, and `durationMs`. There is **deliberately no
`statusCode`** — LogApiCall runs over in-process calls, pub-sub handlers, and cloud-task enqueues,
"none of which have an HTTP status." Correlation fields (`requestId`, `orgId`, …) are **not**
stamped here — a logging *backend* owns that, reading `RequestContext` on every record (see
[`context-propagation.md`](./context-propagation.md)).

### "Every edge" = both sides log the same identity
- **Server inbound** — `packages/http/http-routing/src/filters/LogApiFilter.ts` is "the OUTERMOST
  fixed framework filter (auto-installed at priority 1,000,000 on every route, above AuthFilter)."
  It logs request *and* response/failure for every call, over HTTP **or** via `createApiClient`.
- **Client outbound** — `packages/http/http-client-core/src/ProxyClient.ts` calls
  `LogApiCall.execute(new ApiMethodInfo('client', this.apiName, route.methodName), …)`, using the
  **contract** name so "this client log line MATCHES the server's for the same call."
- **Cloud-task enqueue** — `TaskProxyClient.enqueue` wraps the enqueue in `LogApiCall.execute` too,
  so the queue edge gets the same structured logging as HTTP "without touching either invoker."

Result: `jsonPayload.api.method.apiClass="SaveApi"` filters *both* sides of a call together, and you
can walk the call graph across services purely from logs.

## The structured tag — `ApiCallInfo` / `ApiMethodInfo`

`packages/core/core-util/src/http/{ApiCallInfo,ApiMethodInfo}.ts`. Stored under the object-valued
context key `API_CALL_INFO` (`name: 'api'`), which the winston/bunyan backends nest into
`jsonPayload.api`. Shape:
- `ApiMethodInfo`: `side` (`client`|`server`), `apiClass` (**required**, the contract),
  `methodName` (**required**), `controllerName?` (server impl class).
- `ApiCallInfo`: `method: ApiMethodInfo`, `type` (`request`|`response`), `result?`
  (`success`|`failure`), `durationMs?`, `requestSize?`, `responseSize?`.

**The field names here ARE the GCP field names** — rename a field and the filter renames with it.
Enabled GCP filters include:
- `jsonPayload.api:*` — **API traffic only** (tracing + the recorder)
- `jsonPayload.api.method.side="client"`
- `jsonPayload.api.result="failure"`
- `jsonPayload.api.durationMs>1000`

## Console rendering — `[API.{side}.{phase}]`

`packages/core/core-util/src/http/ApiCallLogName.ts` renders `LogApiCall` lines locally as a
self-describing `[API.{side}.{phase}]` bracket (phase ∈ `request`/`success`/`failure`) instead of
the opaque `[LogApiCall]`. Both backends call it (`winston/src/format.ts`,
`bunyan/src/streams.ts`). So on a local console **or** in GCP, you can filter to just the API edges:
grep `[API.` locally, or `jsonPayload.api:*` in Cloud Logging.

## `actionId` vs `requestId` (the filter that answers "what did this click do?")
Covered in depth in [`context-propagation.md`](./context-propagation.md#the-actionid--requestid-hierarchy).
Short version: one user action mints one `actionId`; it fans out to 1..N HTTP calls, each with its
own `requestId`; all share the `actionId`. Filter GCP by one `actionId` and you see every request —
across every service and even across a Cloud Tasks queue — that the click set in motion.

---

## Record / replay: tests as a byproduct of the same edges

The exact same edge instrumentation, plus a recorder object travelling in the request context,
captures a real request and emits a runnable test.

- **Inbound capture** — `packages/http/http-server/src/filters/RecordingFilter.ts` (priority ~1850,
  *below* the fixed framework filters, so only real authorized flows are recorded). Activated by
  `config.recordingAlwaysOn` or the `x-webpieces-recording` header. It creates a
  `TestCaseRecorderImpl`, stashes it in context (`RecorderKeys.RECORDER`), captures the server
  endpoint's success/failure response, and in `finally` calls `spitOutTestCase(...)`.
- **Downstream capture** — `packages/http/http-client-node/src/NodeProxyClient.ts` checks for a
  recorder in context; if present, `recordCall` captures each outbound call + its result "so it
  becomes a mock in the generated test." One request's whole downstream call tree is captured.
- **Emission** — `packages/http/http-server/src/recorder/TestCaseRecorderImpl.ts` writes two files
  to `recordingDir`:
  - `{name}.fixture.json` — the stable, diffable artifact (request, context snapshot, response, all
    downstream calls). "Also perfect input for an AI to write a richer spec from."
  - `{name}.spec.ts` — a small deterministic spec from `SpecGenerator`, priming mocks from the
    captured downstream calls (e.g. `createMock<Server2Api>('Server2Api')` +
    `addValueToReturn('fetchValue', …)`).

Proven end-to-end in `apps/app-example/client-server/src/test/Recording.spec.ts`: the inbound
endpoint (`SaveApi`) and the in-process downstream (`Server2Api`) are both recorded; the fixture and
spec are written; the generated spec contains the primed mock.

### The credential is *structurally* excluded from the recording
The context snapshot is built from `RequestContext.buildLogFields()` (masked, keyed by name). Since
`authorization` is **not a ContextKey at all**, it can never reach the snapshot — the test asserts
it directly:
```ts
// The credential is not a ContextKey at all, so it can never reach the ctx snapshot
expect(JSON.stringify(fixture.serverEndpoint.ctxSnapshot)).not.toContain('test-token-123');
```
This is the payoff of the "no credential keys in context" rule from the context doc: recordings are
safe to commit.

---

## Why this matters
- **Debugging is a log filter, not a guessing game.** One `actionId` (or one `apiClass`) reveals a
  full cross-service, cross-queue trace with durations and payload sizes.
- **AI-friendly by design.** The `jsonPayload.api:*` "API traffic only" filter and the
  AI-consumable fixtures mean an assistant can reconstruct system behavior or richer tests from
  artifacts the app already emits.
- **Feature tests write themselves.** Turn recording on, exercise a flow, commit the fixture +
  spec. The high-level integration test is a byproduct of running the real stack.

### Source map
| Concern | File |
|---|---|
| Edge logger | `core-util/src/http/LogApiCall.ts` |
| Structured tag | `core-util/src/http/{ApiCallInfo,ApiMethodInfo}.ts` |
| Console name | `core-util/src/http/ApiCallLogName.ts` |
| Server edge | `http-routing/src/filters/LogApiFilter.ts` |
| Client edge | `http-client-core/src/ProxyClient.ts` |
| Enqueue edge | `cloudtasks-client/src/TaskProxyClient.ts` |
| Recording | `http-server/src/filters/RecordingFilter.ts`, `http-server/src/recorder/TestCaseRecorderImpl.ts`, `http-client-node/src/NodeProxyClient.ts` |
| Proof | `apps/app-example/client-server/src/test/Recording.spec.ts` |
