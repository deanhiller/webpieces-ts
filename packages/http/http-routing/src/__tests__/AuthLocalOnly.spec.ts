import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GcpOidc } from '@webpieces/gcp-identity';
import { HttpRequest, RequestContext, RequestContextHeaders } from '@webpieces/core-context';
import {
    ApiPath,
    AuthLocalOnly,
    ContextKey,
    Endpoint,
    EndpointNotFoundError,
    HeaderRegistry,
    HttpUnauthorizedError,
    Public,
    RouteMetadata,
    RuntimeLocality,
    AuthMeta,
} from '@webpieces/core-util';
import { AuthFilter } from '../filters/AuthFilter';
import { DefaultOidcVerifier } from '../DefaultOidcVerifier';
import { ApiRoutingFactory } from '../ApiRoutingFactory';
import { MethodMeta } from '../MethodMeta';
import { Service } from '@webpieces/core-util';
import { WpResponse } from '../WpResponse';
import { RouteBuilder, RouteDefinition, FilterDefinition } from '../WebAppMeta';

/**
 * The ENFORCEMENT half of `@AuthLocalOnly` (the decorator + locality seam + outbound-trust half is
 * pinned in core-util's `AuthLocalOnly.spec.ts`).
 *
 * TWO gates, ONE declaration. Off-local the route is never registered (`ApiRoutingFactory`), and if
 * something registers it by hand anyway, `AuthFilter` 404s it. That is deliberately the same pair of
 * checks apps used to hand-roll across a route module and a controller — the difference is that both
 * now read the single `@AuthLocalOnly()` on the contract instead of being kept in sync by a comment.
 */

@AuthLocalOnly()
@ApiPath('/dev')
abstract class DevToolsApi {
    @Endpoint('/logs', 'rpc')
    shipLogs(_r: object): Promise<object> {
        throw new Error('subclass');
    }
}

class DevToolsController extends DevToolsApi {
    override async shipLogs(_r: object): Promise<object> {
        return {};
    }
}

@Public()
@ApiPath('/open')
abstract class OpenApi {
    @Endpoint('/ping', 'rpc')
    ping(_r: object): Promise<object> {
        throw new Error('subclass');
    }

    @AuthLocalOnly()
    @Endpoint('/debug', 'rpc')
    debug(_r: object): Promise<object> {
        throw new Error('subclass');
    }
}

class OpenController extends OpenApi {
    override async ping(_r: object): Promise<object> {
        return {};
    }

    override async debug(_r: object): Promise<object> {
        return {};
    }
}

const USER_ID = ContextKey.trusted<string>('userId', 'jwt claim `sub`', 'x-user-id');
const TENANT = ContextKey.untrusted<string>('tenantId', 'x-tenant-id');

/** Collects what `configure()` actually registered, so a SKIPPED route is visible as an absence. */
class CollectingRouteBuilder implements RouteBuilder {
    readonly paths: string[] = [];

    addRoute(route: RouteDefinition): void {
        this.paths.push(route.routeMeta.path);
    }

    addFilter(_filter: FilterDefinition): void {
        // no filters in these tests
    }
}

/** Records whether the chain got past AuthFilter at all. */
class RecordingNext implements Service<MethodMeta, WpResponse<unknown>> {
    invoked = false;
    /** Context snapshot taken INSIDE the scope, so a test can assert what survived AuthFilter. */
    seenTenant: string | undefined;

    async invoke(_meta: MethodMeta): Promise<WpResponse<unknown>> {
        this.invoked = true;
        this.seenTenant = RequestContext.getUntrusted(TENANT);
        return new WpResponse<unknown>({});
    }
}

const LOCAL_ONLY_ROUTE = new RouteMetadata(
    'POST', '/dev/logs', 'shipLogs', 'DevToolsController',
    new AuthMeta({ kind: 'local-only' }), 'DevToolsApi',
);

/**
 * Only the local-only branch runs in this file, and it touches none of AuthFilter's collaborators —
 * that is the point of the mode: it consults the ENVIRONMENT, never a credential.
 */
function newAuthFilter(): AuthFilter {
    return new AuthFilter(new DefaultOidcVerifier(new GcpOidc()));
}

/** Run the filter inside a request scope (AuthFilter reads the inbound request + pending trust). */
async function runFilter(next: RecordingNext): Promise<WpResponse<unknown>> {
    return RequestContext.run(async () =>
        newAuthFilter().filter(new MethodMeta(LOCAL_ONLY_ROUTE), next),
    );
}

beforeEach(() => {
    RuntimeLocality.clear();
});

afterEach(() => {
    RuntimeLocality.clear();
});

