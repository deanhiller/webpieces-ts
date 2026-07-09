# @webpieces/http-client-core

The isomorphic engine behind the webpieces HTTP clients. You almost certainly want one of:

- **[@webpieces/http-client-node](../http-client-node)** — server-side: inversify-wired, reads
  `RequestContext`, mints OIDC / shared-secret delivery auth, resolves Cloud Run URLs from a
  service name.
- **[@webpieces/http-client-browser](../http-client-browser)** — browser: DI-free (React or
  Angular), app-managed context store, no AsyncLocalStorage.

This package holds what they share: `ProxyClient` (contract decorators → HTTP request),
`buildClientProxy` (the typed `Proxy` trap), `ClientTarget`, and `ClientErrorTranslator`.

The one seam between the two environments is `OutboundHeaders` (in `@webpieces/core-util`):
`RequestContextHeaders` on the server, `ContextMgr` in a browser. Keeping that a seam is what
lets this package depend on nothing but `core-util`, so no node-only import can reach a browser
bundle.
