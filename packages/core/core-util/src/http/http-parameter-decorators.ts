import 'reflect-metadata';
import { HttpParameterDeclaration, HttpParameterSource, HttpQueryItemType } from './HttpContract';

export const HTTP_PARAMETERS_METADATA_KEY = 'webpieces:http-parameters';

/** Shared implementation for explicit method-parameter wire mappings. */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
function defineHttpParameter(
    source: HttpParameterSource,
    wireName: string,
    itemType?: HttpQueryItemType,
): ParameterDecorator {
    if (source !== 'query-map' && (typeof wireName !== 'string' || wireName.trim() === '')) {
        throw new Error(
            `@${source === 'path' ? 'PathParam' : 'QueryParam'} requires a non-empty wire name.`,
        );
    }
    return (
        // webpieces-disable no-any-unknown -- reflect-metadata parameter decorator API requires any
        target: any,
        propertyKey: string | symbol | undefined,
        parameterIndex: number,
    ): void => {
        if (propertyKey === undefined) {
            throw new Error('HTTP parameter decorators are method-only.');
        }
        const metadataTarget = typeof target === 'function' ? target : target.constructor;
        const all: Record<string, HttpParameterDeclaration[]> =
            Reflect.getMetadata(HTTP_PARAMETERS_METADATA_KEY, metadataTarget) || {};
        const declarations = [...(all[propertyKey as string] ?? [])];
        if (
            declarations.some(
                (declaration: HttpParameterDeclaration) => declaration.index === parameterIndex,
            )
        ) {
            throw new Error(
                `Argument ${parameterIndex} of ${metadataTarget.name}.${String(propertyKey)} already has an HTTP parameter decorator.`,
            );
        }
        if (source === 'query-map' && declarations.some((declaration: HttpParameterDeclaration) => declaration.source === 'query-map')) {
            throw new Error(
                `${metadataTarget.name}.${String(propertyKey)} declares @QueryString() more than once; one QueryParams holds the whole query string.`,
            );
        }
        declarations.push(new HttpParameterDeclaration(parameterIndex, source, wireName, itemType));
        all[propertyKey as string] = declarations;
        Reflect.defineMetadata(HTTP_PARAMETERS_METADATA_KEY, all, metadataTarget);
    };
}

/** Map one method argument to a `{placeholder}` in `@ApiPath + @Endpoint`. */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function PathParam(wireName: string): ParameterDecorator {
    return defineHttpParameter('path', wireName);
}

/**
 * Map one method argument to an explicitly named query key. A LIST argument may name its item type,
 * `@QueryParam('ids', Number) ids: number[]`, because design metadata erases `number[]` to `Array`;
 * without it the items arrive as strings.
 */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function QueryParam(wireName: string, itemType?: HttpQueryItemType): ParameterDecorator {
    return defineHttpParameter('query', wireName, itemType);
}

/**
 * Map one `QueryParams` argument to the WHOLE query string — a free-form multimap:
 * `@QueryString() query: QueryParams`. Allowed ONLY on an `EXTERNAL_OUTBOUND` contract (a vendor's
 * query grammar is the vendor's); our own contracts use the typed {@link QueryParam}. At most one per
 * method.
 *
 * Named `QueryString` rather than `QueryParams` because the argument's CLASS is `QueryParams`, and one
 * module surface cannot export a decorator function and a class under the same name.
 */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function QueryString(): ParameterDecorator {
    return defineHttpParameter('query-map', '');
}

/** Explicit path/query mappings for one endpoint, independent of JavaScript parameter names. */
// webpieces-disable no-function-outside-class -- reflect-metadata reader
export function getHttpParameterDeclarations(
    apiClass: Function,
    methodName: string,
): HttpParameterDeclaration[] {
    const all: Record<string, HttpParameterDeclaration[]> =
        Reflect.getMetadata(HTTP_PARAMETERS_METADATA_KEY, apiClass) || {};
    return [...(all[methodName] ?? [])];
}
