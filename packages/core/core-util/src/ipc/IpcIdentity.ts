import { ApiBadRequestError } from '../errors';

export class IpcIdentity {
    // webpieces-disable no-function-outside-class -- portable stateless IPC primitive; no platform DI container exists on this boundary; webpieces-disable no-any-unknown -- untrusted IPC data is schema-validated; generic dispatch cannot assume a DTO type before validation
    static assert(value: unknown, label: string): asserts value is string {
        if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)) {
            throw new ApiBadRequestError(`Invalid IPC ${label} identity`);
        }
    }
}
