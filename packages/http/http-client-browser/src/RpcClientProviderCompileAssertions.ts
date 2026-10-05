import { provideRpcClient } from './RpcClientProvider';

abstract class TextApi { abstract read(): string; }
abstract class CountApi { abstract read(): number; }

/** Compiled fixtures protect token/API inference after removing destination wrappers. */
export class RpcClientProviderCompileAssertions {
    check(): void {
        provideRpcClient(TextApi, TextApi, 'text-service');
        // @ts-expect-error Class tokens must match the API contract.
        provideRpcClient(CountApi, TextApi, 'text-service');
        // @ts-expect-error A service destination is required.
        provideRpcClient(TextApi, TextApi);
        // @ts-expect-error Wrapper destinations were removed; use a service string.
        provideRpcClient(TextApi, TextApi, { serviceName: 'text-service' });
    }
}
