import { Filter, Service, toError } from '@webpieces/core-util';
import { ClientRequest } from '@webpieces/http-client-core';
import { AddressResolver } from './AddressResolver';
import { InternalAddressRules } from './InternalAddressRules';
import { SsrfPolicy } from './SsrfPolicy';
import { SsrfRefusedError } from './SsrfRefusedError';

/**
 * Enforces {@link SsrfPolicy} on a call whose destination came from RUNTIME data.
 *
 * The moment the base URL is a database column a partner edited, "do not let our process be used as
 * a proxy into our own network" stops being the caller's job and becomes the framework's. Every
 * consumer was reinventing this, badly or not at all, and the one that did it best still only
 * managed `maxRedirects: 0` by hand.
 *
 * ## Installed on EVERY client; it costs nothing until a filter moves the request
 *
 * It sits beneath every app filter of every client this package builds, and the first thing it does
 * is ask `request.destinationCameFromData`. FALSE — the URL is what `ClientRegistry` resolved, an
 * address we chose — and it steps aside without parsing a URL or resolving a name, so an ordinary
 * service-to-service RPC runs exactly the code path it ran before this class existed. TRUE only
 * once something re-pointed the request, which is the one input a partner controls.
 *
 * That is why there is no per-client switch: an app cannot forget to turn the guard on for a client
 * that takes runtime URLs, and cannot turn it off for one — the ACT of re-pointing is the trigger.
 *
 * ## What it enforces, per hop
 *
 * 1. the URL parses and its scheme is allowed (https only, by default);
 * 2. the hostname is not internal BY NAME (`localhost`, `metadata.google.internal`, `*.internal`);
 * 3. EVERY address the hostname resolves to is public — one private answer among several condemns
 *    the request, which is what makes DNS rebinding a refusal rather than a coin toss;
 * 4. redirects are not followed by the transport. The guard reads the `Location` itself, re-runs
 *    (1)–(3) on it, and only then re-invokes the chain. A partner URL that 302s to
 *    `http://169.254.169.254/…` is refused at the redirect, not obeyed — and because the whole
 *    chain below re-runs, whatever signs the request signs it for the host it is actually going to.
 *
 * ## What it deliberately does NOT claim
 *
 * There is a TOCTOU window between resolving a name and the transport connecting: a hostile DNS
 * server can answer differently for the two lookups. Closing it properly means pinning the resolved
 * address into the socket, which node's transport gives no seam for. This guard raises the cost of
 * the attack a great deal and is honest about not eliminating it; egress firewalling remains the
 * control that actually cannot be tricked.
 */
export class SsrfGuardFilter extends Filter<ClientRequest, Response> {
    private readonly rules = new InternalAddressRules();

    constructor(
        private readonly policy: SsrfPolicy,
        private readonly addressResolver: AddressResolver,
    ) {
        super();
    }

    override async filter(request: ClientRequest, nextFilter: Service<ClientRequest, Response>): Promise<Response> {
        // The destination is still the one this client resolved for itself, so there is nothing
        // attacker-influenced to judge. Step aside entirely — no parse, no DNS, no redirect
        // interception — so the deployed-service path is byte-identical to having no guard at all.
        if (!request.destinationCameFromData) {
            return nextFilter.invoke(request);
        }
        await this.assertAllowed(request.url);

        // The transport must not follow a redirect on its own — that would be a hop this policy
        // never saw. We read the Location and judge it ourselves, below.
        request.followRedirects = false;

        let response = await nextFilter.invoke(request);
        for (let hop = 0; this.isRedirect(response); hop++) {
            if (hop >= this.policy.maxRedirects) {
                throw new SsrfRefusedError(
                    `${request.contractName}.${request.route.methodName}: refused to follow more than ` +
                        `${this.policy.maxRedirects} redirect(s) from a runtime-supplied destination. ` +
                        `The last one was ${request.url}. A webhook endpoint that needs a longer redirect ` +
                        `chain should be registered at its final URL instead.`,
                    request.url,
                );
            }
            const target = this.redirectTargetOf(response, request);
            await this.assertAllowed(target);
            request.followRedirectTo(target);
            response = await nextFilter.invoke(request);
        }
        return response;
    }

