# FEATURE: a verification hook so an `external` @Endpoint can PROVE its `calledBy`

**Packages:** `@webpieces/core-util` (decorators, `AuthMode`), `@webpieces/http-routing` (`AuthHooks`,
`AuthFilter`), `@webpieces/http-server` (`ExpressWrapper`)
**Version seen:** `0.4.639`
**Severity:** High — every inbound signed webhook (Sentry, Stripe, GitHub, Slack, Twilio) is
**unauthenticatable today**. The only reachable posture is `@Public`, and the consumer repo cannot fix
it from its side: the raw bytes the vendor signed are read and discarded before any app code runs.

## Symptom

`ctoteachings/monorepo2` needs a Sentry issue webhook on `lang-server`. Sentry signs the request with
`Sentry-Hook-Signature` — HMAC-SHA256 over the **raw JSON body**, keyed by the integration's client
secret. There is no way to check it.

The endpoint is declared the way the framework asks:

```ts
@Endpoint('/hook/sentry/issue', 'external', { calledBy: 'sentry' })
abstract notify(request: SentryIssueHook): Promise<HookAck>;
```

…and `calledBy: 'sentry'` is a **claim, not a fact**. The runtime graph now draws a `saas sentry` node
with an inbound arrow, which reads as "Sentry calls us here" — while in reality *anyone on the
internet* calls us there, and the graph's confidence is unearned.

## Evidence: the raw body is read, parsed, and thrown away

`@webpieces/http-server/src/ExpressWrapper.js`:

```js
// :56
const bodyText = await this.readRequestBody(req);
...
// :63-67  "JSON (default, SYMMETRIC with the client's JSON.stringify)"
requestDto = bodyText ? JSON.parse(bodyText) : {};
```

`bodyText` is a local. It is never attached to the request, never placed in `RequestContext`, never
passed to a filter. By the time a controller or an `AuthFilter` runs, the only artifact is the parsed
DTO.

**Re-stringifying the DTO is not a workaround, and it must not be offered as one.** `JSON.stringify`
of a parsed object is not byte-identical to what the sender transmitted: non-ASCII escaping, number
formatting (`1e3` vs `1000`), and duplicate-key resolution all differ. Sentry issue titles are
arbitrary user text and routinely contain non-ASCII. The failure mode is a signature check that passes
every test and 401s the first stack trace containing an emoji — silently, on exactly the traffic the
endpoint exists for. Worse than no check.

## Two gaps, and they are independent

**Gap 1 — the raw bytes are not retained.** Nothing in the framework can verify a body signature
because the body no longer exists in verifiable form.

**Gap 2 — there is no auth mode meaning "verify this with my code."** `AuthMode` is a closed union
(`decorators.d.ts:146`):

```ts
public | jwt | oidc | shared-secret | local-only
```

