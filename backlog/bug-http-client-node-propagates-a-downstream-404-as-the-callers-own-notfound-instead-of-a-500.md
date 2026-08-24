# BUG: http-client-node propagates a downstream 404 as the caller's own not-found, instead of the caller's 500

## Symptom

When an RPC client calls a downstream webpieces service and that service answers **HTTP 404**,
`http-client-node` throws `HttpNotFoundError` in the **caller**. The caller's own `AuthFilter`/error
handling then renders that as a not-found to *its* caller.

That is the wrong owner. A 404 from a dependency means **the caller asked for a route that does not
exist** — a wrong path, a wrong base URL, or a dependency that has not been deployed yet. The
downstream server behaved correctly and has no bug. The **caller** has the bug, so the caller must
own it and answer **500 Internal Server Error** to whoever called *it*.

Propagating the 404 outward makes an internal misconfiguration look like a legitimate "that resource
does not exist" answer to an external consumer.

## Real incident — 2026-08-24, mealco prod, partner-facing

`public-api` (partner Management API) calls `pg-dataaccess` over `createRpcClient(DbStoresApi, …)`.
`public-api` had been promoted to prod; `pg-dataaccess` had **not**, so the `/db-stores` routes did
not exist there yet. Express answered with its default HTML 404 page.

What the logs show, one txId:

```
[API-client-req]        DbStoresApi.fetchStores  {"limit":51,"offset":0}
[API-client-resp-FAIL]  DbStoresApi.fetchStores  errorType=HttpNotFoundError
                        error=… HTTP 404 with content-type "text/html; charset=utf-8" …
                        body="<pre>Cannot POST /db-stores/fetch-stores</pre>"
[API-server-resp-OTHER] StoresApi.fetchStores    errorType=HttpNotFoundError
```

The client-side diagnostic here is genuinely good — it names the method, notices the HTML content
type, and says *"this response did not come from the webpieces server … almost certainly
infrastructure"*. That text is what made the root cause findable in one read. **The bug is only in
which error type it becomes.**

### Why it was expensive

The partner-facing response carried **no `stores` key at all**, so a caller doing
`jq '.stores | length'` got **0** — indistinguishable from "this organization has no stores". The
database had 6 live storefronts for that organization. Three operations (`fetchStores`,
`fetchBrands`, `fetchLocations`) all take the same hop, so all three silently reported an empty
estate on a live partner API.

A 500 would have been correct, loud, and immediately attributable. Instead the failure mode
impersonated valid data, and the deploy-ordering mistake was found only because someone
cross-checked the row count against the database by hand.

## The fix

In `http-client-node`, an HTTP **404 received by a client call** must not surface as
`HttpNotFoundError` in the calling process. Translate it to the caller's own internal-server error
(`HttpInternalServerError` or equivalent), preserving the existing diagnostic message — the
downstream URL, method, content-type and body snippet — as the cause.

Invariant worth stating in the code, because the asymmetry is the whole point:

> A status received from a **downstream dependency** describes *our* request to it. It is never the
> status we return to *our* caller. The server that answered 404 is correct; the server that asked
> for a route that does not exist is broken, and must say so as a 500.

## Design question to settle, not assumed here

404 is the clear case. The same argument plausibly extends to other 4xx received from a downstream
webpieces dependency — **400** (we sent a malformed request), **401/403** (our service credentials or
allow-list are wrong) — all of which are caller-side defects rather than end-user conditions, and all
of which are equally misleading if propagated outward.

Against that: some callers may deliberately want to relay a downstream 404 as their own (a thin
proxy or gateway). If that use case is real, the translation should be the **default** with an
explicit opt-out at the client-config level, rather than the current implicit pass-through. Worth
deciding deliberately rather than fixing 404 alone and leaving the rest inconsistent.

## How to verify

1. Stand up a caller with an RPC client pointed at a base URL where the contract's route does not
   exist (an undeployed service, or simply the wrong path).
2. Invoke it through the caller's own public endpoint.
3. The caller must answer **500**, not 404, and its logs must still carry the original downstream
   diagnostic (URL, method, content-type, body snippet) as the cause.
4. A downstream service that legitimately answers 404 for a *resource* still causes a 500 in the
   caller — that is intended, and the test should assert it rather than treat it as a false positive.

## Reported by

Dean, from the mealco `monorepo-nx` prod incident above (ONE-2647 / public-api → pg-dataaccess).
