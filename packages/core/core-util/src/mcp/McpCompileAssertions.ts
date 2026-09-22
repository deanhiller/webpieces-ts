import { WpMcpTool } from './McpMetadata';

/**
 * Compile-time pins for `@WpMcpTool`. These live in a COMPILED file rather than a `.spec.ts` because
 * vitest strips types with esbuild and `tsconfig.lib.json` excludes specs, so a `@ts-expect-error` in
 * a spec is inert (`.claude/rules/no-backwards-compat.md` shim shape #4). Here, tsc fails the build
 * with TS2578 the moment one of these starts compiling.
 */
abstract class InvalidMcpContract {
    // @ts-expect-error @WpMcpTool takes the stable protocol NAME, not an options object
    @WpMcpTool({ name: 'invalid' })
    options(_request: object): Promise<object> {
        throw new Error('contract only');
    }

    // @ts-expect-error side-effect claims belong on @Endpoint.operation, never @WpMcpTool
    @WpMcpTool('invalid', true)
    hints(_request: object): Promise<object> {
        throw new Error('contract only');
    }
}

abstract class InvalidMcpArities {
    // @ts-expect-error MCP tools require exactly one request DTO
    @WpMcpTool('zero-arity')
    zero(): Promise<object> {
        throw new Error('contract only');
    }

    // @ts-expect-error MCP tools require exactly one request DTO
    @WpMcpTool('multi-arity')
    multi(_first: object, _second: object): Promise<object> {
        throw new Error('contract only');
    }
}

void InvalidMcpContract;
void InvalidMcpArities;
