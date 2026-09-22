import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { ApiPath, Endpoint, WpAuthPublic, POST, RPC, WRITE } from '@webpieces/core-util';
import { ApiRoutingFactory } from '../ApiRoutingFactory';
import { FilterDefinition, RouteBuilder, RouteDefinition } from '../WebAppMeta';

/**
 * Server-side half of #944's duplicate-route rule: empty paths stay legal, but two endpoints of one
 * contract on the same HTTP method + path die at startup instead of one silently shadowing the other
 * in the route map.
 */

@ApiPath('')
abstract class EmptyPathApi {
    @WpAuthPublic('Test fixture')
    @Endpoint(POST, '', WRITE, RPC)
    deliver(_r: object): Promise<object> {
        throw new Error('subclass');
    }
}

class EmptyPathController extends EmptyPathApi {
    override async deliver(_r: object): Promise<object> {
        return {};
    }
}

@ApiPath('/hooks')
abstract class DuplicateApi {
    @WpAuthPublic('Test fixture')
    @Endpoint(POST, '/in', WRITE, RPC)
    first(_r: object): Promise<object> {
        throw new Error('subclass');
    }

    @WpAuthPublic('Test fixture')
    @Endpoint(POST, 'in', WRITE, RPC)
    second(_r: object): Promise<object> {
        throw new Error('subclass');
    }
}

class DuplicateController extends DuplicateApi {
    override async first(_r: object): Promise<object> {
        return {};
    }

    override async second(_r: object): Promise<object> {
        return {};
    }
}

class CollectingRouteBuilder implements RouteBuilder {
    readonly paths: string[] = [];

    addRoute(route: RouteDefinition): void {
        this.paths.push(route.routeMeta.path);
    }

    addFilter(_filter: FilterDefinition): void {
        // no filters in these tests
    }
}

describe('ApiRoutingFactory route validation (#944)', () => {
    it("registers an empty-path contract with path ''", () => {
        const builder = new CollectingRouteBuilder();

        new ApiRoutingFactory(EmptyPathApi, EmptyPathController).configure(builder);

        expect(builder.paths).toEqual(['']);
    });

    it('refuses two endpoints on one HTTP method + path, naming both, and registers nothing', () => {
        const builder = new CollectingRouteBuilder();

        expect(() =>
            new ApiRoutingFactory(DuplicateApi, DuplicateController).configure(builder),
        ).toThrow(
            /DuplicateApi\.first and DuplicateApi\.second both resolve to POST '\/hooks\/in'/,
        );
        expect(builder.paths).toEqual([]);
    });
});
