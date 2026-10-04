import type { ContainerModuleLoadOptions } from 'inversify';
import type { RpcTarget } from '@webpieces/http-client-core';
import { ClientToken, rpcTarget } from '@webpieces/http-client-core';
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
        // @ts-expect-error RpcTarget is a type; rpcTarget is the sole public construction helper.
        new RpcTarget(StringApi, 'strings');
        clients.bindRpc(strings, StringApi, rpcTarget(StringApi, 'strings'));
        // @ts-expect-error The destination is a required argument.
        clients.bindRpc(strings, StringApi);
        // @ts-expect-error Typed tokens must match the supplied API contract.
        clients.bindRpc(numbers, StringApi, rpcTarget(StringApi, 'strings'));
        // @ts-expect-error Raw destination strings bypass the required capability descriptor.
        clients.bindRpc(strings, StringApi, 'strings');
        // @ts-expect-error Targets must match the supplied API contract.
        clients.bindRpc(strings, StringApi, rpcTarget(NumberApi, 'numbers'));
    }
}
