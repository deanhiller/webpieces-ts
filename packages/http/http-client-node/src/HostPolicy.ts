import { AuthMeta, ClientRegistry } from '@webpieces/core-util';
import { ClientFilterDefinition } from '@webpieces/http-client-core';
import { AddressResolver } from './AddressResolver';
import { BASE_URL_OVERRIDE_PRIORITY, ContextBaseUrlOverrideFilter, SSRF_GUARD_PRIORITY } from './ContextBaseUrlOverrideFilter';
import { SsrfGuardFilter } from './SsrfGuardFilter';
import { SsrfPolicy } from './SsrfPolicy';
import { RuntimeHostEndpointUnsupportedError } from './RuntimeHostErrors';

/**
 * WHERE a client's requests go — the second half of a {@link ClientConfig}, and a REQUIRED one.
 *
 * There are exactly two kinds of destination, and conflating them is what made outbound partner
 * webhooks fall out of the typed world entirely:
 *
 * - a service WE DEPLOY, named by `svcName` and resolved through {@link ClientRegistry}
 *   → {@link DeployedServiceHost}
 * - a host that is DATA — a URL a partner registered, an OAuth callback, a per-tenant or
 *   self-hosted instance — supplied per call through the RequestContext
 *   → {@link RuntimeHostFromContext}
 *
 * Naming one is not optional, because the two carry completely different risk. A deployed peer is
 * an address we chose; a runtime host is attacker-influenced data, and the framework owes it an
 * SSRF policy. Making the choice a class the caller writes down means
 * `grep -rn RuntimeHostFromContext` enumerates every client in the codebase that can be re-pointed
 * at all — which is the question a security review actually asks.
 */
export abstract class HostPolicy {
    /**
     * The base URL this call STARTS from, before any filter re-points it.
     *
     * For a deployed service that is the whole answer. For a runtime host it is the empty string:
     * there is nothing to resolve at this point, and {@link ContextBaseUrlOverrideFilter} — which
     * this policy also installs — supplies the real destination inside the chain, or refuses. The
     * empty seed is never sent: the override filter throws when the context carries no URL, and the
     * SSRF guard refuses anything that is not an absolute https URL.
     */
    abstract resolveBaseUrl(svcName: string): Promise<string>;

    /** The framework filters this policy installs, in addition to whatever the app passed. */
    abstract builtInFilters(): ClientFilterDefinition[];

    /**
     * Reject, at BIND time, an endpoint this policy cannot honestly satisfy.
     *
     * @throws Error naming the endpoint and why. The default accepts everything.
     */
    assertEndpointSupported(_authMeta: AuthMeta | undefined, _methodName: string, _contractName: string): void {}
}

/**
 * TODAY'S BEHAVIOUR, unchanged and byte for byte: the destination is a service we deploy, and its
 * URL comes from {@link ClientRegistry} — a registered mapping, else the installed deriver, else a
 * throw.
 *
 * It installs NO filters, reads no context key, and performs no DNS lookups, so a client written
 * this way runs the exact code path it ran before the outbound chain existed. This is the one to
 * reach for; the runtime ones are for the case where the address genuinely is not knowable at
 * build time.
 */
export class DeployedServiceHost extends HostPolicy {
    override resolveBaseUrl(svcName: string): Promise<string> {
        return ClientRegistry.resolve(svcName);
    }

    override builtInFilters(): ClientFilterDefinition[] {
        return [];
    }
}

/**
 * The destination is supplied PER CALL, through
 * `RequestContext.putUntrusted(WebpiecesCoreHeaders.OVERRIDE_BASE_URL, url)`, and the framework's
 * SSRF policy is ON.
 *
 * ```ts
 * const partner = factory.createRpcClient(
 *     PartnerWebhookApi,
 *     new ClientConfig('partner-webhooks', new RuntimeHostFromContext(new DnsAddressResolver())),
 *     [new ClientFilterDefinition(500, new HmacSigningFilter(secret))],
 * );
 *
 * for (const webhook of webhooks) {
 *     await RequestContext.run(() => {
 *         RequestContext.putUntrusted(WebpiecesCoreHeaders.OVERRIDE_BASE_URL, webhook.url);
 *         return partner.deliver(envelope);
 *     });
 * }
 * ```
 *
 * `svcName` is still required, and still means something: it is the IDENTITY this client gets as a
 * node on the runtime architecture graph. That is the whole point of routing partner deliveries
 * back through a generated client — the most security-sensitive hop in the system stops being
 * invisible.
 *
 * Endpoints whose auth mode is `@AuthOidc` or `@AuthSharedSecret` are REFUSED at bind time. Both
 * mint a credential for a specific audience/peer that we chose, and there is no honest audience for
 * a host we will not know until the call happens — minting one for a partner's URL would hand them
 * a token. Authenticate a runtime-host call the way a webhook is actually authenticated: a signing
 * filter over the exact bytes.
 */
