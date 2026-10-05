import { ApiBadRequestError, ApiJsonSchemaValidator, DtoValue } from '@webpieces/core-util';
import { RequestContext } from '@webpieces/core-context';
import { InvocationAuthentication, AuthorizationService } from '@webpieces/http-routing';
import { McpToolPolicy } from './McpToolPolicy';
import { RegisteredMcpTool } from './McpToolRegistry';
import { VerifiedMcpCredential } from './McpAuth';
import { MCP_INVOCATION_CONTEXT, McpInvocationContext } from './McpInvocationContext';

/** Authorize, validate, then issue a local credential and invoke the ordinary filters. No scope or catch. */
export class McpApiDispatcher {
    private readonly schemas = new ApiJsonSchemaValidator();

    async call(
        tool: RegisteredMcpTool,
        requestDto: DtoValue,
        credential: VerifiedMcpCredential,
        invocation: McpInvocationContext,
        policy: AuthorizationService,
    ): Promise<DtoValue> {
        await new McpToolPolicy(policy).require(
            tool.authorization,
            tool.name,
        );
        const inputFailure = this.schemas.validate(tool.inputSchema, requestDto);
        if (inputFailure) {
            throw new ApiBadRequestError(
                `MCP arguments for ${tool.name} did not match its published input schema: ${inputFailure.message}`,
                inputFailure.field,
                inputFailure.message,
            );
        }
        const authentication =
            tool.binding.topology === 'local'
                ? new InvocationAuthentication(tool.apiClass, tool.methodName)
                : undefined;
        RequestContext.putTrusted(MCP_INVOCATION_CONTEXT, invocation);
        return tool.binding.invoke(tool.methodName, requestDto, authentication);
    }
}
