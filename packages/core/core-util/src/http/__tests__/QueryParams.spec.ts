import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
    ApiPath,
    Endpoint,
    EXTERNAL_OUTBOUND,
    GET,
    PathParam,
    QueryParam,
    QueryString,
    READ,
    RPC,
    WpAuthPublic,
} from '../decorators';
import { AuthorizationType, WpAuthorization } from '../authorization';
import { ApiBadRequestError } from '../../errors/ApiError';
import { HttpContractMapper } from '../HttpContract';
import { QueryParams } from '../QueryParams';
import { RouteMetadataFactory } from '../RouteMetadataFactory';

@ApiPath('/v3')
abstract class VendorItemsApi {
    @WpAuthPublic('Query fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Query fixture' })
    @Endpoint(GET, '/merchants/{mId}/items', READ, EXTERNAL_OUTBOUND)
    items(@PathParam('mId') _mId: string, @QueryString() _query: QueryParams): Promise<object> {
        throw new Error('contract');
    }
}

@ApiPath('/ours')
abstract class OursWithQueryStringApi {
    @WpAuthPublic('Query fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Query fixture' })
    @Endpoint(GET, '/x', READ, RPC)
    x(@QueryString() _query: QueryParams): Promise<object> {
        throw new Error('contract');
    }
}

@ApiPath('/typed')
abstract class TypedListApi {
    @WpAuthPublic('Query fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Query fixture' })
    @Endpoint(GET, '/ids', READ, RPC)
    ids(@QueryParam('id', Number) _ids?: number[], @QueryParam('flag', Boolean) _flags?: boolean[]): Promise<object> {
        throw new Error('contract');
    }

    @WpAuthPublic('Query fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Query fixture' })
    @Endpoint(GET, '/one', READ, RPC)
    one(@QueryParam('id', Number) _id?: number): Promise<object> {
        throw new Error('contract');
    }
}

describe('QueryParams — a free-form query multimap', () => {
    it('adds repeated keys, sets single ones, and reads them back typed', () => {
        const query = new QueryParams().add('filter', 'a').add('filter', 'b').set('limit', 100).set('hidden', false);
        expect(query.keys()).toEqual(['filter', 'limit', 'hidden']);
        expect(query.getAll('filter')).toEqual(['a', 'b']);
        expect(query.getNumber('limit')).toBe(100);
        expect(query.getBoolean('hidden')).toBe(false);
        expect(query.getSingle('missing')).toBeUndefined();
        expect(query.set('filter', 'c').getAll('filter')).toEqual(['c']);
    });

    it('getSingle on a repeated key, and a non-numeric getNumber, are a 400', () => {
        const query = new QueryParams().add('filter', 'a').add('filter', 'b').set('limit', 'ten');
        expect(() => query.getSingle('filter')).toThrow(ApiBadRequestError);
        expect(() => query.getSingle('filter')).toThrow("Query parameter 'filter' was repeated but a single value is expected.");
        expect(() => query.getNumber('limit')).toThrow("Query parameter 'limit' must be a number.");
        expect(() => new QueryParams().set('b', 'yes').getBoolean('b')).toThrow("Query parameter 'b' must be 'true' or 'false'.");
    });

    it('@QueryString() maps the whole multimap to repeated keys, and back', () => {
        const route = RouteMetadataFactory.create(VendorItemsApi, 'items');
        const query = new QueryParams().add('filter', 'name=x').add('filter', 'price>2').set('limit', 100);
        const wire = HttpContractMapper.toWire(route.path, route.parameterBindings, route.bodyParameterIndex, ['m 1', query]);
        expect(wire.path).toBe('/v3/merchants/m%201/items?filter=name%3Dx&filter=price%3E2&limit=100');

        const args = HttpContractMapper.fromWire(
            route.parameterBindings,
            route.bodyParameterIndex,
            undefined,
            new Map([['mId', 'm 1']]),
            new Map<string, string | readonly string[]>([['filter', ['name=x', 'price>2']], ['limit', '100']]),
        );
        expect(args[0]).toBe('m 1');
        expect((args[1] as QueryParams).getAll('filter')).toEqual(['name=x', 'price>2']);
        expect((args[1] as QueryParams).getNumber('limit')).toBe(100);
    });

    it('refuses @QueryString() on a contract this repo serves', () => {
        expect(() => RouteMetadataFactory.create(OursWithQueryStringApi, 'x')).toThrow(
            'OursWithQueryStringApi.x declares @QueryString(), which only an EXTERNAL_OUTBOUND contract may use',
        );
    });
});

describe('typed list query items (`@QueryParam(name, Number)`)', () => {
    it('converts number[] and boolean[] items instead of leaving them strings', () => {
        const route = RouteMetadataFactory.create(TypedListApi, 'ids');
        const args = HttpContractMapper.fromWire(
            route.parameterBindings,
            route.bodyParameterIndex,
            undefined,
            new Map(),
            new Map<string, string | readonly string[]>([['id', ['1', '22']], ['flag', ['true', 'false']]]),
        );
        expect(args).toEqual([[1, 22], [true, false]]);
    });

    it('a non-numeric item is a 400', () => {
        const route = RouteMetadataFactory.create(TypedListApi, 'ids');
        expect(() =>
            HttpContractMapper.fromWire(
                route.parameterBindings,
                route.bodyParameterIndex,
                undefined,
                new Map(),
                new Map<string, string | readonly string[]>([['id', ['1', 'two']]]),
            ),
        ).toThrow("Parameter 'id' must be a number.");
    });

    it('an item type on a scalar parameter is refused', () => {
        expect(() => RouteMetadataFactory.create(TypedListApi, 'one')).toThrow(
            "TypedListApi.one @QueryParam('id', Number) names an item type, but argument 0 is not a list.",
        );
    });
});