export class RuntimeHostFromContext extends HostPolicy {
    constructor(private readonly addressResolver: AddressResolver) {
        super();
    }

    override async resolveBaseUrl(_svcName: string): Promise<string> {
        return '';
    }

    override builtInFilters(): ClientFilterDefinition[] {
        return runtimeHostFilters(this.addressResolver, RuntimeHostFromContext.STRICT);
    }

    override assertEndpointSupported(
        authMeta: AuthMeta | undefined,
        methodName: string,
        contractName: string,
    ): void {
        assertNoServiceCredential(authMeta, methodName, contractName);
    }

    /** HTTPS only, no internal addresses, at most one redirect — each hop re-judged. */
    private static readonly STRICT = new SsrfPolicy(new Set(['https:']), false, 1, undefined);
}

/**
 * {@link RuntimeHostFromContext}, with the internal-address refusals SWITCHED OFF and plaintext
 * http allowed — for a local emulator, an on-cluster service, or a test harness whose "partner" is
 * `http://127.0.0.1:9123`.
 *
 * The long name is the feature. This is the permissive branch, so it is a NOUN a reviewer can grep
 * (`grep -rn AllowingInternalAddresses` lists every client that can reach inside the network with a
 * runtime-supplied URL) rather than a boolean, an omitted argument, or an empty allow-list — a
 * widening that reads as an ABSENCE is invisible exactly where it matters most.
 *
 * The `reason` is required and is quoted back in this client's refusal messages, so the
 * justification travels with the decision instead of living in a commit message.
 */
export class RuntimeHostFromContextAllowingInternalAddresses extends HostPolicy {
    private readonly policy: SsrfPolicy;

    constructor(
        /** WHY this client may reach internal addresses, in prose. Required. */
        reason: string,
        private readonly addressResolver: AddressResolver,
    ) {
        super();
        this.policy = new SsrfPolicy(new Set(['https:', 'http:']), true, 1, reason);
    }

    override async resolveBaseUrl(_svcName: string): Promise<string> {
        return '';
    }

    override builtInFilters(): ClientFilterDefinition[] {
        return runtimeHostFilters(this.addressResolver, this.policy);
    }

    override assertEndpointSupported(
        authMeta: AuthMeta | undefined,
        methodName: string,
        contractName: string,
    ): void {
        assertNoServiceCredential(authMeta, methodName, contractName);
    }
}

/**
 * The two built-ins every runtime-host client gets: settle the destination from the context, then
 * judge it. Shared by both runtime policies so the ORDER cannot drift between them — a guard that
 * ran before the override would be judging the wrong URL.
 */
// webpieces-disable no-function-outside-class -- shared construction of two filter definitions; it holds no state a class could own
function runtimeHostFilters(addressResolver: AddressResolver, policy: SsrfPolicy): ClientFilterDefinition[] {
    return [
        new ClientFilterDefinition(BASE_URL_OVERRIDE_PRIORITY, new ContextBaseUrlOverrideFilter()),
        new ClientFilterDefinition(SSRF_GUARD_PRIORITY, new SsrfGuardFilter(policy, addressResolver)),
    ];
}

/**
 * @throws Error when the endpoint expects a credential minted for an audience we choose. Shared by
 *         both runtime policies for the same reason {@link runtimeHostFilters} is.
 */
// webpieces-disable no-function-outside-class -- shared bind-time assertion; it holds no state a class could own
function assertNoServiceCredential(
    authMeta: AuthMeta | undefined,
    methodName: string,
    contractName: string,
): void {
    const kind = authMeta?.mode?.kind;
    if (kind !== 'oidc' && kind !== 'shared-secret') {
        return;
    }
    throw new RuntimeHostEndpointUnsupportedError(
        `${contractName}.${methodName} is authenticated with '${kind}', which cannot be used by a ` +
            `runtime-host client. Both mint a credential for a peer WE chose — an OIDC token's audience is ` +
            `the callee's base URL, and a shared secret is one we agreed with a named service — and the ` +
            `destination here is not known until the call happens, so minting either one would hand our ` +
            `credential to whoever registered the URL. Authenticate this hop the way a webhook actually is ` +
            `authenticated: an app filter that signs the exact serialized bytes (ClientRequest.body).`,
        `${contractName}.${methodName}`,
    );
}
