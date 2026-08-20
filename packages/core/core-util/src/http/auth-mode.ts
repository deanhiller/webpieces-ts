/**
 * The TYPE layer of the auth surface: what an endpoint's credential posture IS, with no decorator and
 * no reflect-metadata. `decorators.ts` (which attaches these) imports FROM here, never the other way,
 * so a reader that only needs to switch on a mode — `DestinationTrust`, `RouteMetadata`, a spec
 * generator — does not drag the whole decorator surface in with it.
 *
 * Split out of `decorators.ts` purely for file size, exactly as `api-kind.ts`, `external-caller.ts` and
 * `RouteMetadata.ts` were before it. Nothing about these types' role changed in the move, and the
 * barrel keeps the package surface identical.
 */

/**
 * The role decision for a JWT endpoint, as a union the COMPILER enforces — one spelling per decision,
 * every broken combination a compile error:
 *
 * ```typescript
 * @AuthJwt({ roles: ['admin'] })            // ✅ role-gated (any-of)
 * @AuthJwt({ allRolesAllowed: true })       // ✅ every authenticated user, said out loud
 * @AuthJwt({})                              // ❌ pick a branch
 * @AuthJwt({ roles: [] })                   // ❌ needs at least one role
 * ```
 *
 * `allRolesAllowed` exists ONLY on the wide branch (the dangerous half must be a greppable token, and
 * the narrow branch rejects it as a redundant second spelling); `roles` is a NON-EMPTY tuple so
 * "declared roles, passed none" — the old optional `string[]`'s silent widest grant — cannot be written.
 * All six bad cases are pinned in `AuthJwtCompileAssertions.ts` — a COMPILED file, not a spec: tsc
 * fails the build (TS2578) if any starts compiling. A spec cannot do this (see that file's header).
 *
 * WHY a type rather than the runtime `throw` this replaced: `.claude/review/backwards-compatibility.md`
 * shim shapes #4 and #5. Not restated here — three copies of one rationale is three things to drift.
 */
export type JwtRoles =
    | { allRolesAllowed: true; roles?: never }
    | { roles: readonly [string, ...string[]]; allRolesAllowed?: never };

/**
 * JwtRequirement - the {@link JwtRoles} decision PLUS any app-defined authorization fields, e.g.
 * `@AuthJwt({ allRolesAllowed: true, inOrg: true })`. The framework authenticates (JwtHook.parseJwt)
 * and enforces the roles any-of; the app overrides JwtHook.authorizeJwt to enforce its own fields.
 * Both hook methods are ASYNC, so an app field like `inOrg` may be answered from a datastore.
 *
 * This was a SECOND decorator (`@Auth`) whose `roles` was optional — so `@Auth({})` reached the exact
 * widest grant that {@link JwtRoles} exists to make un-typeable. Folding it in leaves one decorator per
 * credential kind and closes that route by construction.
 */
// webpieces-disable no-any-unknown -- app-defined authorization fields (inOrg, tenant, ...)
export type JwtRequirement = JwtRoles & { [field: string]: unknown };

/**
 * WHERE ONE api-key credential rides on the wire, as a union the COMPILER enforces — the DECLARATION
 * a spec generator turns into an OpenAPI `securityScheme`:
 *
 * ```typescript
 * { in: 'header', name: 'x-api-key' }   // ✅ → {type: apiKey, in: header, name: x-api-key}
 * { in: 'bearer' }                      // ✅ → {type: http, scheme: bearer}
 * { in: 'bearer', name: 'x-api-key' }   // ❌ bearer's location IS `Authorization`; a name is a lie
 * { in: 'header' }                      // ❌ a header credential with no header name is unusable
 * ```
 *
 * WHY A UNION AND NOT ONE OPTIONAL `headerName`. The two OpenAPI schemes reachable from "an api key"
 * are structurally DIFFERENT documents (`type: apiKey` + `in` + `name` vs `type: http` + `scheme`).
 * A single optional field makes the contradictory combination REPRESENTABLE, and a generator handed
 * `{in: 'bearer', name: 'x-api-key'}` has to either guess or emit a silently-wrong published contract.
 * `name?: never` on the bearer branch is what deletes that state — the same device {@link JwtRoles}
 * uses, pinned the same way in `AuthApiKeyCompileAssertions.ts` (a COMPILED file, not a spec).
 *
 * THIS IS DESCRIPTION, NOT HANDLING. The framework reads no header from this; `ApiKeyHook` still gets
 * the whole request and still owns the cross-check. Declaring the location cannot regress running auth
 * — it exists so the location stops living ONLY in a hand-written spec fragment that drifts silently
 * from the hook's own header constants.
 *
 * `description` is carried because it is what a docs site renders on its authorization card, and that
 * prose belongs beside the declaration rather than in a hand-maintained JSON file.
 */
