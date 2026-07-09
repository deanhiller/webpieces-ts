# Responsibilities — http-client-browser

The browser-side HTTP client: generates type-safe clients from the SAME API contract the server implements. Deliberately DI-free, because it may be bundled by React just as easily as by Angular, so it ships no `inversify` and no node-only `core-context`.

## In Scope

- `ClientHttpBrowserFactory` — a plain class the app provides through whatever DI it already has (Angular `useFactory`, a React context, a module-level `const`)
- `ClientConfig` — per-client state: the base URL, plus an optional logging name
- `MutableContextStore` — the browser `ContextReader`. Browsers have no ambient request scope, so the app sets context values (login token, tenant) as they become known and every outbound call transfers them as headers

## Out of Scope

- The decorator-reading engine, the Proxy trap, and error translation → `http-client-core`
- Reading a server RequestContext → `core-context` (node-only; a browser has no AsyncLocalStorage)
- Minting OIDC tokens or holding `Secrets` → a browser cannot hold service credentials. A contract with an `@AuthOidc` endpoint fails fast in `ProxyClient.init`
- Server-side routing, filters, recording → `http-routing` / `http-server`

## Notes

Tagged `framework:browser`, so the `library-types-match-client` rule structurally forbids it from depending on any `framework:node` package — that lattice check, not a source grep, is what guarantees no node import reaches the bundle. The server twin is `http-client-node`; both sit on `http-client-core`.
