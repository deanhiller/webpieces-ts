import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ApiPath, Endpoint, PathParam, QueryParam, WpAuthPublic } from '../decorators';
import { HttpContractMapper, HttpParameterBinding } from '../HttpContract';
import { RouteMetadataFactory } from '../RouteMetadataFactory';

@ApiPath('/widgets/')
abstract class WidgetApi {
    @WpAuthPublic('Public catalog lookup')
    @Endpoint('/{ownerId}/{widgetId}', 'rpc', { httpMethod: 'GET' })
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    get(
        @PathParam('ownerId') _ownerId: string,
        @PathParam('widgetId') _widgetId: number,
        @QueryParam('include_archived') _includeArchived?: boolean,
        @QueryParam('tag') _tags?: string[],
    ): Promise<object> {
        throw new Error('contract only');
    }
}

@ApiPath('/widgets')
abstract class UpdateApi {
    @WpAuthPublic('Test update')
    @Endpoint('/{id}', 'rpc')
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    update(@PathParam('id') _id: number, _body: object): Promise<object> {
        throw new Error('contract only');
    }
}

describe('typed HTTP contract metadata and mapping', () => {
    it('joins paths, records GET, converts declared types, and has no GET body', () => {
        const route = RouteMetadataFactory.create(WidgetApi, 'get');

        expect(route.httpMethod).toBe('GET');
        expect(route.path).toBe('/widgets/{ownerId}/{widgetId}');
        expect(route.bodyParameterIndex).toBeUndefined();
        expect(
            route.parameterBindings.map((binding: HttpParameterBinding) => [
                binding.index,
                binding.source,
                binding.wireName,
                binding.valueType,
            ]),
        ).toEqual([
            [0, 'path', 'ownerId', 'string'],
            [1, 'path', 'widgetId', 'number'],
            [2, 'query', 'include_archived', 'boolean'],
            [3, 'query', 'tag', 'array'],
        ]);
    });

    it('encodes reserved/Unicode path values, renames query keys, omits undefined, and repeats arrays', () => {
        const route = RouteMetadataFactory.create(WidgetApi, 'get');
        const request = HttpContractMapper.toWire(
            route.path,
            route.parameterBindings,
            route.bodyParameterIndex,
            ['Jöhn / team', 42, undefined, ['red & blue', '✓']],
        );

        expect(request.path).toBe(
            '/widgets/J%C3%B6hn%20%2F%20team/42?tag=red%20%26%20blue&tag=%E2%9C%93',
        );
        expect(request.body).toBeUndefined();
    });

    it('binds decoded incoming strings to string/number/boolean/list API arguments', () => {
        const route = RouteMetadataFactory.create(WidgetApi, 'get');
        const args = HttpContractMapper.fromWire(
            route.parameterBindings,
            route.bodyParameterIndex,
            undefined,
            new Map([
                ['ownerId', 'Jöhn / team'],
                ['widgetId', '42'],
            ]),
            new Map([
                ['include_archived', 'true'],
                ['tag', ['red & blue', '✓']],
            ]),
        );

        expect(args).toEqual(['Jöhn / team', 42, true, ['red & blue', '✓']]);
    });

    it('keeps one unannotated POST parameter as the request body', () => {
        const route = RouteMetadataFactory.create(UpdateApi, 'update');
        const body = { name: 'updated' };
        const request = HttpContractMapper.toWire(
            route.path,
            route.parameterBindings,
            route.bodyParameterIndex,
            [17, body],
        );

        expect(route.httpMethod).toBe('POST');
        expect(route.bodyParameterIndex).toBe(1);
        expect(request.path).toBe('/widgets/17');
        expect(request.body).toBe(body);
    });

    it('rejects missing and malformed path/query values as caller errors', () => {
        const route = RouteMetadataFactory.create(WidgetApi, 'get');
        expect(() =>
            HttpContractMapper.toWire(
                route.path,
                route.parameterBindings,
                route.bodyParameterIndex,
                [undefined, 42],
            ),
        ).toThrow(/Missing path parameter 'ownerId'/);
        expect(() =>
            HttpContractMapper.fromWire(
                route.parameterBindings,
                route.bodyParameterIndex,
                undefined,
                new Map([
                    ['ownerId', 'x'],
                    ['widgetId', 'not-a-number'],
                ]),
                new Map(),
            ),
        ).toThrow(/widgetId.*number/);
    });
});

describe('contract mapping validation', () => {
    it('rejects a GET parameter with no explicit mapping', () => {
        @ApiPath('/broken')
        class BrokenApi {
            @WpAuthPublic('Test fixture')
            @Endpoint('/get', 'rpc', { httpMethod: 'GET' })
            get(_value: string): Promise<object> {
                return Promise.resolve({});
            }
        }

        expect(() => RouteMetadataFactory.create(BrokenApi, 'get')).toThrow(
            /every parameter must use @PathParam.*@QueryParam/,
        );
    });

    it('rejects missing/conflicting placeholder and query mappings at wiring time', () => {
        @ApiPath('/broken')
        class BrokenPathApi {
            @WpAuthPublic('Test fixture')
            @Endpoint('/{id}', 'rpc', { httpMethod: 'GET' })
            get(@QueryParam('id') _id: string): Promise<object> {
                return Promise.resolve({});
            }
        }

        @ApiPath('/broken')
        class DuplicateQueryApi {
            @WpAuthPublic('Test fixture')
            @Endpoint('/get', 'rpc', { httpMethod: 'GET' })
            get(@QueryParam('q') _one: string, @QueryParam('q') _two: string): Promise<object> {
                return Promise.resolve({});
            }
        }

        expect(() => RouteMetadataFactory.create(BrokenPathApi, 'get')).toThrow(
            /contains \{id\} but no @PathParam/,
        );
        expect(() => RouteMetadataFactory.create(DuplicateQueryApi, 'get')).toThrow(
            /maps 'query:q' more than once/,
        );
    });
});
