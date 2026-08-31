/**
 * Where this process is running, as a NAMED token rather than a boolean:
 *
 * - `'local'`    — a developer's machine. `@AuthLocalOnly` endpoints exist and serve.
 * - `'deployed'` — anywhere else (staging, prod, CI, a container). `@AuthLocalOnly` endpoints are
 *                  not registered and, if reached anyway, 404.
 *
 * A `boolean` would have made the DANGEROUS half (`true`) unnameable and ungreppable — see CLAUDE.md
 * shim shape #5. `grep -rn "'local'" ` over a repo's startup now lists every place that claims to be a
 * developer's machine.
 */
export type Locality = 'local' | 'deployed';

/**
 * RuntimeLocality - the ONE answer to "am I running on a developer's machine?", for the one part of
 * webpieces that needs it: {@link AuthLocalOnly}.
 *
 * ## Why this is a seam and not a `process.env` read
 *
 * The framework cannot compute this itself and must not try. "Local" is a fact about the DEPLOYMENT
 * PLATFORM: Cloud Run derives it from `K_SERVICE`, ECS from `ECS_CONTAINER_METADATA_URI`, a laptop
 * from the absence of both. Baking any one of those into core-util would hardcode a cloud vendor into
 * the framework core, and core-util is browser-safe (it may not read `process.env` at all). So the
 * ENVIRONMENT tells the framework, exactly as it tells it the logging backend
 * ({@link LogManager.setFactory}), the header set ({@link HeaderRegistry.configure}) and its own
 * identity ({@link ServiceInfo.setInfo}). (The {@link ApiCallContext} seam is NOT in that list any
 * more: it is a constructor argument to {@link LogApiCallImpl}, not a startup install.)
 *
 * It is a VALUE holder rather than an interface-plus-impl (the `ApiCallContext` shape) because there
 * is no behavior to plug in — the answer is one token fixed at startup. Per CLAUDE.md, data is a
 * class; only behavior is an interface.
 *
 * ## Where it is declared
 *
 * `RuntimeSetupOptions` takes it as a REQUIRED, positional constructor argument, so `setupRuntime`
 * declares it on every server and no server can boot without having stated it. That is the same
 * forcing function `@Endpoint(path, kind)` uses: a required positional argument turns "we forgot" into
 * a compile error instead of a runtime guess.
 *
 * ## FAIL SAFE when nothing declared it
 *
 * {@link isLocalDevelopment} returns `false` until {@link declare} is called. An undeclared process is
 * treated as DEPLOYED, so the failure mode of a forgotten wiring call is "my local-only endpoint 404s
 * on my laptop" — annoying and instantly visible — never "my local-only endpoint is live in
 * production". The permissive answer is never the one you get by not typing anything.
 */
export class RuntimeLocality {
    /** Process-global; set once at startup. `undefined` = never declared = treated as deployed. */
    private static locality: Locality | undefined;

    /**
     * State where this process is running. Call it at startup — `setupRuntime` does it for you from
     * `RuntimeSetupOptions.locality`.
     *
     * LAST CALL WINS, mirroring {@link ServiceInfo.setInfo}: an in-process test can legitimately boot
     * two servers back-to-back.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like ServiceInfo/HeaderRegistry); populated once at startup, never DI-injected
    static declare(locality: Locality): void {
        RuntimeLocality.locality = locality;
    }

    /**
     * True ONLY when a startup explicitly declared `'local'`. Undeclared reads as deployed — see the
     * fail-safe note on the class. Does not throw: a wrong answer here must refuse an endpoint, never
     * 500 unrelated traffic.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like ServiceInfo/HeaderRegistry); populated once at startup, never DI-injected
    static isLocalDevelopment(): boolean {
        return RuntimeLocality.locality === 'local';
    }

    /**
     * Whether anything declared a locality at all. Used ONLY to make the refusal log say which of the
     * two reasons applies — "you are deployed" vs "nobody ever told me" — because those have very
     * different fixes and a developer staring at a 404 on their own laptop needs to know which.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like ServiceInfo/HeaderRegistry); populated once at startup, never DI-injected
    static isDeclared(): boolean {
        return RuntimeLocality.locality !== undefined;
    }

    /** Reset — for tests, mirroring {@link ServiceInfo.clear}. */
    // webpieces-disable no-function-outside-class -- static global singleton (like ServiceInfo/HeaderRegistry); populated once at startup, never DI-injected
    static clear(): void {
        RuntimeLocality.locality = undefined;
    }
}
