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
