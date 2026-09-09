import { MaskSpec } from '../http/LogFieldMask';
import { BadRequestError } from '../errors';

/** A portable schema owns parsing and validation, including class reconstruction. */
export interface IpcSchema<T> {
    // webpieces-disable no-any-unknown -- untrusted IPC data is schema-validated; generic dispatch cannot assume a DTO type before validation
    parse(value: unknown): T;
}

/** Acknowledged void has an explicit null wire representation. */
export class IpcVoidSchema implements IpcSchema<void> {
    // webpieces-disable no-any-unknown -- untrusted IPC data is schema-validated; generic dispatch cannot assume a DTO type before validation
    parse(value: unknown): void {
        if (value !== null && value !== undefined) {
            throw new BadRequestError('Expected an acknowledged void response');
        }
    }
}

export class IpcMethod<Q, R> {
    constructor(
        readonly id: string,
        readonly request: IpcSchema<Q>,
        readonly response: IpcSchema<R>,
        readonly mask: MaskSpec,
        readonly kind: 'request' | 'notification' = 'request',
    ) {
        IpcIdentity.assert(id, 'method');
    }
}

/** Every API member must have exactly one DTO argument and a Promise reply. */
export type IpcMethods<T> = {
    [K in keyof T]: T[K] extends (...args: infer A) => Promise<infer R>
        ? A extends [infer Q]
            ? IpcMethod<Q, R>
            : never
        : never;
};
export type IpcApiType<T> = abstract new (...args: never[]) => T;

/** Runtime metadata is declared once beside the shared contract. IDs survive minification. */
export class IpcContract<T extends object> {
    readonly methods: Readonly<IpcMethods<T>>;
    constructor(
        readonly id: string,
        readonly api: IpcApiType<T>,
        methods: IpcMethods<T>,
    ) {
        IpcIdentity.assert(id, 'API');
        const ids = new Set<string>();
        for (const key of Object.keys(methods)) {
            // webpieces-disable no-any-unknown -- untrusted IPC data is schema-validated; generic dispatch cannot assume a DTO type before validation
            const method: unknown = methods[key as keyof T];
            if (
                !(method instanceof IpcMethod) ||
                ids.has(method.id) ||
                ['then', 'constructor', '__proto__'].includes(key)
            ) {
                throw new BadRequestError(`Invalid or duplicate IPC metadata: ${id}.${key}`);
            }
            ids.add(method.id);
            Object.freeze(method);
        }
        this.methods = Object.freeze(Object.assign(Object.create(null), methods));
    }
}

export class IpcIdentity {
    // webpieces-disable no-function-outside-class -- portable stateless IPC primitive; no platform DI container exists on this boundary; webpieces-disable no-any-unknown -- untrusted IPC data is schema-validated; generic dispatch cannot assume a DTO type before validation
    static assert(value: unknown, label: string): asserts value is string {
        if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)) {
            throw new BadRequestError(`Invalid IPC ${label} identity`);
        }
    }
}
