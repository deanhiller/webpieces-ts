# BUG: the api scanner resolves only string literals, so a contract whose paths are constants vanishes from `apiContracts` — and its sibling ships a wrong `basePath`

**Package:** `@webpieces/nx-webpieces-rules` (`src/lib/api-usage/api-scanner.js`, `src/lib/runtime-graph.js`)
**Version seen:** `0.4.490`
**Severity:** High — not a build failure. The generated architecture graph silently under-reports the
most queue-heavy service in the repo, and one entry is *present and wrong* rather than absent, so a
consumer computes a confidently incorrect URL.

**Source:**
- `packages/.../nx-webpieces-rules/src/lib/api-usage/api-scanner.js` (`apiClassInfoFromNode` / decorator arg resolution)
- `packages/.../nx-webpieces-rules/src/lib/runtime-graph.js` (`addQueuedEdges`, `buildTriggers` — both read `methodsOf(api)`)

Distinct from [`bug-api-scanner-silently-drops-services-without-tsconfig-paths`](./bug-api-scanner-silently-drops-services-without-tsconfig-paths.md)
(that one is about project resolution; this one is about decorator argument resolution).

Found upgrading `acme-internal/consumer-monorepo` 0.4.487 -> 0.4.490 (their PR #757).

## The bug

`libraries/apis/whatsapp-api/src/apis/whatsapp-api.ts` declares two API classes. One is captured, one
disappears entirely:

| Class | `@ApiPath` arg | `@Endpoint` path args | `basePath` emitted | Methods emitted |
|---|---|---|---|---|
| `PgDataApi` | `'/pg-data'` literal | literals | yes | 8 |
| `ReporterTriggerApi` | `'/api'` literal | literal | yes | 1 |
| `ReportsDispatcherApi` | `'/reports-dispatcher'` literal | literals | yes | 2 |
| `TeamDashboardsApi` | `'/team-dashboards'` literal | literals | yes | 2 |
| `WhatsAppTestApi` | `WHATSAPP_API_PATH` **const** | `'/test'`, `'/pg-security-test'` literals | **no** | 2 |
| `WhatsAppApi` | `WHATSAPP_API_PATH` **const** | all three **const** | no | **0 — class omitted** |

`WhatsAppTestApi` is the control that isolates the variable: same file, same `@ApiPath` constant, and it
survives. `@PubSub` is not implicated — `ReportsDispatcherApi` is also pubsub-kind and is captured in
full. The only difference is literal vs identifier **endpoint path** arguments. All three of
`WhatsAppApi`'s methods resolve to nothing, giving a zero-method class, which is then dropped.

This recurs for any contract that hoists its path to a shared constant — good practice, and exactly what
this file does deliberately so `ai-chat` can import the same symbols.

## Consequence 1 — real infrastructure missing from the graph

```json
"queues": { "ReportsDispatcherApi.fireReport": { … } },
"triggers": [ { "kind": "cron", "api": "ReportsDispatcherApi", "method": "runPeriod", … } ]
```

Absent: `WhatsAppApi-process` and `WhatsAppApi-continueConversation`, both declared `'cloudtasks'`, both
existing as `google_cloud_tasks_queue` resources in the consumer's `terraform/services/ai-chat.tf:33-98`.
Also absent: the `'external'` Twilio inbound trigger, though `buildTriggers`' own doc comment says every
`cron` or `external` method should produce one. The ai-chat self-edge is emitted with no `queue` field
while the reports-dispatcher edge has one.

Nothing is unprovisioned — the GCP resources exist. But the graph is being introduced as the
machine-readable source of truth for precisely this kind of audit.

## Consequence 2 (worse) — a present-but-wrong entry

An absent key is detectable; a consumer iterating `apiContracts` simply never sees `WhatsAppApi`. But
`WhatsAppTestApi` is present and looks complete:

```json
"WhatsAppTestApi": {
  "owner": "@acme-internal/whatsapp-api",
  "apiKind": "rpc",
  "methods": [ { "name": "test", "path": "/test", … } ]
}
```

Every other entry carries `basePath`, so a consumer has no reason to treat it as optional. Joining
`basePath + path` yields `/test`; the real route is `/whatsapp/test` (`WHATSAPP_API_PATH = '/whatsapp'`).
Any drift check, dashboard, or runbook generator built on this table emits a wrong URL rather than an
obvious hole.

## Suggested fixes

- **A — resolve same-module `const` initializers.** Fixes the class of bug; benefits every future
  contract. `Risk: Low | Effort: M | Impact: High`
- **B — warn when a decorator argument is a non-literal.** Does not fix the data, but converts a silent
  gap into a visible one. `Risk: Zero | Effort: S | Impact: Med`
- **C — make `basePath` required in the schema that validates the generated file**, so generation fails
  rather than shipping an entry that computes the wrong URL. Valuable independently of A.
  `Risk: Zero | Effort: S | Impact: Med`

**B and C now, A as the real fix.** Inlining the literals consumer-side was considered and rejected: it
trades a detectable problem for an invisible one, and the next author unknowingly undoes it.

## Minor, same area — `queueName` emitted for synchronous `rpc` methods

`apiContracts` assigns e.g. `"queueName": "PgDataApi-getUserDataByPhone"` to all eight `rpc` methods,
none of which has or needs a Cloud Tasks queue. Harmless today because `queues` correctly contains only
the `cloudtasks` method, but it is one naive `Object.values(...).map(m => m.queueName)` away from a tool
provisioning queues for synchronous endpoints.

## Not a bug — verified, and worth a release note

`kind` is metadata-only at runtime. `getEndpointKind` / `ENDPOINT_KINDS_BY_API_KIND` are read only by
`core-util/src/http/decorators.js` and `nx-webpieces-rules/src/lib/api-usage/api-scanner.js`;
`http-routing`, `http-server`, and `http-client-core` never read them. The single runtime effect is
`assertPubSubConventions` (`decorators.js:503-511`) throwing at wiring time for a kind outside the
ApiKind's allowed set — a loud failure, not a silent misroute. This was the one open question on the
consumer-side review of the 0.4.490 upgrade; one line in the release notes would close it.

## Separately: the `@Endpoint(path, kind)` break landed without a migration message

The `success` -> tri-state `status` break in the same release printed a loud, specific migration note.
The `@Endpoint` required-`kind` break surfaced as raw `TS2554: Expected 2-3 arguments, but got 1` across
five API libraries. The `.d.ts` prose on `EndpointKind` was good enough to classify all 18 call sites
without external docs, so this is minor — but the two breaks in one release gave very different
experiences.
