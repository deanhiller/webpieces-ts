# @webpieces/http-client-node

The server-side HTTP client. The client and the controller share ONE API contract, exactly like
the Cloud Tasks twin — calling a method makes the HTTP request that contract describes.

```ts
// inject the factory (a framework singleton), then one client per contract
const server2 = factory.createRpcClient(
    Server2Api,
    new ClientConfig('server2', new DeployedServiceHost()),
    [],                                             // this client's outbound filters
);
const res = await server2.fetchValue(req);          // inside a RequestContext
```

Every `ClientConfig` states WHERE its requests go, because there are two kinds of destination and
they carry very different risk. `DeployedServiceHost` is the one above and is what almost every
client wants. See "A destination supplied at RUNTIME" below for the other.

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

## A destination supplied at RUNTIME

Some destinations are DATA, not deployment: a URL a partner registered (`OrganizationWebhook.url`),
an OAuth callback, a per-tenant or self-hosted host. There is no `svcName` to resolve and nothing to
register, but there IS a contract — the payload is fully specified and published to customers. Name
a runtime host policy and the base URL arrives per call:

```ts
const partner = factory.createRpcClient(
    PartnerWebhookApi,
    new ClientConfig('partner-webhooks', new RuntimeHostFromContext(new DnsAddressResolver())),
    [new ClientFilterDefinition(500, new HmacSigningFilter(secret))],
);

for (const webhook of webhooks) {
    await RequestContext.run(() => {
        RequestContext.putUntrusted(WebpiecesCoreHeaders.OVERRIDE_BASE_URL, webhook.url);
        return partner.deliver(envelope);
    });
}
```

- **It cannot leak.** The override lives on the per-call request, never on the client, so one client
  fans out across N partner URLs and each call goes exactly where its own scope said.
- **A `DeployedServiceHost` client IGNORES the key.** That is the point of making the policy a named
  class: an ambient URL set for a partner delivery cannot re-point every other client in the same
  request. `grep -rn RuntimeHostFromContext` lists every client that can be re-pointed at all.
- **SSRF policy is ON.** https only; loopback / RFC1918 / link-local / cloud-metadata refused, by
  name AND by every address the name resolves to; redirects are not followed by the transport but
  re-judged hop by hop, so a partner URL that 302s at `169.254.169.254` is refused rather than
  obeyed. The ONLY way to relax it is to say so out loud:
  `new RuntimeHostFromContextAllowingInternalAddresses('local emulator on 127.0.0.1', resolver)`.
- **`@AuthOidc` / `@AuthSharedSecret` endpoints are refused at bind time.** Both mint a credential
  for a peer we chose; a destination that arrives per call has no honest audience, and minting one
  would hand our credential to whoever registered the URL.
- **The hop is VISIBLE.** `svcName` is still required under a runtime policy: it is the identity the
  destination gets on the runtime architecture graph, drawn as an external node of kind `runtime`.

## Outbound filters

`createRpcClient`'s third argument is this client's OUTBOUND filter chain — the same `Filter` /
`Service` abstraction (from `@webpieces/core-util`) the server's inbound chain uses, pointed the
other way. A filter receives a mutable `ClientRequest` and returns the `Response`:

```ts
class HmacSigningFilter extends Filter<ClientRequest, Response> {
    constructor(private readonly secret: string) { super(); }

    async filter(request: ClientRequest, next: Service<ClientRequest, Response>): Promise<Response> {
        // request.body is the EXACT serialized bytes the transport will send — sign those.
        const mac = createHmac('sha256', this.secret).update(request.body ?? '').digest('hex');
        request.headers.set('x-signature', `sha256=${mac}`);
        return next.invoke(request);
    }
}
```

Highest priority runs OUTERMOST, matching the server's `FilterMatcher`. The framework's own
built-ins occupy 1000 (the runtime base-URL override) and 900 (the SSRF guard), so an app filter
below them sees the destination already settled.

Signing over `request.body` is the whole reason this seam exists: the bytes a filter signs are the
bytes transmitted, byte for byte. Without it a sender has to hand-serialize and post the payload
itself, because a raw HTTP library that re-serializes internally signs one sequence and sends
another.
