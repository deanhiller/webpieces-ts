import { RouteMetadata } from '@webpieces/core-util';

/**
 * The OUTBOUND request as the client filter chain sees it — the client-side twin of the server's
 * `MethodMeta`, and the `REQ` of every `Filter<ClientRequest, Response>`.
 *
 * MUTABLE on purpose, and that is the whole point of the chain: a filter re-points the URL, adds a
 * header, or replaces the serialized bytes, and whatever this object holds when the chain bottoms
 * out is EXACTLY what goes on the wire.
 *
 * ## Why the URL is behind mutators instead of two public fields
 *
 * A call has both a base URL (the host we are talking to — the OIDC audience, the thing an SSRF
 * policy judges) and a full URL (base + this route's path, or an absolute Location we were
 * redirected to). Exposing both as writable fields makes it possible for them to disagree, and a
 * base URL that disagrees with the URL actually fetched is precisely the shape of an SSRF bypass.
 * So both are private, and the only two ways to move this request are {@link pointAtBaseUrl} and
 * {@link followRedirectTo}, each of which sets BOTH consistently.
 *
 * ## Signing
 *
 * {@link body} holds the serialized bytes, not the DTO — serialization happens BEFORE the chain
 * runs. A signing filter computes its HMAC over `request.body` and adds a header, and the transport
 * sends `request.body` verbatim, so the bytes signed and the bytes sent cannot differ. That was
 * impossible while a client owned serialization internally with no seam, which is why outbound
 * webhook senders were forced back to hand-rolling `JSON.stringify` and a raw HTTP library — a
 * library that re-serializes internally would sign one byte sequence and send another.
 */
export class ClientRequest {
    /** The base URL half of {@link url} — the host, without this route's path. */
    private currentBaseUrl: string;

    /** The absolute URL this call will actually be sent to. */
    private currentUrl: string;

    /**
     * FALSE while this request still points where the client's own configuration put it; TRUE the
     * moment anything moved it — {@link pointAtBaseUrl} or {@link followRedirectTo}.
     *
     * This flag is what makes the SSRF guard automatic AND free. A URL that came out of
     * `ClientRegistry` is an address WE chose, so judging it would mean resolving DNS on every
     * internal RPC in order to re-derive a fact we already know. A URL a filter substituted is not:
     * it arrived from outside the call — a partner-editable row, an OAuth callback, a `Location`
     * header — and that is precisely the input an SSRF policy exists to judge.
     *
     * So the trigger is the ACT of re-pointing rather than a per-client setting, which means no app
     * can forget to switch the guard on and none can switch it off by omitting an argument.
     */
    private rePointed = false;

    /**
     * Whether the transport may follow a 3xx itself. The SSRF guard sets this FALSE so it can read
     * the `Location`, judge it under the same policy as the original URL, and only then re-invoke
     * the chain — a partner URL that 302s must not be able to bounce our POST at an internal
     * address.
     */
    followRedirects = true;

    constructor(
        /** The route being called — its path, http method, and auth mode. */
        public readonly route: RouteMetadata,
        /** The API contract's class name, e.g. 'PartnerWebhookApi'. For messages and logs. */
        public readonly contractName: string,
        baseUrl: string,
        /** Outbound headers. Mutable: a filter adds its signature/idempotency/tracing headers here. */
        public readonly headers: Map<string, string>,
        /** The EXACT serialized request body, or undefined for a call with no argument. */
        public body: string | undefined,
        /**
         * The request DTO the caller passed, BEFORE serialization. Read-only, and deliberately not
         * the thing that gets sent: a filter that wants to change what goes on the wire changes
         * {@link body}, so there is never a question of which of the two won.
         */
        // webpieces-disable no-any-unknown -- the request DTO's type is erased at the proxy boundary
        public readonly requestDto: unknown,
    ) {
        this.currentBaseUrl = baseUrl;
        this.currentUrl = `${baseUrl}${route.path}`;
    }

    /** The host this call is currently addressed to, with no path. */
    get baseUrl(): string {
        return this.currentBaseUrl;
    }

    /** The absolute URL this call will be sent to. */
    get url(): string {
        return this.currentUrl;
    }

    /**
     * TRUE once anything has moved this request off the address the client resolved for itself —
     * i.e. once the destination is DATA rather than a peer we named. See {@link rePointed}.
     */
    get destinationCameFromData(): boolean {
        return this.rePointed;
    }

    /**
     * Re-point this ONE call at another host, keeping this route's path. `ContextBaseUrlFilter`
     * calls this with the URL a partner registered; nothing here is remembered by the client, so
     * the next call through the same client starts from its configured host again.
     *
     * It also flips {@link destinationCameFromData}, which is what arms the SSRF guard sitting
     * below every app filter. That coupling is deliberate and lives HERE rather than in the guard:
     * a filter cannot move the request without saying so, because moving it is only possible
     * through this method.
     */
    pointAtBaseUrl(baseUrl: string): void {
        this.currentBaseUrl = baseUrl;
        this.currentUrl = `${baseUrl}${this.route.path}`;
        this.rePointed = true;
    }

    /**
     * Follow a redirect to an ABSOLUTE url. The base URL becomes that url's origin, so a policy
     * that judges hosts judges the host we are actually about to talk to. Flips
     * {@link destinationCameFromData} for the same reason {@link pointAtBaseUrl} does: a `Location`
     * header is the far end's data, not an address we chose.
     *
     * @throws TypeError if `absoluteUrl` is not a parseable absolute URL.
     */
    followRedirectTo(absoluteUrl: string): void {
        this.currentBaseUrl = new URL(absoluteUrl).origin;
        this.currentUrl = absoluteUrl;
        this.rePointed = true;
    }

    /** The headers in the shape the transport wants. */
    headersAsRecord(): Record<string, string> {
        const record: Record<string, string> = {};
        for (const entry of this.headers.entries()) {
            record[entry[0]] = entry[1];
        }
        return record;
    }
}
