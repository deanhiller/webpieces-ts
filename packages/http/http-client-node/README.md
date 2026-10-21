# @webpieces/http-client-node

The server-side HTTP client. The client and the controller share ONE API contract, exactly like
the Cloud Tasks twin — calling a method makes the HTTP request that contract describes.

```ts
// inject the factory (a framework singleton), then one client per contract
const server2 = factory.createRpcClient(Server2Api, new ClientConfig('server2', ClientRole.SERVER));
const res = await server2.fetchValue(req);          // inside a RequestContext
```

- `ClientRole` is REQUIRED, with no default: `ClientRole.SERVER` for a server calling a server (a
  401 it receives is its own credential bug, `ApiImplementationError`), `ClientRole.END_USER_CLIENT`
  for a node process acting for a person, such as a remote MCP client (a 401 is
  `ApiUnauthorizedError`, "log in again"). See `docs/portable-ipc-and-errors.md`.
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
    @Endpoint(POST, '/deliver', WRITE, RPC)
    @WpAuth([vendorAuth('partner-hmac')])
    @WpAuthorization({authType: AuthorizationType.USERS_OR_SERVICES})
    deliver(envelope: WebhookEnvelope): Promise<DeliveryAck>;
}

const partner = factory.createRpcClient(PartnerWebhookApi, new ClientConfig('partner-webhooks', ClientRole.SERVER), [
    new ClientFilterDefinition(1000, new ContextFullUrlFilter()),
]);

for (const webhook of webhooks) {
    await RequestContext.run(() => {
        // the COMPLETE stored url, e.g. 'https://hooks.partner.example/in/abc?token=xyz'
        RequestContext.putUntrusted(WebpiecesCoreHeaders.OVERRIDE_FULL_URL, webhook.url);
        return partner.deliver(envelope);
    });
}
```

- **Two filters, two shapes of destination.** `ContextFullUrlFilter` + `OVERRIDE_FULL_URL` sends the
  stored url byte for byte — host, path and query — and does NOT append the contract's path; that is
  the partner-webhook shape. `ContextBaseUrlFilter` + `OVERRIDE_BASE_URL` swaps only the host and
  keeps `@ApiPath` + `@Endpoint`; that is the shape for a tenant running our contract at their own
  base URL. The contract path above is therefore documentation (and architecture-graph identity)
  when the full-URL filter is installed.
- **Installing the filter IS the opt-in.** A client without one ignores the ambient override key
  entirely, so a URL set for a partner delivery cannot re-point every other client in the same
  request. `grep -rnE 'Context(Base|Full)UrlFilter'` lists every client that can be re-pointed at all.
- **It refuses rather than falls back.** No override in scope throws `MissingRuntimeBaseUrlError`;
  a partner's payload is never sent to this client's configured service URL.
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
  `new ContextFullUrlFilter(new SsrfTestingPolicy('local fake in the delivery e2e'))`.
- **Every auth mode still works.** `oidcSameProject()` / `oidcSvcs(...)` mint for the FINAL base URL, `sharedSecret(...)`
  sends the value this client holds (N services implementing one contract behind one agreed secret is
  a real topology), and `@WpAuth([vendorAuth(name)])` calls your bound `VendorAuthMinter.mint`. The minter runs
  BELOW the SSRF guard, so a destination that is going to be refused never causes a credential to be
  created.
- **The hop is VISIBLE.** `@externalSystem runtime <identity>` on the contract draws the destination
  as its own node on the runtime architecture graph, and two services delivering over the same
  contract converge on one box.

## `oidcSameProject()` / `oidcSvcs([...])`: generate the credential the Cloud Run edge expects

The shared contract tells `OutboundAuthFilter` to mint a Google ID token for the final
base URL and send it in `Authorization: Bearer`. A private Cloud Run service verifies
that invocation token and enforces invoker IAM before the container runs. The server then
checks the caller itself: `oidcSameProject()` admits service accounts of its own GCP project,
`oidcSvcs([...])` only the listed ones. Off-GCP clients mint unsigned synthetic tokens for local
tests, which a server on GCP refuses. See [Cloud Run OIDC](../../../docs/architecture/cloud-run-oidc.md)
for deployment assumptions and why a direct application-verifier test does not test the edge.

## A vendor's credential, both ways — `vendorAuth(...)`

`@WpAuth([vendorAuth(name)])` names a vendor's credential SCHEME, not a direction. The direction is
decided by whether THIS runtime is sending or receiving, and each direction is its OWN optional DI
role (both defined in `@webpieces/core-context`):

| role | token | methods | who binds it | re-exported by |
|---|---|---|---|---|
| `VendorAuthMinter` | `VENDOR_AUTH_MINTER` | `supportedVendorNames`, `mint`, `refresh` | a process that SENDS `vendorAuth(...)` calls (a CLI, a worker, a server calling a vendor) | `@webpieces/http-client-node` |
| `VendorAuthVerifier` | `VENDOR_AUTH_VERIFIER` | `supportedVendorNames`, `verify` | a server that RECEIVES `vendorAuth(...)` calls | `@webpieces/http-routing` |

A process binds neither, one, or both. `mint` produces the credential WE present when we call the
vendor (a per-merchant OAuth bearer, a partner's HMAC over the final URL and the exact wire bytes),
and `refresh` renews it when the vendor answers our call with a `401`:

```ts
@provideSingleton()
export class PartnerAuthMinter extends VendorAuthMinter {
    // PURE: a fixed list of every name mint()/refresh() below handle. createRpcClient calls it.
    supportedVendorNames(): readonly string[] { return ['partner-hmac']; }
    async mint(name: string, request: SignableRequest): Promise<Map<string, string>> {
        const mac = createHmac('sha256', secretFor(name)).update(request.body ?? '').digest('hex');
        return new Map([['x-partner-signature', `sha256=${mac}`]]);
    }
    async refresh(name: string): Promise<void> { /* renew the OAuth token, log in again */ }
}

