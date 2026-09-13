import 'reflect-metadata';
import { BadRequestError, InternalError } from '../errors';
import { getMaskSpec, METADATA_KEYS } from '../http/decorators';
import { MaskSpec } from '../http/LogFieldMask';
import { IpcIdentity } from './IpcIdentity';

export type IpcEndpointKind = 'request' | 'notification';
export interface IpcEndpointOptions {
    kind?: IpcEndpointKind;
}
export type IpcApiType<T> = abstract new (...args: never[]) => T;

export const IPC_METADATA_KEYS = {
    API_ID: 'webpieces:ipc-api-id',
    ENDPOINTS: 'webpieces:ipc-endpoints',
    KINDS: 'webpieces:ipc-kinds',
} as const;

/** Marks a contract as IPC-only. HTTP routers and clients must reject it. */
// webpieces-disable no-function-outside-class -- IPC decorator or immutable reflection metadata helper
export function WpInternal(apiId: string): ClassDecorator {
    IpcIdentity.assert(apiId, 'API');
    return (target: Function) => {
        const className = target.name || 'Unknown';
        if (
            Reflect.hasMetadata(METADATA_KEYS.API_PATH, target) ||
            Reflect.hasMetadata(METADATA_KEYS.ENDPOINTS, target)
        ) {
            throw new InternalError(`Internal API ${className} cannot use @ApiPath or @Endpoint.`);
        }
        const authMethods: string[] = Reflect.getMetadata(METADATA_KEYS.AUTH_METHODS, target) || [];
        if (authMethods.length > 0 || Reflect.hasMetadata(METADATA_KEYS.AUTH_META, target)) {
            throw new InternalError(
                `Internal API ${className} cannot use HTTP authorization decorators.`,
            );
        }
        Reflect.defineMetadata(IPC_METADATA_KEYS.API_ID, apiId, target);
    };
}

/** Declares the stable wire method ID for one method on an IPC-only contract. */
// webpieces-disable no-function-outside-class -- IPC decorator or immutable reflection metadata helper
export function WpIpcEndpoint(methodId: string, options: IpcEndpointOptions = {}): MethodDecorator {
    IpcIdentity.assert(methodId, 'method');
    const kind = options.kind ?? 'request';
    if (kind !== 'request' && kind !== 'notification')
        throw new BadRequestError('Invalid IPC endpoint kind');
    return (target: object, propertyKey: string | symbol) => {
        const apiClass = target.constructor;
        const key = propertyKey as string;
        if (['then', 'constructor', '__proto__'].includes(key)) {
            throw new BadRequestError(`Invalid IPC method name: ${key}`);
        }
        const endpoints: Record<string, string> =
            Reflect.getMetadata(IPC_METADATA_KEYS.ENDPOINTS, apiClass) || {};
        if (Object.values(endpoints).includes(methodId)) {
            throw new BadRequestError(`Duplicate IPC method identity: ${methodId}`);
        }
        endpoints[key] = methodId;
        Reflect.defineMetadata(IPC_METADATA_KEYS.ENDPOINTS, endpoints, apiClass);
        const kinds: Record<string, IpcEndpointKind> =
            Reflect.getMetadata(IPC_METADATA_KEYS.KINDS, apiClass) || {};
        kinds[key] = kind;
        Reflect.defineMetadata(IPC_METADATA_KEYS.KINDS, kinds, apiClass);
    };
}

// webpieces-disable no-function-outside-class -- IPC decorator or immutable reflection metadata helper
export function isInternalApi(apiClass: Function): boolean {
    return Reflect.hasMetadata(IPC_METADATA_KEYS.API_ID, apiClass);
}

// webpieces-disable no-function-outside-class -- IPC decorator or immutable reflection metadata helper
export function getIpcApiId(apiClass: Function): string | undefined {
    return Reflect.getMetadata(IPC_METADATA_KEYS.API_ID, apiClass);
}

// webpieces-disable no-function-outside-class -- IPC decorator or immutable reflection metadata helper
export function getIpcEndpoints(apiClass: Function): Readonly<Record<string, string>> {
    return Reflect.getMetadata(IPC_METADATA_KEYS.ENDPOINTS, apiClass) || {};
}

// webpieces-disable no-function-outside-class -- IPC decorator or immutable reflection metadata helper
export function getIpcEndpointKind(apiClass: Function, methodName: string): IpcEndpointKind {
    const kinds: Record<string, IpcEndpointKind> =
        Reflect.getMetadata(IPC_METADATA_KEYS.KINDS, apiClass) || {};
    return kinds[methodName] ?? 'request';
}

// webpieces-disable no-function-outside-class -- IPC decorator or immutable reflection metadata helper
export function getIpcMaskSpec(apiClass: Function, methodName: string): MaskSpec | undefined {
    return getMaskSpec(apiClass, methodName);
}

// webpieces-disable no-function-outside-class -- IPC decorator or immutable reflection metadata helper
export function assertInternalApi(apiClass: Function): string {
    const apiId = getIpcApiId(apiClass);
    if (!apiId)
        throw new InternalError(
            `Class ${apiClass.name || 'Unknown'} must be decorated with @WpInternal(apiId).`,
        );
    if (
        Reflect.hasMetadata(METADATA_KEYS.API_PATH, apiClass) ||
        Reflect.hasMetadata(METADATA_KEYS.ENDPOINTS, apiClass)
    ) {
        throw new InternalError(
            `Internal API ${apiClass.name || 'Unknown'} cannot use @ApiPath or @Endpoint.`,
        );
    }
    if (Object.keys(getIpcEndpoints(apiClass)).length === 0) {
        throw new InternalError(
            `Internal API ${apiClass.name || 'Unknown'} must declare at least one @WpIpcEndpoint.`,
        );
    }
    return apiId;
}

// webpieces-disable no-function-outside-class -- IPC decorator or immutable reflection metadata helper
export function assertNotInternalApi(apiClass: Function, transport: string): void {
    if (isInternalApi(apiClass)) {
        throw new InternalError(
            `${transport} cannot use @WpInternal API ${apiClass.name || 'Unknown'}; use the IPC factories.`,
        );
    }
}
