import { AuthMode, DtoValue, getAuthMeta, assertEveryEndpointHasAuthMode } from '@webpieces/core-util';
import {
    ApiClientProxy,
    ApiFactory,
    ClassType,
    InvocationAuthentication,
} from '@webpieces/http-routing';

export type McpBindingTopology = 'local' | 'remote';

/** Explicit contract-to-invoker binding; MCP never discovers implementations from a router. */
export class McpApiBinding<TApi extends object = object> {
    private constructor(
        public readonly api: ClassType<TApi>,
        public readonly topology: McpBindingTopology,
        private readonly provider: (authentication?: InvocationAuthentication) => TApi,
    ) {}

    // webpieces-disable no-function-outside-class -- explicit public factory mirrors the binding API
    static local<TApi extends object>(
        api: ClassType<TApi>,
        apiFactory: ApiFactory,
    ): McpApiBinding<TApi> {
        return new McpApiBinding(api, 'local', (authentication) => {
            if (!authentication)
                throw new Error('Local MCP invocation requires explicit authentication.');
            return apiFactory.createInvocationApiClient(api as never, authentication);
        });
    }

    // webpieces-disable no-function-outside-class -- explicit public factory mirrors the binding API
    static remote<TApi extends object>(
        api: ClassType<TApi>,
        provider: () => TApi,
    ): McpApiBinding<TApi> {
        return new McpApiBinding(api, 'remote', provider);
    }

    invoke(
        methodName: string,
        request: DtoValue,
        authentication?: InvocationAuthentication,
    ): Promise<DtoValue> {
        const client = this.provider(authentication) as ApiClientProxy;
        const method = client[methodName];
        if (typeof method !== 'function') {
            throw new Error(
                `MCP binding provider for ${this.api.name} has no method '${methodName}'.`,
            );
        }
        return method.call(client, request) as Promise<DtoValue>;
    }

    validateMethod(methodName: string): void {
        assertEveryEndpointHasAuthMode(this.api);
        const methods = getAuthMeta(this.api, methodName)?.methods;
        if (this.topology === 'remote' && !methods?.some((method: AuthMode) => method.kind === 'oidc' || method.kind === 'shared-secret')) {
            throw new Error(`MCP remote binding ${this.api.name}.${methodName} requires oidc(...) or sharedSecret(...) network ingress.`);
        }
    }
}
