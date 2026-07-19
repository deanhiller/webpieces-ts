# ACTIONID tracing plan — a browser/app-minted grouping id (`actionId`) above `requestId`

> Handoff spec authored from monorepo2 (the consumer). Self-contained: everything below refers to files
> in **this** repo (`webpieces-ts40`).
>
> **CORRECTION (2026-07-19, at execution):** the handoff premise was stale. The current ts40 tree still
> has `CLICK_ID` (`clickId` / `x-webpieces-clickid`) — it was NOT deleted. `clickId` already does exactly
> the "group all requests from one interaction" job, only under a narrower name. So this was executed as a
> **hard RENAME `CLICK_ID` → `ACTION_ID`** (name `actionId`, header `x-webpieces-actionid`), broadening
> "click" to "any user ACTION — a click OR typing in the GUI — that may fan out into multiple remote
> calls", plus a background poller tick. **No backwards-compat / no alias** (confirmed: no published client
> uses it yet). `clickId` / `x-webpieces-clickid` is gone.

## Background / why

The ts40 tree defined a browser-minted grouping id under a click-only name:

```ts
static readonly CLICK_ID = new ContextKey('clickId', 'x-webpieces-clickid');
```

…that groups every request triggered by ONE user interaction. The per-call id is `requestId`, minted
**per browser HTTP call** (the first service to see a request without `x-request-id` mints one in
`RequestContextHeaders.fillFromRequest`) and propagated unchanged through that call's server→server subtree.

The grouping id **above `requestId`** is what ties a whole action together: one user *action* — a **click**
in the GUI, **typing** in the GUI, or a background poller tick — fires **1..N** browser HTTP calls, and
without it nothing links those N calls (N distinct `requestId`s) back to the one action. This is realized
as **`actionId`** — the better, broader name (an "action", not merely a "click": typing or a background
poller also triggers calls) — by **renaming** the existing `CLICK_ID`.

## The model to realize

```
actionId   (browser/app-minted, ONE per user action, rides EVERY call of that action)
   │
   └── 1..N requestId   (framework-minted, ONE per browser HTTP call, shared within that call's server subtree)
```

Grep one `actionId` in the logs → every `requestId` it spawned, and every log line of the whole action.

## Changes (current ts40 tree)

### 1. `packages/core/core-util/src/http/WebpiecesCoreHeaders.ts` — RENAME `CLICK_ID` → `ACTION_ID` ✅ DONE

A 2-arg `ContextKey(name, httpHeader)` defaults to **transferred + logged**, which is exactly what's
wanted (same shape `CLICK_ID` used). `CLICK_ID`/`clickId`/`x-webpieces-clickid` is REMOVED (hard cut):

```ts
/**
 * A frontend/app-minted correlation id that groups every request triggered by ONE user ACTION —
 * a click, a keystroke, or a background poller tick (not just a click). Minted and refreshed by the
 * app (a UI/app concern), carried on every outbound request under `x-webpieces-actionid` so the server
 * logs of a whole action share it. One action fans out into 1..N `requestId`s (one per HTTP call);
 * this id is what stitches those N requests back to the single action that caused them.
 *
 * - `httpHeader` SET → transferred: copied off the inbound request into context and re-emitted on
 *   outbound hops, so the id follows the action across services.
 * - `isLogged` TRUE → emitted as a plain string on every log line of the request.
 */
static readonly ACTION_ID = new ContextKey('actionId', 'x-webpieces-actionid');
```

The `getAllHeaders()` array (the `DEFAULT_HEADERS` set) now lists `WebpiecesCoreHeaders.ACTION_ID` in
place of the removed `CLICK_ID`.

### 2. Do NOT touch `REQUEST_ID` / `REQUEST_ID_SOURCE`

The per-request id and its 1→N behavior stay exactly as-is. `actionId` sits **above** `requestId`.

Crucially, `actionId` is **browser/app-minted only** — the framework transfers & logs it but must
**not** auto-mint one server-side (unlike `requestId`). Absent `actionId` ⇒ a non-action (system / cron /
task) flow, which is the correct signal. `RequestContextHeaders.fillFromRequest` already only mints
`REQUEST_ID`; leave that path alone — the new key flows through the generic transferred-keys copy
automatically.

### 3. Nothing else is load-bearing

Logging (`RequestContext.buildLogFields` / `buildStructuredLogFields`, driven by
`HeaderRegistry.getLoggedKeys()`), the browser `MutableContextStore`
(`packages/http/http-client-browser/src/MutableContextStore.ts`), and server→server propagation
(`RequestContextHeaders.buildOutboundHeaders` / `fillFromRequest`) all key off `key.name` /
`key.httpHeader`, so they pick the new key up for free once it's in `getAllHeaders()`. No edits needed
there.

### 4. Tests to update

- `packages/core/core-util/src/http/__tests__/HeaderRegistry.spec.ts` — the `getLoggedKeys()` /
  `getAllHeaders()` subset/count assertions now include `actionId`. Add an assertion that `ACTION_ID` is
  **transferred** (httpHeader `x-webpieces-actionid`) and **logged**.
- `packages/core/core-context/src/__tests__/LogFields.spec.ts` — if it asserts the exact logged-field
  set, add `actionId`.

### 5. Release

Push to `main` → `.github/workflows/release.yml` auto-computes `0.4.<github.run_number>`, stamps via
`scripts/set-version.sh`, builds all packages (`pnpm nx run-many --target=build --all`), publishes via
`scripts/publish-packages.sh`, and tags `v0.4.<run>`. No `VERSION` file bump needed unless a minor bump
is desired.

**➡️ Report the exact published version back** (e.g. `0.4.4xx`) — monorepo2 pins it in
`pnpm-workspace.yaml` (`&wp 0.4.405` → new) and switches its `WebpiecesCoreHeaders.CLICK_ID` references
to `ACTION_ID`.

## Acceptance

- A request carrying `x-webpieces-actionid: abc` logs `actionId:abc` on **every** line across **every**
  hop (browser → helper-svr → helper-fsdb).
- Two separate browser calls made under the **same** `actionId` show that same `actionId` in the logs
  with two **different** `requestId`s (proves 1→N).
- A request with **no** `x-webpieces-actionid` logs no `actionId` field and still works (server does not
  mint one).