// the SENDING process's BindModule
binder.bind(VENDOR_AUTH_MINTER).to(PartnerAuthMinter).inSingletonScope();
```

**Why two roles (#1358).** Every typed RPC client this package builds is a `NodeProxyClient`, and it
depends on the OUTBOUND role only. When one `VendorAuthHook` served both directions, every proxy —
including an ordinary `oidcSameProject()` client — constructed the server's inbound verifier, and a
verifier that looks a credential up through such a client closed a DI cycle
(`Circular dependency found`) before the server could listen. With the roles split, a
`VendorAuthVerifier` may depend on any RPC client, in any binding order, and the graph stays acyclic.

| configuration | minter required? | verifier required? |
|---|---|---|
| OIDC-only or public-only outbound client | no | no |
| outbound endpoint whose ONLY sendable method is `vendorAuth(name)` | yes, listing `name` — or `createRpcClient` throws | no |
| outbound endpoint that also allows OIDC (or a held shared secret) | no | no |
| server SERVING a `vendorAuth(name)` route | no | yes, listing `name` — or the server refuses to boot |
| server receiving vendor calls and calling an OIDC-only API downstream | no (not for the OIDC hop) | yes |
| process both sending and receiving vendor calls | yes | yes |

### Migrating from `VendorAuthHook` / `VENDOR_AUTH_HOOK`

The unified hook is DELETED (no alias): the old import stops compiling, which is the migration.

- A CLIENT process (e.g. a CLI holding a worker token): `extends VendorAuthMinter`, keep `mint` and
  `refresh`, delete the meaningless `verify`, and bind `VENDOR_AUTH_MINTER`. The minter keeps reading
  the credential it already holds — it never validates it server-side.
- A SERVER process: `extends VendorAuthVerifier`, keep `verify`, delete the meaningless
  `mint`/`refresh`, and bind `VENDOR_AUTH_VERIFIER`. Its constructor may inject the typed
  `oidcSameProject()` RPC client it uses to check the credential.
- `MissingVendorAuthHookError` and its successor `MissingVendorAuthMinterError` (and
  `MissingSharedSecretError`) are DELETED: `createRpcClient` throws `MissingClientCredentialError`
  instead, before any call (#1362).
- Contracts are unchanged: `@WpAuth([vendorAuth(name)])` keeps its meaning.

On a raw `401`, `OutboundAuthFilter` cancels the 401's body, calls `refresh(name)` ONCE, mints again
and re-sends ONCE — never for a streaming upload, and once per logical call (the SSRF redirect loop
re-enters the filter). A second `401` fails the call exactly as before. Serializing a refresh across
instances (single-use refresh tokens) is the minter's job.

The framework ships no vendor crypto, deliberately: Twilio signs the full URL with sorted params,
Slack signs `v0:{ts}:{body}`, Meta signs the raw body. The scheme lives in your minter / verifier and
the vendor on the contract.

### It fails at STARTUP, not on the first call (#1362)

Both roles declare the vendors they handle with a required, PURE `supportedVendorNames()` beside
`verify` / `mint` — add a vendor to both in one edit. The framework calls it at boot / client
creation and never calls `verify`, `mint`, `refresh` or the network then.

- **Client — one per endpoint.** `createRpcClient` throws `MissingClientCredentialError` (naming the
  contract, the method and the binding to add) when an endpoint declares no method this client can
  send now: OIDC and public always; `sharedSecret(key)` when the bound `Secrets` holds `key`;
  `vendorAuth(name)` when a bound minter's `supportedVendorNames()` lists `name`; and `jwt()` /
  `apiKey(...)`, which the framework never mints but the app relays per call (a forwarded user JWT
  in a context key, a partner SDK's headers set by a client filter) — chosen only when no
  framework-sent method is available. A client needs only ONE — a CLI need not hold OIDC
  credentials because the contract also allows OIDC.
- **Server — strict.** Route registration refuses to boot (`UnverifiableAuthModeError`, naming the
  endpoint, the mode and the exact `binder.bind(...)` line) when a SERVED route declares any mode
  nothing can verify — including a dead alternative such as `[oidcSameProject(), vendorAuth('x')]`
  with no verifier. See `@webpieces/http-routing`.

A bound verifier never counts as a minter, and an unbound minter never breaks an OIDC, shared-secret
or public call. A name the minter's / verifier's own dispatch does not know still refuses at request
time, as a backstop.

Calls have a **30-second default timeout**, including URL resolution, filters/auth, fetch and body
reading. `ClientRegistry` from `@webpieces/core-util` shares ALL, API and API-method overrides with the
browser and Cloud Tasks clients — one `ClientRegistry.execute` for every transport. Any strategy replaces
the entire timeout ladder. RPC has no
default retry because POSTs may not be idempotent; opt a contract in with
`ClientRegistry.setStrategy(new RetryStrategy(...).run, CallScope.api(CatalogApi))`, which retries only a
`CallOutcome.TRANSIENT_FAILURE` on a `READ` / `WRITE_IDEMPOTENT` endpoint and gives up with a 502
`ApiRetriesExhaustedError`. See [client timeouts](../../../docs/client-timeouts.md).
