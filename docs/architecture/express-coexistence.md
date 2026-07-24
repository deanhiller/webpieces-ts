# Running Alongside Express (and Other Frameworks)

> **webpieces mounts onto an Express app you already own, adding zero global middleware.** A team
> can adopt it **one route at a time, next to their existing framework**, without surrendering their
> server. This is what makes webpieces something you can bring into a live codebase incrementally,
> rather than a rewrite you have to commit to up front.

---

## The mount seam: `bindExpress` vs. `bindAndStartExpress`

`packages/http/http-server/src/WebpiecesExpressRouter.ts` is the **only** place Express lifecycle
lives. It exposes two entry points, and the choice between them is the choice between "embed" and
"own":

### `bindExpress(app)` — embed into an app you already own (L44-50)

```ts
// Adds NO global app.use() middleware, so it is safe to attach to a legacy app whose other
// routes must stay untouched. The caller owns app.listen() and any global middleware.
bindExpress(app: Express): void { ... }
```

It iterates the api clients and registers each as a normal Express route
(`app.<verb>(path, handler)`). It installs **no** `app.use(...)` global middleware, so it cannot
interfere with the host app's existing routes, middleware, or error handling. You keep ownership of
`app.listen()`, CORS, body parsing — everything.

### `bindAndStartExpress(app, port, config)` — let webpieces own the server (L60-97)

The greenfield convenience path: it optionally mounts CORS (only when `config.corsOrigins` is
non-empty — CORS is opt-in and stays off in production), calls `bindExpress`, mounts a top-level
error handler **after** the routes, then calls `app.listen(port)`. Use this when webpieces owns the
whole app.

The class JSDoc (L20-30) shows both modes side by side.

## Each route is self-contained — the host app never leaks in

Every webpieces route is bound through `ExpressWrapper` (via `WebpiecesMiddleware`), which per
request reads the raw body itself (it does **not** rely on `express.json()`), translates the Express
`Request` into a transport-neutral `HttpRequest`, opens a `RequestContext.run(...)` scope, runs the
filter chain + controller, and serializes the response (and errors) to JSON itself. Below that
translation, **the filter chain and controllers never see Express** — which is precisely why the
same code also runs in-process and over Cloud Tasks (see
[`one-contract-many-transports.md`](./one-contract-many-transports.md)).

## Demonstrated: a legacy Express app with webpieces embedded

`apps/app-example/legacy-server/` is a worked example of coexistence:

- `LegacyServer.ts:12-18` builds a plain Express app with its own route, `app.get('/legacy/ping')`.
- `server.ts:26-39` creates that legacy app, builds the webpieces api surface via
  `setupCompanyRuntime(...)`, then `new WebpiecesExpressRouter(apiFactory).bindExpress(app)` — and
  the **legacy app** owns `app.listen(port)`. The plain `/legacy/ping` route and the webpieces API
  routes serve on the **same server**.

The file's own comment states the intent (`server.ts:8-15`):

```
// the LEGACY app owns express + listen; webpieces only mounts its api routes onto it, so a team
// can adopt webpieces incrementally without giving up their existing server.
```

## Honest integration gotchas

Coexistence is real, but two things are the integrator's responsibility:

1. **All webpieces routes are `POST`** (the api-tier convention), and paths come from the
   `@ApiPath` / `@Endpoint` decorators. If a webpieces path collides with an existing route, that is
   on you to avoid.
2. **Body-parser ordering.** Because `ExpressWrapper` reads the raw request stream itself, a
   host-level global `app.use(express.json())` mounted *before* the webpieces routes would consume
   the stream first. `bindExpress` adds no such global middleware, but if the host app already
   installs one globally, be aware of the ordering.

---

## Verify anything here
Every claim cites a `path/to/File.ts:line`. If a claim and the code disagree, the **code wins** —
fix the doc. See also [`api-first-vs-codegen.md`](./api-first-vs-codegen.md) (the other half of the
"adopt incrementally" story) and [`../ADOPTION.md`](../ADOPTION.md) (who runs this in production).
