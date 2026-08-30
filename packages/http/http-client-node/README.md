# @webpieces/http-client-node

The server-side HTTP client. The client and the controller share ONE API contract, exactly like
the Cloud Tasks twin — calling a method makes the HTTP request that contract describes.

```ts
// inject the factory (a framework singleton), then one client per contract
const server2 = factory.createRpcClient(Server2Api, new ClientConfig('server2'));
const res = await server2.fetchValue(req);          // inside a RequestContext
```

- `svcName` becomes a URL through `ClientRegistry.resolve` — ONE chain, the same one the browser
  client and Cloud Tasks run:
  1. a registered mapping wins: `ClientRegistry.addMapping(svcName, port)` (localhost) or
     `addUrlMapping(svcName, url)` (anything else — AWS, another region/project, an external API)
  2. else the installed deriver, if any: `ClientRegistry.setDeriver(gcpCloudRunDeriver())` on GCP
     (`svcName` is the Cloud Run service name, so same-project/same-region peers need no mapping at
     all), or `templateDeriver('https://{svc}.example.com')` for any predictable-DNS environment
  3. else it THROWS, naming both fixes. A server has no "own origin" to fall back to, so an
     unresolvable peer is a setup bug, not a silent mis-route. (The BROWSER client differs here and
     only here: it goes relative — same origin.)
- The deriver is optional. Registering every svcName is a first-class, sufficient setup — which is
  what localhost and tests do, since per-service ports are inherently a table, not a formula.

`ClientHttpFactory` injects a `Provider<NodeProxyClient>` and calls `get()` per contract.
`NodeProxyClient` is bound TRANSIENT, so each client gets its own — the provider caches nothing,
the target's scope decides. (Bind the target `@provideFrameworkSingleton` instead and the very same
provider yields a lazy singleton.)

Calls made outside `RequestContext.run(...)` **throw**. An outbound call with no correlation id or
request-id chain loses the trace, and finding that out in production is worse than a loud error. A
top-level server filter normally establishes the scope for you.

The browser twin is [@webpieces/http-client-browser](../http-client-browser).

## Outbound filters

`createRpcClient`'s OPTIONAL third argument is this client's outbound filter chain — the same
`Filter` / `Service` abstraction (from `@webpieces/core-util`) the server's inbound chain uses,
pointed the other way. A filter receives a mutable `ClientRequest` and returns the `Response`, so it
can rewrite the url, add or remove headers, log, or replace the serialized body:

```ts
class TenantHeaderFilter extends Filter<ClientRequest, Response> {
    async filter(request: ClientRequest, next: Service<ClientRequest, Response>): Promise<Response> {
        request.headers.set('x-tenant', currentTenant());
        return next.invoke(request);
    }
}
```

Highest priority runs OUTERMOST, matching the server's `FilterMatcher`.

**Priority orders YOUR filters against each other, and nothing else.** The framework's own built-ins
— the SSRF guard, then the outbound credential minter — are appended BENEATH every app filter,
structurally rather than by number, so no priority (not `Number.MAX_SAFE_INTEGER`) puts an app filter
under them. They have to judge, and sign for, the URL that is actually about to be fetched.

`request.body` is the EXACT serialized bytes the transport will send. That is the whole reason this
seam exists: without it a webhook sender has to hand-serialize and post the payload itself, because a
raw HTTP library that re-serializes internally signs one byte sequence and sends another.

## A destination supplied at RUNTIME

Some destinations are DATA, not deployment: a URL a partner registered (`OrganizationWebhook.url`),
an OAuth callback, a per-tenant or self-hosted host. There is no `svcName` to resolve and nothing to
register, but there IS a contract — the payload is fully specified and published to customers.

It is not a different kind of client. It is ONE filter:

```ts
/** @externalSystem runtime partner-webhooks */
@ApiPath('/ot-webhook')
export class PartnerWebhookApi {
    @Endpoint('/deliver')
    @AuthWebhook('partner-hmac')
    deliver(envelope: WebhookEnvelope): Promise<DeliveryAck>;
}

const partner = factory.createRpcClient(PartnerWebhookApi, new ClientConfig('partner-webhooks'), [
    new ClientFilterDefinition(1000, new ContextBaseUrlFilter()),
]);

for (const webhook of webhooks) {
    await RequestContext.run(() => {
        RequestContext.putUntrusted(WebpiecesCoreHeaders.OVERRIDE_BASE_URL, webhook.url);
        return partner.deliver(envelope);
    });
}
```

- **Installing the filter IS the opt-in.** A client without a `ContextBaseUrlFilter` ignores an
  ambient `OVERRIDE_BASE_URL` entirely, so a URL set for a partner delivery cannot re-point every
  other client in the same request. `grep -rn ContextBaseUrlFilter` lists every client that can be
  re-pointed at all.
- **It cannot leak.** The override lives on the per-call request, never on the client, so one client
  fans out across N partner URLs and each call goes exactly where its own scope said.
- **SSRF is automatic, and it is the ACT of re-pointing that arms it.** A URL that came out of
  `ClientRegistry` is an address we chose and is never judged — so a `localhost` emulator registered
  with `ClientRegistry.addMapping` needs no opt-out of any kind, and an ordinary RPC costs nothing.
  A re-pointed URL gets the full policy: https only; loopback / RFC1918 / CGNAT / link-local /
  cloud-metadata refused, by name AND by every address the name resolves to; redirects taken away
  from the transport and re-judged hop by hop, so a partner URL that 302s at `169.254.169.254` is
  refused rather than obeyed. The one relaxation — testing the partner path against a local fake —
  has to be said out loud, with a reason:
  `new ContextBaseUrlFilter(SsrfPolicy.forTesting('local fake in the delivery e2e'))`.
- **Every auth mode still works.** `@AuthOidc` mints for the FINAL base URL, `@AuthSharedSecret`
  sends the value this client holds (N services implementing one contract behind one agreed secret is
  a real topology), and `@AuthWebhook(name)` calls your bound `WebhookSignerCallback`. The minter runs
  BELOW the SSRF guard, so a destination that is going to be refused never causes a credential to be
  created.
- **The hop is VISIBLE.** `@externalSystem runtime <identity>` on the contract draws the destination
  as its own node on the runtime architecture graph, and two services delivering over the same
  contract converge on one box.

## Signing an OUTBOUND webhook — `@AuthWebhook`, the other way round

`@AuthWebhook(name)` names a signing SCHEME, not a direction. Inbound, a vendor signs and your bound
`WebhookAuthCallback` (in `@webpieces/http-routing`) verifies. Outbound, WE are the vendor, so your
bound `WebhookSignerCallback` produces the signature over the final URL and the exact wire bytes:

```ts
@provideSingleton()
export class PartnerHmacSigner implements WebhookSignerCallback {
    async sign(name: string, request: SignableRequest): Promise<Map<string, string>> {
        const mac = createHmac('sha256', secretFor(name)).update(request.body ?? '').digest('hex');
        return new Map([['x-partner-signature', `sha256=${mac}`]]);
    }
}

// AppModule.ts
options.bind(WEBHOOK_SIGNER_CALLBACK).to(PartnerHmacSigner);
```

The framework ships no vendor crypto, deliberately: Twilio signs the full URL with sorted params,
Slack signs `v0:{ts}:{body}`, Meta signs the raw body. The scheme lives in your hook and the vendor on
the contract. With **no** `WebhookSignerCallback` bound, every outbound `@AuthWebhook` call THROWS
rather than delivering unsigned — the mirror of an unbound `WebhookAuthCallback` 401ing every inbound
one.
