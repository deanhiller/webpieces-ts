import { AsyncLocalStorage } from 'async_hooks';
import { ContextKey, AnyContextKey, HeaderRegistry, ServiceInfo } from '@webpieces/core-util';
import { HttpRequest } from './HttpRequest';
import { CapturedContext, ContextCaptureAuthority } from './CapturedContext';

/** Reserved context key under which the current HttpRequest is stored. */
const HTTP_REQUEST_KEY = '__webpieces_http_request__';

/**
 * Context management using AsyncLocalStorage.
 * Similar to Java WebPieces Context class that uses ThreadLocal.
 *
 * This allows storing request-scoped data that is automatically available
 * throughout the async call chain, similar to MDC (Mapped Diagnostic Context).
 *
 * Example usage:
 * ```typescript
 * Context.put('REQUEST_ID', '12345');
 * await someAsyncOperation();
 * const id = Context.get('REQUEST_ID'); // Still available!
 * ```
 */
class RequestContextImpl {
    private storage: AsyncLocalStorage<Map<string, any>>;

    constructor() {
        this.storage = new AsyncLocalStorage<Map<string, any>>();
    }

    /**
     * Open THE request scope. A transport calls this once, at the beginning of a request.
     *
     * Nesting is a bug, not a feature, so it throws. AsyncLocalStorage would happily let a second
     * `run()` install a fresh empty Map that SHADOWS the outer one: every value the outer scope
     * holds becomes invisible, `fillFromRequest` mints a second request id, and the two halves of a
     * request end up in different traces. Nothing would tell you.
     *
     * With this guard the setup is right or it is loud. It mirrors
     * `RequestContextHeaders.fillFromRequest()`, which throws when there is NO active scope.
     *
     * @throws Error when a RequestContext is already active.
     */
    run<T>(fn: () => T): T {
        if (this.isActive()) {
            throw new Error(
                'RequestContext.run(...) called inside an active RequestContext. Nesting installs a ' +
                'fresh empty context that shadows the outer one: its values go invisible and a second ' +
                'request id is minted. Exactly ONE scope per request — the transport opens it.',
            );
        }
        // webpieces-disable no-any-unknown -- context values are heterogeneous (strings, recorder, meta objects)
        const store = new Map<string, any>();
        return this.storage.run(store, fn);
    }

    /**
     * Open a NEW scope pre-loaded with a snapshot — the restore half of {@link copyContext}, for work
     * whose async chain was broken and re-rooted elsewhere (a queued job drained by a background loop,
     * a batch flushed on a timer, an event listener fired from a socket the request does not own). See
     * {@link CapturedContext} for the full list and for why the payload is opaque.
     *
     * A restored context legitimately contains TRUSTED values — reinstating what the original scope
     * proved is the entire point — so this cannot type-check its contents the way the trust verbs do.
     * The guarantee instead comes from the PAYLOAD: a {@link CapturedContext} can only be produced by
     * {@link copyContext}, so there is no hand-assembled Map to hand it and no way to forge one.
     *
     * The snapshot is copied into a fresh store, so writes inside `fn` stay inside `fn` and the
     * snapshot stays reusable.
     *
     * Deliberately NOT guarded against nesting the way {@link run} is. `run`'s guard exists because a
     * second EMPTY scope shadowing the first is always a bug; here the inner scope is a faithful copy
     * of a real one, which is the whole point — a worker that restores a snapshot inside a scope it
     * opened per job is correct, not a mistake. Prefer this over {@link restoreContext} unless you
     * specifically need the CURRENT scope overwritten in place.
     */
    runWithContext<T>(captured: CapturedContext, fn: () => T): T {
        return this.storage.run(captured.toFreshStore(ContextCaptureAuthority.INTERNAL), fn);
    }

