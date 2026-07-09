# @webpieces/http-client-node

The server-side HTTP client. The client and the controller share ONE API contract, exactly like
the Cloud Tasks twin — calling a method makes the HTTP request that contract describes.

```ts
// inject the factory (a framework singleton), then one client per contract
const server2 = factory.createClient(Server2Api, new ClientConfig('server2'));
const res = await server2.fetchValue(req);          // inside a RequestContext
```

- `svcName` is TYPICALLY the GCP Cloud Run service name, and MUST be when you omit `targetUrl`:
  we look your service up in the same project and region and form the URL from the container's own
  metadata, so you maintain no URL table. That works across demo/qa/prod as long as each
  environment has its own projectId, which is typical.
- `targetUrl` overrides the lookup for another region, another project, or a non-Cloud-Run host.
  `svcName` is then used only for logging.

`ClientHttpFactory` injects a `Provider<NodeProxyClient>` and calls `get()` per contract.
`NodeProxyClient` is bound TRANSIENT, so each client gets its own — the provider caches nothing,
the target's scope decides. (Bind the target `@provideFrameworkSingleton` instead and the very same
provider yields a lazy singleton.)

Calls made outside `RequestContext.run(...)` **throw**. An outbound call with no correlation id or
request-id chain loses the trace, and finding that out in production is worse than a loud error. A
top-level server filter normally establishes the scope for you.

The browser twin is [@webpieces/http-client-browser](../http-client-browser).
