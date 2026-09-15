import 'reflect-metadata';
import { HttpParameterDeclaration, HttpParameterSource } from './HttpContract';

export const HTTP_PARAMETERS_METADATA_KEY = 'webpieces:http-parameters';

/** Shared implementation for explicit method-parameter wire mappings. */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
function defineHttpParameter(source: HttpParameterSource, wireName: string): ParameterDecorator {
    if (typeof wireName !== 'string' || wireName.trim() === '') {
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
        declarations.push(new HttpParameterDeclaration(parameterIndex, source, wireName));
        all[propertyKey as string] = declarations;
        Reflect.defineMetadata(HTTP_PARAMETERS_METADATA_KEY, all, metadataTarget);
    };
}

/** Map one method argument to a `{placeholder}` in `@ApiPath + @Endpoint`. */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function PathParam(wireName: string): ParameterDecorator {
    return defineHttpParameter('path', wireName);
}

/** Map one method argument to an explicitly named query key. */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function QueryParam(wireName: string): ParameterDecorator {
    return defineHttpParameter('query', wireName);
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