- `oidc` fits exactly one caller family: Google-signed callers (`GmailPushApi`'s Pub/Sub push). No
  SaaS vendor mints Google OIDC tokens.
- `shared-secret` is a **constant-time compare of a header against a bound secret**. No vendor sends
  its secret; they all send a *derivation* over the request. It does not fit.
- So `@Public` is the only option, and every signed webhook in every consumer repo is unauthenticated.

Gap 1 without Gap 2 gives you raw bytes and nowhere to check them. Gap 2 without Gap 1 gives you a
hook with nothing to verify. Both, or neither.

## The framework already knows this is coming

This is not a speculative need — the codebase names it twice:

- `EndpointOptions.formPost` exists **because Twilio posts form-encoded**: *"For EXTERNAL webhooks
  (e.g. Twilio) that post form-encoded"* (`decorators.d.ts:47-53`).
- `external-caller.ts`'s migration example is literally
  `@Endpoint('/inbound', 'external', { formPost: true, calledBy: 'twilio' })`.

The vocabulary for *who calls us* shipped. The mechanism for *proving it* did not.

## Critical design input: the vendors do NOT sign the same thing

A body-only seam is insufficient. Verify each against the vendor's own docs before implementing, but
the shape of the disagreement is the point:

| Vendor | Header | Signs over |
|---|---|---|
| Sentry | `Sentry-Hook-Signature` | raw JSON body |
| GitHub | `X-Hub-Signature-256` | raw body |
| Stripe | `Stripe-Signature` | `${timestamp}.${rawBody}`, plus a replay-tolerance window |
| Slack | `X-Slack-Signature` | `v0:${timestamp}:${rawBody}` |
| **Twilio** | `X-Twilio-Signature` | **the full request URL + sorted POST params — not the raw body** |

Twilio is the one that constrains the design. It signs the **absolute URL as the sender saw it**, so a
hook handed only `rawBody: Buffer` cannot verify Twilio at all — and Twilio is the vendor the framework
already built `formPost` for.

**Therefore the seam must be request-shaped, not body-shaped.**

### And the framework should NOT implement any of this crypto

Every one of these ships an official validator:

```
twilio.validateRequest(authToken, signature, url, params)
stripe.webhooks.constructEvent(rawBody, sig, secret)
@octokit/webhooks-methods  verify(secret, rawBody, signature)
```

Vendors rotate schemes (Twilio added a `bodySHA256` query param for JSON bodies; Stripe versions its
scheme in the header). A framework that reimplements them signs up to track five vendors' security
changelogs forever, and will be wrong at exactly the moment being wrong matters. **Hand the app enough
of the raw request to call the vendor's library. Ship zero vendor-specific code.**

## Suggested design — a third hook, symmetric with `JwtHook` / `OidcHook`

### Can the decorator reference a function in my codebase?

Not by direct reference, and it should not. `libraries/apis/**` is level 0 — an api contract that
imports a server-side verifier inverts the dependency graph the architecture rules exist to protect,
and it would drag a vendor SDK into the browser bundle that imports the same contract.

**Reference it by NAME and resolve through DI.** This is not a compromise; it is precisely what
`@AuthOidc('gmail-push')` already does — a bare string on the contract, resolved to real behavior in
the server's container. Symmetric with both existing hooks:

```ts
// 1. CONTRACT (level 0, no server import, browser-safe)
@AuthWebhook('sentry')
@Endpoint('/hook/sentry/issue', 'external', { calledBy: 'sentry', rawBody: true })
abstract notify(request: SentryIssueHook): Promise<HookAck>;

// 2. FRAMEWORK — mirrors JwtHook / OidcHook exactly
export abstract class WebhookAuthCallback {
    /** Verify one inbound request. Return to allow; throw HttpUnauthorizedError to deny. */
    abstract verify(name: string, request: RawHttpRequest): Promise<void>;
}
export declare const WEBHOOK_AUTH_CALLBACK: unique symbol;

// 3. APP — AppModule.ts, beside the CompanyJwtHook binding
options.bind(WEBHOOK_AUTH_CALLBACK).to(CompanyWebhookAuthCallback);
```

`AuthMode` gains one member: `{ kind: 'webhook'; name: string }`.

Unbound `WEBHOOK_AUTH_CALLBACK` must **fail closed with 401**, matching `JwtHook`'s documented behavior
(*"When NO JwtHook is bound, the framework AuthFilter treats every jwt endpoint as 'not enabled' and
fails fast (401)"*). Silently allowing an unverified webhook is the one default that must not exist.

### The hook's input

```ts
interface RawHttpRequest {
    method: string;
    url: string;                          // ABSOLUTE, as the SENDER saw it — see below
    headers: Readonly<Record<string, string>>;
    rawBody: Buffer;                      // Buffer, not string — no encoding assumption
    remoteAddr?: string;
}
```

`Buffer` rather than `string`: some schemes sign bytes, and a `string` bakes in a UTF-8 decode that a
non-UTF-8 body would corrupt before the app sees it.

**The absolute URL is the subtle part and is worth getting right the first time.** Behind Cloud Run,
express's `req.url` is the path only, `req.protocol` reads `http` (TLS terminates at the edge), and
`req.host` is the internal host. Twilio signs the public `https://...` URL the customer configured, so
naive reconstruction fails 100% of the time in production and works 100% of the time locally — the
worst possible pairing. Either honor `x-forwarded-proto` / `x-forwarded-host` (with `trust proxy`
configured), or let the app declare its public base URL in config. Whichever you pick, say in the
doc comment which one it is, because an app that guesses wrong gets a signature mismatch with no
diagnostic pointing at the URL.

### Raw-body retention: opt-in per endpoint

`{ rawBody: true }` on `EndpointOptions`, sitting beside `formPost` — the same shape of switch, so the
cost lands only on webhook routes rather than on every request in the process. Cheap to implement:
`ExpressWrapper` **already accumulates the entire body** (`readRequestBody`, `:116-126`); it just
discards it. This is retention, not new buffering.

Pair it with a max-size cap. An unauthenticated endpoint that buffers an unbounded body is a memory
DoS, and today's `readRequestBody` has no limit — that is a pre-existing issue this feature makes
materially easier to exploit, since a webhook URL is public by construction.

### Ordering: verify BEFORE parse

`AuthFilter` must run the hook on the raw request **before** `JSON.parse`. Two reasons:

1. A malformed body from an unauthenticated caller should 401, not 400. Parsing first leaks
   *"your JSON was bad"* — and therefore *"I got past auth"* — to an unauthenticated caller.
2. The current code throws `HttpBadRequestError` from the parse (`:71`). On a public webhook endpoint,
   that is a free oracle.

The parsed DTO is still delivered to the controller exactly as today. Verification is orthogonal to
routing; nothing about the controller signature changes.

## Acceptance checks

1. `@Endpoint(path, 'external', { rawBody: true })` delivers the exact transmitted bytes to the hook,
   byte-identical for a body containing multi-byte UTF-8, an emoji, and a float in exponent notation.
2. `@AuthWebhook('sentry')` compiles on a contract in a level-0 api lib with **no** import of any
   server or vendor package, and the contract still builds into a browser bundle.
3. A bound `WebhookAuthCallback` that throws yields **401** and the controller method is never entered.
4. An **unbound** `WEBHOOK_AUTH_CALLBACK` yields 401 on every `@AuthWebhook` endpoint — fail closed, matching
   `JwtHook`.
5. The hook receives an absolute `url` matching what the sender addressed, **verified behind a proxy
   that terminates TLS** (`x-forwarded-proto: https`), not only on localhost.
6. `{ formPost: true, rawBody: true }` together give the hook the raw bytes **and** the controller the
   flat parsed DTO — the Twilio case, which needs both.
7. A malformed body on an `@AuthWebhook` endpoint returns 401, not 400.
8. `assertEveryEndpointHasAuthMode` accepts `webhook`; `DestinationTrust.forAuthMode` classifies it
   (it is a verified caller, not `public`).
9. A `rawBody` request over the configured cap is rejected without buffering it.
10. **Testability:** a spec can rebind `WEBHOOK_AUTH_CALLBACK` to a `TestWebhookAuthCallback` in `appOverrides`, the way
    `TestJwtHook` / `TestOidcHook` already work — so a consumer whose entire test discipline is
    "build the real server, drive it through `createApiClient`" can feature-test a webhook route
    without real vendor signatures.

Check 10 is not a nicety. In `monorepo2` every `*.spec.ts` builds the whole server and drives it only
through generated clients, with `TestJwtHook` bound over `JWT_HOOK`. A webhook auth mode with no
mockable seam is an endpoint that cannot be tested there at all.

## Non-goals

- Shipping vendor-specific verifiers. No `@webpieces/twilio`. The app calls the vendor's own library.
- Retrying, deduplicating, or queueing webhook deliveries. Delivery semantics are the app's.
- Changing `rpc` / `cloudtasks` / `cron` endpoints in any way.

## What the consumer does in the meantime

`monorepo2` will ship the Sentry endpoint with a high-entropy path segment
(`/hook/sentry/<32 random chars>`, secret from the mounted config, constant-time compared) and
`@Public`. It is real entropy and it unblocks the work, but it is strictly worse than a signature: the
secret lands in Cloud Run access logs and in any proxy log between Sentry and the container, rotating
it means reconfiguring the vendor by hand, and it proves possession of a URL rather than authorship of
the request. That endpoint is the first thing that should migrate once this ships.