    /**
     * Read a value the framework PROVED — a verified JWT claim, or a fact an app derived from a
     * verified credential. Does not compile for an untrusted key, so a reader can never mistake a
     * caller-asserted value for an authenticated one.
     *
     * This is the ONLY read that is safe to feed into an authorization decision. If you find
     * yourself wanting `getUntrusted` for that, the fix is to make the key trusted and have an
     * authenticator vouch for it — not to use the other verb.
     *
     * The return type is the key's OWN value type `V` — `string` for wire/log keys, `ApiCallInfo`
     * for the api tag, `TestCaseRecorder` for the recorder — INFERRED from the key, never asserted
     * by the caller. This is the typed public surface over the deliberately type-erased backing Map.
     */
    getTrusted<V>(key: ContextKey<V, 'trusted'>): V | undefined {
        return this.readByName<V>(key.name);
    }

    /**
     * Read a value a caller merely ASSERTED — a browser-minted actionId, a recording flag, an
     * in-process log tag. Does not compile for a trusted key: reading a proven fact through the
     * untrusted verb would under-claim and hide, at the call site, that the value IS reliable.
     *
     * Treat everything this returns as attacker-controlled. It is fine for logging, tracing,
     * routing hints and rate-limit bucketing; it is never an input to "may they do this?".
     */
    getUntrusted<V>(key: ContextKey<V, 'untrusted'>): V | undefined {
        return this.readByName<V>(key.name);
    }

    /**
     * Store a value the framework PROVED. A distinct, greppable verb precisely so that writing a
     * trusted value is something code has to do ON PURPOSE — `grep -rn putTrusted` lists every place
     * in the repo that claims to have proven something, which is a reviewable set.
     *
     * Callers are the framework `AuthFilter` (stamping {@link ContextTuple}s an app's JwtHook derived
     * from a verified credential) and app code that has itself verified something out-of-band — the
     * signed-webhook case: Twilio/WhatsApp proves the phone number, the app looks up the userId, and
     * that userId is every bit as proven as a JWT claim.
     *
     * Does not compile for an untrusted key.
     */
    putTrusted<V>(key: ContextKey<V, 'trusted'>, value: V): void {
        this.writeByName(key.name, value);
    }

    /**
     * Store a caller-asserted value. `value` is type-checked against the key's value type `V`, so you
     * cannot put a number under a `ContextKey<string>` or a raw object under a typed key.
     *
     * Does not compile for a trusted key — which is what stops the inbound-header path, the api-tag
     * seam and ordinary app code from being side doors that forge a trusted value.
     */
    putUntrusted<V>(key: ContextKey<V, 'untrusted'>, value: V): void {
        this.writeByName(key.name, value);
    }

    /**
     * Read a key of ANY trust level and ANY value type, as `unknown`.
     *
     * FRAMEWORK SERIALIZATION ONLY — the log-field builders below, the outbound header builder, and
     * the {@link ContextReader} seam. Those loop over `HeaderRegistry` key arrays that are mixed in
     * both value type and trust, and they are not making a trust DECISION: they are copying values to
     * a log line or to the wire.
     *
     * It is deliberately read-only and has no write twin. A `putAny` would re-open the exact hole the
     * typed verbs close, because forging a trusted value is the dangerous direction; reading one
     * without saying `getTrusted` only costs you the `unknown` return type.
     */
    // webpieces-disable no-any-unknown -- key-agnostic serialization read: the key array is mixed in value type, so unknown is the honest return
    getAny(key: AnyContextKey): unknown {
        return this.readByName<unknown>(key.name);
    }

    /** Clear one context key. Used by the api-tag seam's set → log → remove span (see LogApiCall). */
    removeKey(key: AnyContextKey): void {
        this.storage.getStore()?.delete(key.name);
    }

    hasKey(key: AnyContextKey): boolean {
        return this.storage.getStore()?.has(key.name) ?? false;
    }