    /**
     * @throws SsrfRefusedError naming what condemned the url and the ONE opt-out that would allow
     *         it. Returns normally when the destination is acceptable.
     */
    private async assertAllowed(url: string): Promise<void> {
        const parsed = this.parse(url);
        if (!this.policy.allowedSchemes.has(parsed.protocol)) {
            const allowed = [...this.policy.allowedSchemes].join(', ');
            throw new SsrfRefusedError(
                `Refusing to send to ${url}: scheme '${parsed.protocol}' is not allowed (allowed: ${allowed}). ` +
                    `A destination supplied at runtime must be reached over TLS — a plaintext hop leaks the ` +
                    `payload and its signature to anything on the path.`,
                url,
            );
        }
        if (this.policy.allowInternalAddresses) {
            return;
        }
        const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
        if (this.rules.isInternalHostname(hostname)) {
            throw this.refuseInternal(url, `'${hostname}' names infrastructure inside our own network`);
        }
        for (const address of await this.resolveOrRefuse(url, hostname)) {
            if (this.rules.isInternalAddress(address)) {
                throw this.refuseInternal(url, `it resolves to the internal address ${address}`);
            }
        }
    }

    private refuseInternal(url: string, because: string): SsrfRefusedError {
        return new SsrfRefusedError(
            `Refusing to send to ${url}: ${because}. A destination supplied at runtime is attacker-influenced ` +
                `data, so loopback, RFC1918, link-local and cloud-metadata addresses are refused — reaching ` +
                `169.254.169.254 would hand this process's own service-account tokens to whoever registered ` +
                `the URL. To reach one of OUR OWN services at a local port, register it — ` +
                `ClientRegistry.addUrlMapping('svc', 'http://localhost:8202') — and a registry-resolved ` +
                `URL is never judged here at all. If this client genuinely must dial an internal address ` +
                `from RUNTIME data (exercising the partner path against a local fake), say so at the ` +
                `construction site with ` +
                `new ContextBaseUrlFilter(SsrfPolicy.forTesting('<why>')).`,
            url,
        );
    }

    /** Every address for `hostname`, or a refusal — a name that will not resolve is not a destination. */
    private async resolveOrRefuse(url: string, hostname: string): Promise<string[]> {
        // An IP LITERAL never went to DNS, so judge it directly; hostnames go to the resolver.
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) {
            return [hostname];
        }
        // webpieces-disable no-unmanaged-exceptions -- turn an unresolvable name into the SAME refusal a bad address gets
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return await this.addressResolver.resolve(hostname);
        } catch (err: unknown) {
            const error = toError(err);
            throw new SsrfRefusedError(
                `Refusing to send to ${url}: '${hostname}' did not resolve (${error.message}). ` +
                    `An unresolvable destination is refused rather than attempted, so a partner row that has ` +
                    `gone stale fails as a delivery error instead of as a network timeout.`,
                url,
            );
        }
    }

    private parse(url: string): URL {
        // webpieces-disable no-unmanaged-exceptions -- an unparseable url is a refusal, in this filter's own vocabulary
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return new URL(url);
        } catch (err: unknown) {
            const error = toError(err);
            throw new SsrfRefusedError(
                `Refusing to send to '${url}': it is not a parseable absolute URL (${error.message}). ` +
                    `A runtime-supplied base URL must be absolute, e.g. 'https://api.partner.example'.`,
                url,
            );
        }
    }

    private isRedirect(response: Response): boolean {
        return response.status >= 300 && response.status < 400 && response.headers.get('location') !== null;
    }

    /** The redirect's absolute target, resolving a relative Location against the URL we just called. */
    private redirectTargetOf(response: Response, request: ClientRequest): string {
        const location = response.headers.get('location') ?? '';
        // webpieces-disable no-unmanaged-exceptions -- a malformed Location is a refusal, in this filter's own vocabulary
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return new URL(location, request.url).toString();
        } catch (err: unknown) {
            const error = toError(err);
            throw new SsrfRefusedError(
                `Refusing to follow the redirect from ${request.url}: its Location header ` +
                    `'${location}' is not a usable URL (${error.message}).`,
                request.url,
            );
        }
    }
}
