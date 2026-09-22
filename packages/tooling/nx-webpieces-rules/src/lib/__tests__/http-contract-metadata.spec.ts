import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import {
    DecoratorArgDiagnostics,
    endpointMethodsOf,
    stringConstantsOf,
} from '../api-usage/api-ast';
import type { ApiMethodMeta } from '../api-usage/api-relations';

function scan(source: string): ApiMethodMeta {
    const file = ts.createSourceFile(
        '/ws/libraries/widget-api/src/index.ts',
        source,
        ts.ScriptTarget.Latest,
        true,
    );
    let found: ts.ClassDeclaration | undefined;
    const walk = (node: ts.Node): void => {
        if (found === undefined && ts.isClassDeclaration(node)) found = node;
        ts.forEachChild(node, walk);
    };
    walk(file);
    return endpointMethodsOf(
        found!,
        'WidgetApi',
        stringConstantsOf(file),
        new DecoratorArgDiagnostics('/ws'),
    )[0];
}

describe('architecture HTTP contract metadata', () => {
    it('emits the real verb, explicit wire names/indexes, and full-response ownership', () => {
        const method = scan(`
@ApiPath('/widgets')
abstract class WidgetApi {
    @Endpoint(GET, '/{owner}/{id}', READ, RPC, { responseType: 'full' })
    abstract get(
        @PathParam('owner') owner: string,
        @PathParam('id') id: number,
        @QueryParam('include_archived') archived?: boolean,
    ): Promise<HttpResponseDto<Widget>>;
}`);

        expect(method).toEqual({
            name: 'get',
            path: '/{owner}/{id}',
            kind: 'rpc',
            operation: 'read',
            httpMethod: 'GET',
            responseType: 'full',
            parameters: [
                { index: 0, source: 'path', wireName: 'owner' },
                { index: 1, source: 'path', wireName: 'id' },
                { index: 2, source: 'query', wireName: 'include_archived' },
            ],
        });
    });

    it('emits an explicitly declared POST in generated output', () => {
        const method = scan(`
@ApiPath('/widgets')
abstract class WidgetApi {
    @Endpoint(POST, '/save', WRITE, RPC)
    abstract save(request: SaveRequest): Promise<SaveResponse>;
}`);

        expect(method.httpMethod).toBe('POST');
        expect(method.parameters).toEqual([{ index: 0, source: 'body' }]);
        expect(method.responseType).toBeUndefined();
    });
});
