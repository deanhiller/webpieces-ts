import { McpDefaultToolCallRenderer, McpErrorTranslator } from './McpToolCallRendering';

/**
 * McpRegistry - the process-global home of the ONE {@link McpErrorTranslator}, mirroring
 * `ClientRegistry` for HTTP and `IpcRegistry` for IPC.
 *
 * ```ts
 * // startup, ONCE per process
 * McpRegistry.setErrorTranslator(new MyMcpErrorTranslator());
 * ```
 *
 * # This REVERSES the constructor-argument decision of #953, deliberately
 *
 * `WpMcpServerConfig.setErrorTranslator(...)` used to carry this, on the argument that `WpMcpServer`
 * is constructed by app code and two servers may run in one process. The trade is now taken the other
 * way, with the repo owner's explicit agreement: two MCP servers in one process share ONE translator,
 * and registration order matters rather than being fixed at construction.
 *
 * What buys that back is uniformity. HTTP, MCP and IPC now have the identical shape — one registry per
 * protocol, a non-optional `getErrorTranslator()`, a webpieces default that is always installed, and
 * therefore exactly one unconditional line at every call site. The "did anyone register one" branch
 * that the optional config member forced on `WpMcpErrorTranslator` is gone, and an app reads one
 * pattern instead of three.
 */
export class McpRegistry {
    /**
     * THE translator. NEVER undefined — it starts life holding a {@link McpDefaultToolCallRenderer},
     * and {@link McpRegistry.setErrorTranslator} REPLACES it.
     */
    private static errorTranslator: McpErrorTranslator = new McpDefaultToolCallRenderer();

    /**
     * Install the app's {@link McpErrorTranslator} — it REPLACES the webpieces default for every
     * `tools/call` failure, owning the ENTIRE result, and declines by delegating to
     * `new McpDefaultToolCallRenderer().toWire(error)`.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/ClientRegistry); populated once at startup, never DI-injected
    static setErrorTranslator(translator: McpErrorTranslator): void {
        McpRegistry.errorTranslator = translator;
    }

    /** THE {@link McpErrorTranslator} for this process — never `undefined`, so no caller branches. */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/ClientRegistry); populated once at startup, never DI-injected
    static getErrorTranslator(): McpErrorTranslator {
        return McpRegistry.errorTranslator;
    }

    /** Put the process-global back to the webpieces default. For TESTS, so specs cannot leak. */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/ClientRegistry); populated once at startup, never DI-injected
    static resetForTests(): void {
        McpRegistry.errorTranslator = new McpDefaultToolCallRenderer();
    }
}
