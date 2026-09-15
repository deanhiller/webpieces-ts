import {
    getApiPath,
    getAuthMeta,
    getEndpointOptions,
    getEndpoints,
    getMaskSpec,
} from './decorators';
import { getHttpParameterDeclarations } from './http-parameter-decorators';
import {
    ContractHttpMethod,
    EndpointResponseType,
    HttpParameterBinding,
    HttpParameterDeclaration,
    HttpParameterValueType,
} from './HttpContract';
import { RouteMetadata } from './RouteMetadata';

/**
 * Build the one runtime route model consumed by incoming routing, in-process clients, and both
 * generated HTTP clients. Keeping this join/validation here prevents four subtly different
 * interpretations of the same decorators.
 */
export class RouteMetadataFactory {
    // webpieces-disable no-function-outside-class -- deterministic decorator metadata factory shared by DI-free browser and server runtimes
    static create(
        apiClass: Function,
        methodName: string,
        controllerClassName?: string,
    ): RouteMetadata {
        const endpoints = getEndpoints(apiClass) ?? {};
        const endpointPath = endpoints[methodName];
        if (endpointPath === undefined) {
            throw new Error(
                `No @Endpoint metadata for ${apiClass.name || 'Unknown'}.${methodName}.`,
            );
        }
        const fullPath = this.joinPath(getApiPath(apiClass) ?? '', endpointPath);
        const options = getEndpointOptions(apiClass, methodName);
        const httpMethod = this.httpMethod(options.httpMethod, apiClass, methodName);
        if (httpMethod === 'GET' && options.formPost === true) {
            throw new Error(
                `${apiClass.name}.${methodName} is GET and cannot declare formPost:true because GET has no request body.`,
            );
        }
        if (httpMethod === 'GET' && options.rawBody === true) {
            throw new Error(
                `${apiClass.name}.${methodName} is GET and cannot declare rawBody:true because GET has no request body.`,
            );
        }

        const parameterTypes = this.parameterTypes(apiClass, methodName);
        const declarations = getHttpParameterDeclarations(apiClass, methodName);
        const bodyParameterIndex = this.validateParameters(
            apiClass,
            methodName,
            fullPath,
            httpMethod,
            parameterTypes,
            declarations,
        );
        const bindings = declarations
            .map(
                (declaration: HttpParameterDeclaration) =>
                    new HttpParameterBinding(
                        declaration.index,
                        declaration.source,
                        declaration.wireName,
                        this.valueType(parameterTypes[declaration.index]),
                    ),
            )
            .sort((a: HttpParameterBinding, b: HttpParameterBinding) => a.index - b.index);

        return new RouteMetadata(
            httpMethod,
            fullPath,
            methodName,
            controllerClassName,
            getAuthMeta(apiClass, methodName),
            apiClass.name || 'UnknownApi',
            options.formPost === true,
            getMaskSpec(apiClass, methodName),
            options.rawBody === true,
            bindings,
            bodyParameterIndex,
            this.responseType(options.responseType, apiClass, methodName),
        );
    }

    // webpieces-disable no-function-outside-class -- private pure helper for the static metadata factory
    private static joinPath(basePath: string, endpointPath: string): string {
        const joined = `${basePath}/${endpointPath}`.replace(/\/{2,}/g, '/');
        return joined.startsWith('/') ? joined : `/${joined}`;
    }

    // webpieces-disable no-function-outside-class -- private pure helper for the static metadata factory
    private static httpMethod(
        value: ContractHttpMethod | undefined,
        apiClass: Function,
        methodName: string,
    ): ContractHttpMethod {
        const method = value ?? 'POST';
        if (method === 'GET' || method === 'POST') return method;
        throw new Error(
            `${apiClass.name}.${methodName} declares unsupported httpMethod '${String(method)}'; use GET or POST.`,
        );
    }

    // webpieces-disable no-function-outside-class -- private pure helper for the static metadata factory
    private static responseType(
        value: EndpointResponseType | undefined,
        apiClass: Function,
        methodName: string,
    ): EndpointResponseType {
        const responseType = value ?? 'body';
        if (responseType === 'body' || responseType === 'full') return responseType;
        throw new Error(
            `${apiClass.name}.${methodName} declares unsupported responseType '${String(responseType)}'; use body or full.`,
        );
    }

    // webpieces-disable no-function-outside-class -- Reflect metadata lookup has no injectable dependency
    private static parameterTypes(apiClass: Function, methodName: string): Function[] {
        return Reflect.getMetadata('design:paramtypes', apiClass.prototype, methodName) ?? [];
    }

    // webpieces-disable no-function-outside-class -- private deterministic contract validation helper
    private static validateParameters(
        apiClass: Function,
        methodName: string,
        fullPath: string,
        httpMethod: ContractHttpMethod,
        parameterTypes: readonly Function[],
        declarations: readonly HttpParameterDeclaration[],
    ): number | undefined {
        const label = `${apiClass.name || 'Unknown'}.${methodName}`;
        const placeholders = [...fullPath.matchAll(/\{([^{}]+)\}/g)].map(
            (match: RegExpMatchArray) => match[1],
        );
        const pathNames = declarations
            .filter((declaration: HttpParameterDeclaration) => declaration.source === 'path')
            .map((declaration: HttpParameterDeclaration) => declaration.wireName);
        for (const placeholder of new Set(placeholders)) {
            if (!pathNames.includes(placeholder)) {
                throw new Error(
                    `${label} path '${fullPath}' contains {${placeholder}} but no @PathParam('${placeholder}') parameter.`,
                );
            }
        }
        for (const pathName of pathNames) {
            if (!placeholders.includes(pathName)) {
                throw new Error(
                    `${label} declares @PathParam('${pathName}') but '${fullPath}' has no {${pathName}} placeholder.`,
                );
            }
        }

        const seenWire = new Set<string>();
        const mappedIndexes = new Set<number>();
        for (const declaration of declarations) {
            const wireKey = `${declaration.source}:${declaration.wireName}`;
            if (seenWire.has(wireKey)) {
                throw new Error(`${label} maps '${wireKey}' more than once.`);
            }
            seenWire.add(wireKey);
            mappedIndexes.add(declaration.index);
        }

        const declaredCount = Math.max(
            parameterTypes.length,
            declarations.reduce(
                (highest: number, declaration: HttpParameterDeclaration) =>
                    Math.max(highest, declaration.index + 1),
                0,
            ),
        );
        const unbound: number[] = [];
        for (let index = 0; index < declaredCount; index++) {
            if (!mappedIndexes.has(index)) unbound.push(index);
        }
        if (httpMethod === 'GET' && unbound.length > 0) {
            throw new Error(
                `${label} is GET, so every parameter must use @PathParam(...) or @QueryParam(...); argument ${unbound[0]} is unmapped.`,
            );
        }
        if (unbound.length > 1) {
            throw new Error(
                `${label} has ${unbound.length} unmapped parameters. POST permits exactly one unannotated request body; map every other parameter explicitly.`,
            );
        }
        return unbound[0];
    }

    // webpieces-disable no-function-outside-class -- private conversion of reflected constructors to wire types
    private static valueType(type: Function | undefined): HttpParameterValueType {
        if (type === String) return 'string';
        if (type === Number) return 'number';
        if (type === Boolean) return 'boolean';
        if (type === Array) return 'array';
        return 'unknown';
    }
}