describe('AuthFilter enforces @AuthLocalOnly', () => {
    it('SERVES the endpoint when the startup declared this a local developer machine', async () => {
        RuntimeLocality.declare('local');
        const next = new RecordingNext();

        await runFilter(next);

        expect(next.invoked).toBe(true);
    });

    /**
     * 404, not the 403 apps hand-rolled: off-local the route is not registered, so the ordinary way
     * to reach this path already answers 404. A 403 would be a DIFFERENT answer for the same
     * endpoint, and that difference confirms "this path exists in production" to anyone probing.
     */
    it('404s — never 403 — when the process declared itself deployed', async () => {
        RuntimeLocality.declare('deployed');
        const next = new RecordingNext();

        await expect(runFilter(next)).rejects.toThrow(EndpointNotFoundError);
        // 404 on the wire — the SAME answer an unregistered route gives, which is the whole point.
        await expect(runFilter(next)).rejects.toMatchObject({ code: 404 });
        expect(next.invoked).toBe(false);
    });

    /**
     * THE FAIL-SAFE. If nothing ever told the framework where it runs, the answer must be "not
     * local" — a forgotten wiring call has to refuse a dev-only endpoint, never expose one.
     */
    it('404s when NOTHING declared a locality (undeclared reads as deployed)', async () => {
        expect(RuntimeLocality.isDeclared()).toBe(false);
        const next = new RecordingNext();

        await expect(runFilter(next)).rejects.toThrow(EndpointNotFoundError);
        expect(next.invoked).toBe(false);
    });
});

/**
 * The INBOUND twin of the `DestinationTrust` rule pinned in core-util's spec. One rule seen from two
 * ends: the client omits trusted keys for a destination that cannot verify it, and the server rejects
 * trusted keys on a route that cannot verify the sender. `@AuthLocalOnly` verifies WHERE WE RUN, not
 * WHO CALLS — and it has no authenticator at all, so nothing can ever vouch for an inbound trusted
 * header and every one of them must reject the request.
 *
 * If these two ends disagreed, every local-only call carrying context would 401 and look like a
 * framework bug.
 */
describe('AuthFilter treats @AuthLocalOnly as NOT caller-verifying on the inbound side', () => {
    /** Fill the context from a wire request, then run AuthFilter on the local-only route. */
    async function inboundThenFilter(headers: Map<string, string[]>, next: RecordingNext): Promise<WpResponse<unknown>> {
        HeaderRegistry.configure([USER_ID, TENANT], /*platformHeaders*/ true);
        RuntimeLocality.declare('local');
        return RequestContext.run(async () => {
            new RequestContextHeaders().fillFromRequest(new HttpRequest('POST', '/dev/logs', headers));
            return newAuthFilter().filter(new MethodMeta(LOCAL_ONLY_ROUTE), next);
        });
    }

    it('REJECTS an inbound TRUSTED header — no authenticator ran, so nothing vouched for it', async () => {
        const next = new RecordingNext();
        const headers = new Map<string, string[]>([['x-user-id', ['attacker-supplied']]]);

        await expect(inboundThenFilter(headers, next)).rejects.toThrow(HttpUnauthorizedError);
        expect(next.invoked).toBe(false);
    });

    it('lets an inbound UNTRUSTED header through into context as normal', async () => {
        const next = new RecordingNext();
        const headers = new Map<string, string[]>([['x-tenant-id', ['tenant-9']]]);

        await inboundThenFilter(headers, next);

        expect(next.invoked).toBe(true);
        expect(next.seenTenant).toBe('tenant-9');
    });
});

describe('ApiRoutingFactory does not even REGISTER a local-only route off-local', () => {
    it('registers it on a local developer machine', () => {
        RuntimeLocality.declare('local');
        const builder = new CollectingRouteBuilder();

        new ApiRoutingFactory(DevToolsApi, DevToolsController).configure(builder);

        expect(builder.paths).toEqual(['/dev/logs']);
    });

    it('registers NOTHING for a deployed process — the endpoint does not exist', () => {
        RuntimeLocality.declare('deployed');
        const builder = new CollectingRouteBuilder();

        new ApiRoutingFactory(DevToolsApi, DevToolsController).configure(builder);

        expect(builder.paths).toEqual([]);
    });

    it('registers nothing when no locality was declared at all (the same fail-safe)', () => {
        const builder = new CollectingRouteBuilder();

        new ApiRoutingFactory(DevToolsApi, DevToolsController).configure(builder);

        expect(builder.paths).toEqual([]);
    });

    it('skips ONLY the local-only method, leaving its siblings routable', () => {
        RuntimeLocality.declare('deployed');
        const builder = new CollectingRouteBuilder();

        new ApiRoutingFactory(OpenApi, OpenController).configure(builder);

        expect(builder.paths).toEqual(['/open/ping']);
    });
});
