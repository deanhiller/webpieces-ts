# FEATURE: a client must accept a RUNTIME base URL, so contracts reach partner-registered endpoints

**Packages:** `@webpieces/http-client-core`, `@webpieces/http-client-node` (`createApiClient`,
`ClientConfig`), `@webpieces/core-context` (`ContextKey`)
**Version seen:** `0.4.685`
**Severity:** High — today the framework's answer for "POST our contract to a URL the customer gave
us" is **give up and use axios**. Every outbound webhook, callback and per-tenant endpoint falls out
of the typed world entirely, and takes the architecture graph with it.

## Symptom

`mealco-internal/monorepo-nx` just shipped `services/public-webhooks`, a webpieces service whose
entire job is to POST a published contract payload to a partner's own HTTPS endpoint. Everything
INBOUND is properly webpieces — `@PubSub`, `@Endpoint('/deliver', 'cloudtasks')`, `@AuthOidc`. The
final hop out is raw `axios`, hand-rolled headers, hand-rolled `JSON.stringify`.

Not because anyone preferred that. Because **the destination is a database column**:

```
OrganizationWebhook.url   text NOT NULL     -- e.g. https://api.bw.sizl.io/ot-webhook
```

One row per partner, edited at runtime, unknown at build time, different per organization. A
generated client binds its host at construction from `ClientConfig`, so there is nothing to generate
a client *from* and nowhere to point it.

The consuming repo's own lint rule has had to carve out a permanent exception for this, and the
justification comment is now copy-pasted into a second service:

```ts
// webpieces-disable no-fetch -- no API contract is possible here by construction. This client
// POSTs to URLs that PARTNERS register at runtime (OrganizationWebhook.url); the target is
// arbitrary and unknown at build time, so there is nothing to generate a typed client from.
// This is the rule's "truly external service" case.
```

**That comment is wrong about the cause.** A contract *is* possible — the payload is fully specified
(`libraries/apis/partner-apis/management-api`, `WebhookEnvelope` plus one class per event type, all
published to customers). The only unknown is the **host**. The framework conflates "I do not know
the shape" with "I do not know the address", and refuses both.

## What this costs, concretely

Everything a generated client would have given us was re-implemented by hand in the delivery path:

| Lost | Hand-rolled instead |
| -- | -- |
| Typed request body from the contract | `Record<string, unknown>` |
| Serialization owned by the client | `JSON.stringify` at the call site — and it had to be, because the body is HMAC-signed and axios re-serializing internally would have signed one byte sequence and sent another |
| Headers | assembled literal-by-literal |
| Timeouts / redirect policy | `maxRedirects: 0` set by hand (a partner URL that 302s could otherwise bounce our POST at an internal address — the service is on a VPC connector) |
| A node in the architecture graph | nothing; the outbound edge is invisible |

That last row is the compounding one. `check-service-naming` / the api-relations scan build the
runtime graph from contracts and clients. An `axios` call is not a client, so **the most
security-sensitive hop in the system — us POSTing to a stranger's server — does not appear in the
graph at all.**

## The ask

Let a client take its base URL at **call time**, overriding whatever `ClientConfig` bound at
construction. Dean's suggested shape:

```ts
ContextKey.OVERRIDE_BASE_URL     // or OVERRIDE_HOST_PORT
```

so a caller can do roughly:

```ts
await RequestContext.with(ContextKey.OVERRIDE_BASE_URL, webhook.url, () =>
  partnerWebhookClient.deliver(envelope),
);
```

A context key fits the existing propagation model and needs no signature change on every generated
method. A per-call options argument would work too; the context form is nicer for a fan-out loop
that reuses one client across N partner URLs in the same process.

### Requirements that make it actually usable

1. **It must not weaken the default.** A client with no override behaves exactly as today. An
   override applies to one call, never leaks into the next, and never mutates the client.
2. **The graph must still draw the edge**, with the target as a *runtime* node rather than a named
   service — the point is to stop this hop being invisible. An `@externalSystem`-style annotation on
   the contract ("this client's host is supplied at runtime") would let the scanner render it
   honestly instead of dropping it.
3. **SSRF is the framework's problem now, not the caller's.** The moment the base URL is
   attacker-influenced data, someone has to enforce scheme allowlisting, refuse RFC1918 /
   link-local / metadata addresses, and refuse redirects to them. Today every consumer reinvents
   that, badly or not at all. A client that accepts a runtime host should ship that policy on by
   default, with an explicit opt-out for internal use.
4. **Raw-body access for signing.** Outbound partner webhooks are HMAC-signed over the exact bytes
   sent. If the client owns serialization, it must expose the serialized bytes to a
   sign-before-send hook — otherwise consumers are forced back to hand-serializing, which is
   exactly what happened here.

## Why this generalizes well beyond one repo

Any destination that is *data* rather than *deployment* hits this:

- outbound webhooks to customer-registered URLs (this case)
- OAuth / OIDC callbacks and redirect URIs
- per-tenant or white-label API hosts
- self-hosted customer instances of a SaaS
- sandbox-vs-production endpoints chosen per credential

Dean's framing: **this is also how webpieces contracts get out to customers.** Today a partner
integrating with us receives an OpenAPI document and generates their own client. If our own delivery
path used a generated client against a runtime host, the contract would be exercised end to end by
the sender too — the same artifact, proven on both sides, instead of a published spec on one side
and hand-written axios on the other.

## Cross-reference

`backlog/feature-let-a-client-declare-its-target-service-when-clientconfig-is-not-a-literal.md`
covers the adjacent case where the target is a known service but the config is not a literal. This
one is the harder sibling: the target is not knowable at build time **at all**, and the resolution
has to happen per call.
