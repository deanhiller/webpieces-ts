import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
    ApiPath,
    Endpoint,
    PathParam,
    WpAuthPublic,
    GET,
    POST,
    READ,
    RPC,
    WRITE,
} from '../decorators';
import { HttpContractMapper } from '../HttpContract';
import { RouteMetadataFactory } from '../RouteMetadataFactory';

class Body {
    constructor(public readonly id: string = 'e1') {}
}

@ApiPath('')
abstract class WholeUrlApi {
    @WpAuthPublic('Test fixture')
    @Endpoint(POST, '', WRITE, RPC)
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    deliver(_body: Body): Promise<object> {
        throw new Error('contract only');
    }
}

@ApiPath('')
abstract class HalfEmptyApi {
    @WpAuthPublic('Test fixture')
    @Endpoint(POST, 'deliver', WRITE, RPC)
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    deliver(_body: Body): Promise<object> {
        throw new Error('contract only');
    }
}

@ApiPath('')
abstract class TwoMethodsApi {
    @WpAuthPublic('Test fixture')
    @Endpoint(GET, '', READ, RPC)
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    read(): Promise<object> {
        throw new Error('contract only');
    }

    @WpAuthPublic('Test fixture')
    @Endpoint(POST, '', WRITE, RPC)
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    write(_body: Body): Promise<object> {
        throw new Error('contract only');
    }
}

@ApiPath('')
abstract class DuplicateApi {
    @WpAuthPublic('Test fixture')
    @Endpoint(POST, '', WRITE, RPC)
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    first(_body: Body): Promise<object> {
        throw new Error('contract only');
    }

    @WpAuthPublic('Test fixture')
    @Endpoint(POST, '/', WRITE, RPC)
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    second(_body: Body): Promise<object> {
        throw new Error('contract only');
    }
}

@ApiPath('/items')
abstract class PlaceholderApi {
    @WpAuthPublic('Test fixture')
    @Endpoint(GET, '/{id}', READ, RPC)
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    byId(@PathParam('id') _id: string): Promise<object> {
        throw new Error('contract only');
    }

    @WpAuthPublic('Test fixture')
    @Endpoint(GET, '/{key}', READ, RPC)
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    byKey(@PathParam('key') _key: string): Promise<object> {
        throw new Error('contract only');
    }
}

describe('joinPath: the #926 empty-path regression (#944)', () => {
    it("joins @ApiPath('') + @Endpoint(POST, '') to '' so a base URL is used byte for byte", () => {
        const route = RouteMetadataFactory.create(WholeUrlApi, 'deliver');
        // #926 produced '/', which appended a slash to every overridden base URL.
        expect(route.path).toBe('');

        const wire = HttpContractMapper.toWire(
            route.path,
            route.parameterBindings,
            route.bodyParameterIndex,
            [new Body()],
        );
        const base = 'https://hooks.partner.example/in/abc?token=xyz';
        expect(`${base}${wire.path}`).toBe(base);
    });

    it('still joins a single non-empty segment with exactly one leading separator', () => {
        expect(RouteMetadataFactory.create(HalfEmptyApi, 'deliver').path).toBe('/deliver');
    });
});

describe('RouteMetadataFactory.assertNoDuplicateRoutes (#944)', () => {
    it('accepts empty paths that differ by HTTP method', () => {
        expect(() => RouteMetadataFactory.assertNoDuplicateRoutes(TwoMethodsApi)).not.toThrow();
    });

    it("rejects two endpoints on one HTTP method + path, naming both ('' and '/' are one route)", () => {
        expect(() => RouteMetadataFactory.assertNoDuplicateRoutes(DuplicateApi)).toThrow(
            /DuplicateApi\.first and DuplicateApi\.second both resolve to POST '\/'/,
        );
    });

    it('treats placeholders with different names as the same route', () => {
        expect(() => RouteMetadataFactory.assertNoDuplicateRoutes(PlaceholderApi)).toThrow(
            /PlaceholderApi\.byId and PlaceholderApi\.byKey both resolve to GET '\/items\/\{key\}'/,
        );
    });

    it('accepts an ordinary contract', () => {
        expect(() => RouteMetadataFactory.assertNoDuplicateRoutes(HalfEmptyApi)).not.toThrow();
    });
});