    /**
     * Build the masked field map for LOGGING: every logged key in the global
     * {@link HeaderRegistry} read straight from this context, secured values
     * masked (via {@link ContextKey.maskForLogs}), keyed by each key's `name`.
     *
     * Callers: RecordingFilter + NodeProxyClient.recordCall, which snapshot the context into a
     * test FIXTURE. The @webpieces/winston and @webpieces/bunyan backends also stamp these fields
     * onto every record, and they own the "log emitted outside RequestContext.run(...)" complaint —
     * reporting it HERE would recurse (the error line itself re-enters buildLogFields).
     *
     * Returns an EMPTY map outside a `run(...)` block rather than throwing: a fixture snapshot or a
     * log line is never worth crashing a request over.
     */
    buildLogFields(): Map<string, string> {
        const fields = new Map<string, string>();
        if (!this.isActive()) {
            return fields;
        }
        // The registry owns WHICH keys log (getLoggedKeys); we read each straight from THIS context
        // and each ContextKey masks its own secured value. String-only — this map feeds wire/MDC +
        // recorder fixtures — so an object-valued key (API_CALL_INFO) is guarded out by the
        // typeof-string check; objects ride buildStructuredLogFields instead. (Was a HeaderRegistry
        // method taking a read callback; only the server ever called it, so the seam was dead weight.)
        for (const key of HeaderRegistry.get().getLoggedKeys()) {
            // getLoggedKeys() is AnyContextKey[] — mixed in BOTH value type and trust — so this reads
            // through getAny (serialization, not a trust decision) and narrows with the typeof-string
            // guard rather than asserting a value type per key.
            const value = this.getAny(key);
            if (typeof value === 'string' && value) {
                fields.set(key.name, key.maskForLogs(value));
            }
        }
        return fields;
    }

    /**
     * The STRUCTURED field map for the node logging backends: like {@link buildLogFields}, but values
     * may be OBJECTS, so an object-valued logged key ({@link WebpiecesCoreHeaders.API_CALL_INFO} holding
     * an {@link ApiCallInfo}) survives as an object and the winston/bunyan backends nest it into
     * `jsonPayload.api`. Reads values UNTYPED (not `<string>`) so the object comes through intact.
     *
     * Outside a `run(...)` block it returns just the `svcName` + `version` entries below (not a fully
     * empty map): a log line is never worth crashing over, and startup/background lines must still say
     * which service and build emitted them.
     *
     * PLUS this service's `svcName` and this build's `version` from {@link ServiceInfo}. Neither is a
     * {@link ContextKey} — they are process-global identity facts, added HERE (BEFORE the active-context
     * check) so EVERY log line of BOTH node backends (winston/bunyan read this one map) says which
     * service and build emitted it — request path, startup, and background jobs alike — with no
     * per-backend duplication. This is the SINGLE place both are stamped, keeping the two backends
     * symmetrical (jsonPayload.svcName + jsonPayload.version). Read via the non-throwing
     * {@link ServiceInfo.getName} / {@link ServiceInfo.getVersion}, so each is simply ABSENT until
     * `setInfo` has run — logging keeps working before the service is identified, then the fields start
     * appearing. Caller-set `svcName`/`version` headers (there are none by convention) would be
     * overwritten here; that is intentional — the ServiceInfo identity is authoritative.
     */
    buildStructuredLogFields(): Map<string, string | object> {
        const fields = new Map<string, string | object>();
        // This service's `svcName` + this build's `version` from ServiceInfo — NOT ContextKeys, they are
        // process-global identity facts. Added FIRST, BEFORE the active-context check, so they ride EVERY
        // line of both node backends (they read this one map) — including startup and background-job lines
        // emitted with NO active RequestContext. Treated identically and read per-record via the
        // non-throwing getters, so each is simply ABSENT until setInfo has run, then starts appearing —
        // even if setInfo runs after a backend was constructed. This is the ONE place both facts are
        // stamped, so winston and bunyan stay symmetrical (jsonPayload.svcName + jsonPayload.version).
        const svcName = ServiceInfo.getName();
        if (svcName) {
            fields.set('svcName', svcName);
        }
        const version = ServiceInfo.getVersion();
        if (version) {
            fields.set('version', version);
        }
        if (!this.isActive()) {
            return fields;
        }
        // Like buildLogFields, but values may be OBJECTS (API_CALL_INFO): read UNTYPED so the object
        // survives and winston/bunyan nest it into jsonPayload.<name>. Secured STRING values are still
        // masked per key; non-string primitives are ignored rather than String()-flattened. (Inlined
        // from HeaderRegistry for the same reason as buildLogFields — only the server called it.)
        for (const key of HeaderRegistry.get().getLoggedKeys()) {
            const value = this.getAny(key);
            if (value === undefined || value === null) {
                continue;
            }
            if (typeof value === 'string') {
                if (value) {
                    fields.set(key.name, key.maskForLogs(value));
                }
            } else if (typeof value === 'object') {
                fields.set(key.name, value);
            }
        }
        return fields;
    }


