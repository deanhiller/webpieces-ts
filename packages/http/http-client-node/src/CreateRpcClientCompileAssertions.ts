/**
 * COMPILE-TIME assertions that `createRpcClient`'s filters argument is GENUINELY optional.
 *
 * The argument is `readonly ClientFilterDefinition[] | undefined`, so all three ways an app says
 * "here are this client's filters" compile: omit it, pass `[]`, or pass a mutable
 * `ClientFilterDefinition[]` that was declared empty and pushed to under `if`s. That last one is the
 * whole reason this file exists — it is how a real app builds a filter list once the list is not a
 * hardcoded literal, and a non-empty tuple parameter rejects it, because the declared type of a
 * conditionally-populated local cannot be non-empty. The cure would be a cast at every call site,
 * which is worse than the case the tuple was protecting against.
 *
 * WHY THIS FILE AND NOT A SPEC. `tsconfig.lib.json` EXCLUDES `*.spec.ts`, and vitest strips types
 * with esbuild rather than checking them — so a type-level assertion in a spec is inert and the
 * suite passes whether or not the signature still admits these calls. Here it is compiled by the
 * build: if the signature is ever re-narrowed, tsc fails on the line below that stops compiling.
 * That failure IS the test. Mirrors `core-util/src/http/AuthJwtCompileAssertions.ts`.
 *
 * Nothing here runs. The class is never constructed and never exported from the barrel.
 */

import { Filter, Service } from '@webpieces/core-util';
import { ClientFilterDefinition, ClientRequest } from '@webpieces/http-client-core';
import { ClientConfig } from './ClientConfig';
import { ClientHttpFactory } from './ClientHttpFactory';
import { ContextBaseUrlFilter } from './ContextBaseUrlFilter';

/** Stand-in for a real contract; only its TYPE is used, and only by tsc. */
declare const someApi: Parameters<ClientHttpFactory['createRpcClient']>[0];
declare const factory: ClientHttpFactory;
declare const perTenant: boolean;
declare const verbose: boolean;

/** A second app filter, so the conditional-build case below has two branches like a real one. */
class OutboundLogFilter extends Filter<ClientRequest, Response> {
    override filter(request: ClientRequest, next: Service<ClientRequest, Response>): Promise<Response> {
        return next.invoke(request);
    }
}

class CreateRpcClientCompileAssertions {
    /** No app filters, said by omitting the argument. */
    noFilters(): void {
        factory.createRpcClient(someApi, new ClientConfig('server2'));
    }

    /** No app filters, said with an empty array — the same thing, normalized to the same value. */
    emptyArray(): void {
        factory.createRpcClient(someApi, new ClientConfig('server2'), []);
    }

    /** One app filter. */
    oneFilter(): void {
        factory.createRpcClient(someApi, new ClientConfig('partner-webhooks'), [
            new ClientFilterDefinition(1000, new ContextBaseUrlFilter()),
        ]);
    }

    /** Several app filters. */
    severalFilters(): void {
        factory.createRpcClient(someApi, new ClientConfig('partner-webhooks'), [
            new ClientFilterDefinition(1000, new ContextBaseUrlFilter()),
            new ClientFilterDefinition(500, new ContextBaseUrlFilter()),
        ]);
    }

    /**
     * THE CASE THIS CHANGE EXISTS FOR: a MUTABLE `ClientFilterDefinition[]`, declared empty and
     * pushed to conditionally. Its declared type is not, and cannot be, non-empty; a mutable array
     * is assignable to the `readonly` parameter, so this compiles with no cast.
     */
    conditionallyBuiltList(): void {
        const filters: ClientFilterDefinition[] = [];
        if (perTenant) filters.push(new ClientFilterDefinition(1000, new ContextBaseUrlFilter()));
        if (verbose) filters.push(new ClientFilterDefinition(500, new OutboundLogFilter()));
        factory.createRpcClient(someApi, new ClientConfig('partner-webhooks'), filters);
    }
}

void CreateRpcClientCompileAssertions;
