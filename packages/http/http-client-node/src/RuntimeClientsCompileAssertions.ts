import type { ContainerModuleLoadOptions } from 'inversify';
import { ClientToken } from '@webpieces/http-client-core';
import { RuntimeClients } from './RuntimeClients';

abstract class StringApi {
    abstract read(): string;
}
abstract class NumberApi {
    abstract read(): number;
}

/** Compiled by tsc, never invoked. Vitest alone does not check these negative guarantees. */
export class RuntimeClientsCompileAssertions {
    check(
        options: ContainerModuleLoadOptions,
        strings: ClientToken<StringApi>,
        numbers: ClientToken<NumberApi>,
    ): void {
        const clients = new RuntimeClients(options);
        clients.bindRpc(strings, StringApi, 'strings');
        // @ts-expect-error The destination is a required argument.
        clients.bindRpc(strings, StringApi);
        // @ts-expect-error Typed tokens must match the supplied API contract.
        clients.bindRpc(numbers, StringApi, 'strings');
        clients.bindRpc(numbers, NumberApi, 'numbers');
        // @ts-expect-error Destination wrappers were removed; pass the service string.
        clients.bindRpc(strings, StringApi, { serviceName: 'strings' });
    }
}