export type ApiKeyCredential =
    | { in: 'header'; name: string; description?: string }
    | { in: 'bearer'; name?: never; description?: string };

/**
 * EVERY credential one api-key regime requires, in the order they appear in the published document.
 *
 * A NON-EMPTY tuple, for the same reason {@link JwtRoles}'s `roles` is one: a regime that declares no
 * credential would generate a document with no security block — the exact silent failure the
 * declaration exists to remove — so `[]` is a COMPILE error rather than a runtime throw (shim shape
 * #4). More than one entry is the normal case, not an exotic one: a real regime authenticates a PAIR,
 * and every entry here must be presented TOGETHER (an AND, i.e. ONE OpenAPI security-requirement
 * object holding every scheme, never a LIST of one-key objects, which would mean "either suffices").
 */
export type ApiKeyCredentials = readonly [ApiKeyCredential, ...ApiKeyCredential[]];

/**
 * The service-to-service / user auth mode of an endpoint. Discriminated union so a filter can
 * `switch (mode.kind)` and get the data it needs, exhaustively.
 *
 * - `public`        → no auth check
 * - `jwt`           → user JWT; `requirement` carries the compiler-enforced role decision
 *                     ({@link JwtRoles}) plus any app-defined authorization fields
 * - `oidc`          → Google OIDC service-to-service (Cloud Tasks delivery / cross-service RPC);
 *                     `callers` is the allow-list of caller SAs ('self' = this service's SA)
 * - `shared-secret` → constant-time compare of a header against the secret bound for `secretKey`
 * - `webhook`       → an OUTSIDE vendor signed this request its own way; the app's bound `WebhookAuthCallback`
 *                     verifies it, selected by `name`. The framework ships NO vendor crypto (see
 *                     {@link AuthWebhook}).
 * - `apikey`        → a CUSTOMER holds the credential; the app's bound `ApiKeyHook` looks it up
 *                     (async, over the whole header set) and returns the context to seed, selected
 *                     by `regime`. `credentials` DECLARES where the credential rides — an ORDERED,
 *                     non-empty list, because a real regime authenticates a PAIR (a key AND the
 *                     organization id it acts for) that must be presented TOGETHER. NOT a peer
 *                     service — see {@link AuthApiKey}.
 * - `local-only`    → exists ONLY on a developer's machine; not registered and never served when
 *                     {@link RuntimeLocality} says this process is deployed. Authenticates NOBODY —
 *                     it is a deployment gate, not a credential.
 */
export type AuthMode =
    | { kind: 'public' }
    | { kind: 'jwt'; requirement: JwtRequirement }
    | { kind: 'oidc'; callers: string[] }
    | { kind: 'shared-secret'; secretKey: string }
    | { kind: 'webhook'; name: string }
    | { kind: 'apikey'; regime: string; credentials: ApiKeyCredentials }
    | { kind: 'local-only' };

/**
 * Auth metadata attached to a class or method via one of the auth decorators
 * (@Public / @AuthJwt / @AuthOidc / @AuthSharedSecret / @AuthWebhook / @AuthApiKey / @AuthLocalOnly) —
 * one per credential kind.
 *
 * Carries a discriminated {@link AuthMode} and nothing else. It USED to also expose
 * `authenticated`/`roles` getters "for back-compat with readers that only understand the user-JWT
 * model" — deleted, because nothing read them: every reader (AuthFilter, BrowserProxyClient,
 * ProxyClient) switches on `mode.kind`, which is the whole point of the discriminated union. A
 * flattened view of a union is a second spelling of it, and the flattened one silently answers
 * `authenticated: true` for oidc and shared-secret too.
 */
export class AuthMeta {
    mode: AuthMode;

    constructor(mode: AuthMode) {
        this.mode = mode;
    }
}
