import { DtoValue, getAuthMeta } from '@webpieces/core-util';
import { ApiClientProxy, ApiFactory, ClassType } from '@webpieces/http-routing';

export type McpBindingTopology = 'local' | 'remote';

/** Explicit contract-to-invoker binding; MCP never discovers implementations from a router. */
export class McpApiBinding<TApi extends object = object> {
    private constructor(
        public readonly api: ClassType<TApi>,
        public readonly topology: McpBindingTopology,
        private readonly provider: () => TApi,
    ) {}

    // webpieces-disable no-function-outside-class -- explicit public factory mirrors the binding API
    static local<TApi extends object>(
        api: ClassType<TApi>,
        apiFactory: ApiFactory,
    ): McpApiBinding<TApi> {
        return new McpApiBinding(api, 'local', () => apiFactory.createApiClient(api as never));
    }

    // webpieces-disable no-function-outside-class -- explicit public factory mirrors the binding API
    static remote<TApi extends object>(
        api: ClassType<TApi>,
        provider: () => TApi,
    ): McpApiBinding<TApi> {
        return new McpApiBinding(api, 'remote', provider);
    }

    invoke(methodName: string, request: DtoValue): Promise<DtoValue> {
        const client = this.provider() as ApiClientProxy;
        const method = client[methodName];
        if (typeof method !== 'function') {
            throw new Error(
                `MCP binding provider for ${this.api.name} has no method '${methodName}'.`,
            );
        }
        return method.call(client, request) as Promise<DtoValue>;
    }

    validateMethod(methodName: string): void {
        const auth = getAuthMeta(this.api, methodName)?.mode;
        const expected = this.topology === 'local' ? 'jwt' : 'oidc';
        if (auth?.kind !== expected) {
            throw new Error(
                `MCP ${this.topology} binding ${this.api.name}.${methodName} requires ` +
                    `@${expected === 'jwt' ? 'WpAuthJwt' : 'WpAuthOidc'}, but declares ` +
                    `${auth ? `'${auth.kind}'` : 'no HTTP auth'}.`,
            );
        }
    }
}