    /**
     * Store the transport-neutral {@link HttpRequest} for this request. Called once, above the
     * api boundary, by whichever transport is driving the router (the express adapter, or the
     * in-process client). Filters/auth read it back via {@link getRequest} so they never touch
     * express — the same chain then runs over HTTP and in-process.
     */
    setRequest(request: HttpRequest): void {
        this.put(HTTP_REQUEST_KEY, request);
    }

    /** The current {@link HttpRequest}, or undefined if none was set for this context. */
    getRequest(): HttpRequest | undefined {
        return this.get<HttpRequest>(HTTP_REQUEST_KEY);
    }

    /**
     * Store a value under a RAW STRING key — the escape hatch for the framework's own reserved,
     * UNREGISTERED slots ('__webpieces_http_request__', the AuthFilter principal, the Cloud Tasks
     * schedule frame). Those are internal plumbing, not context keys, so they have no ContextKey and
     * no trust level.
     *
     * REJECTS any name that belongs to a registered {@link ContextKey}. Without that check this
     * method is a complete bypass of the trust system — `put('userId', req.body.userId)` would forge
     * a trusted value while never typing `putTrusted`, and an agent picks whatever compiles. The
     * check is necessarily a RUNTIME one: the registry is populated at `configure()` time, so "is
     * this string a registered key name" is not a fact a type can express.
     *
     * @throws Error when `key` is a registered ContextKey name — naming the verb to use instead.
     */
    // webpieces-disable no-any-unknown -- reserved-slot values are heterogeneous (HttpRequest, principal, schedule frame)
    put(key: string, value: any): void {
        this.rejectRegisteredName(key, 'putTrusted / putUntrusted');
        this.writeByName(key, value);
    }

    /**
     * Retrieve a value stored under a RAW STRING key. Same reserved-slot purpose, and the same
     * rejection, as {@link put} — reading `get('userId')` would hand back a trusted value without the
     * call site ever saying `getTrusted`, which is exactly the ambiguity this whole change removes.
     *
     * @throws Error when `key` is a registered ContextKey name — naming the verb to use instead.
     */
    // webpieces-disable no-any-unknown -- reserved-slot values are heterogeneous; callers name the concrete type
    get<T = any>(key: string): T | undefined {
        this.rejectRegisteredName(key, 'getTrusted / getUntrusted / getAny');
        return this.readByName<T>(key);
    }

    /**
     * Remove a value stored under a RAW STRING key. Registered names are rejected here too: deleting
     * a trusted key out from under a reader is a trust decision, so it goes through {@link removeKey}
     * with the key in hand.
     *
     * @throws Error when `key` is a registered ContextKey name.
     */
    remove(key: string): void {
        this.rejectRegisteredName(key, 'removeKey(key)');
        this.storage.getStore()?.delete(key);
    }

    /**
     * The guard behind the three raw-string accessors above. Silent (a no-op) until
     * `HeaderRegistry.configure(...)` has run, which is correct rather than lax: with no registry
     * there are no registered keys, so there is no trusted value to launder.
     */
    private rejectRegisteredName(name: string, useInstead: string): void {
        if (!HeaderRegistry.isConfigured()) {
            return;
        }
        const key = HeaderRegistry.get().findByName(name);
        if (key) {
            throw new Error(
                `RequestContext string accessors cannot touch '${name}' — it is a registered ` +
                `ContextKey (trust: '${key.trust}'). The raw string form hides whether the value is ` +
                `a proven fact or something a caller asserted, so it is a bypass of the trust ` +
                `system. Use ${useInstead} with the ContextKey itself.`,
            );
        }
    }

    /** The type-erased read. Every typed verb above funnels here; nothing else reads the store. */
    private readByName<T>(name: string): T | undefined {
        return this.storage.getStore()?.get(name);
    }

    /** The type-erased write. Every typed verb above funnels here; nothing else writes the store. */
    // webpieces-disable no-any-unknown -- context values are heterogeneous (strings, recorder, meta objects)
    private writeByName(name: string, value: any): void {
        const store = this.storage.getStore();
        if (!store) {
            throw new Error('No context available. Did you call Context.run() first?');
        }
        store.set(name, value);
    }

    /**
     * Clear all values from the current context.
     */
    clear(): void {
        const store = this.storage.getStore();
        store?.clear();
    }

    /**
     * Snapshot this scope so the work you are about to hand off keeps its request id, log fields and
     * proven identity. The ONLY producer of a {@link CapturedContext} — which is what makes the
     * restore side unforgeable, since there is no other way to obtain the payload it accepts.
     *
     * Outside a `run(...)` block this returns an EMPTY snapshot rather than throwing: capturing "no
     * context" is a legitimate thing for a background caller to do, and restoring it simply installs
     * nothing.
     *
     * The snapshot is a defensive COPY — writes to this context after capturing do not reach it.
     */
    copyContext(): CapturedContext {
        const store = this.storage.getStore();
        return CapturedContext.capture(ContextCaptureAuthority.INTERNAL, store ?? new Map());
    }

    /**
     * Overwrite the ACTIVE scope with a snapshot. The in-place twin of {@link runWithContext}, and the
     * one you almost never want: prefer `runWithContext`, which gives the restored work its OWN scope
     * and cannot disturb the caller's. Reach for this only when something else owns the scope and it
     * must be re-pointed in place.
     *
     * OVERWRITE, not merge — `clear()` runs first, so every entry the active scope holds and the
     * snapshot does not is DROPPED. That includes the empty case: `restoreContext(copyContext())`
     * taken outside a scope wipes the request id and every proven identity from a live request, and
     * says nothing. That is faithful (a snapshot restores exactly what it captured) but it is the
     * sharp edge of this method and the reason `runWithContext` is the default.
     *
     * Takes only a {@link CapturedContext} for the reason spelled out there — the DELETED Map-taking
     * form let `new Map([['userId','victim']])` forge a proven identity in one line.
     *
     * @throws Error when no RequestContext is active.
     */
    restoreContext(captured: CapturedContext): void {
        const store = this.storage.getStore();
        if (!store) {
            throw new Error(
                'No context available to restore into. Either open one with RequestContext.run(...) ' +
                'first, or use RequestContext.runWithContext(captured, fn), which opens its own.',
            );
        }
        captured.restoreInto(ContextCaptureAuthority.INTERNAL, store);
    }

    /**
     * Check if a key exists in the context.
     */
    /**
     * Presence of a value under a RAW STRING key. Guarded like its three siblings: `has('userId')`
     * alongside `hasKey(WebpiecesCoreHeaders.USER_ID)` would be a second spelling of one question,
     * and the string form is the one that says nothing about whether the value can be believed.
     *
     * @throws Error when `key` is a registered ContextKey name.
     */
    has(key: string): boolean {
        this.rejectRegisteredName(key, 'hasKey(key)');
        return this.storage.getStore()?.has(key) ?? false;
    }

    /**
     * Check if RequestContext is currently active.
     * Returns true if we're inside a RequestContext.run() block, false otherwise.
     *
     * Useful for tests to verify context is set up before making API calls.
     */
    isActive(): boolean {
        return this.storage.getStore() !== undefined;
    }

}



/**
 * Global singleton instance of RequestContext.
 * Use this throughout your application.
 */
export const RequestContext = new RequestContextImpl();
