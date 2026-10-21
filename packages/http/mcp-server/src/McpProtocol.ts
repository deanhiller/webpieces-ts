/**
 * The framework-owned contract CLASS for MCP protocol steps — `initialize`, `tools/list`, the HTTP
 * edge, and a `tools/call` that failed before its tool was resolved. Those steps have no user
 * contract, but an `ApiMethodInfo` / `CallContext` always names a contract CLASS (#1350), so they name
 * this one. Nothing is registered for it by default, so they reach the `ALL` rung of the `CallScope`
 * ladder; an app that wants MCP-protocol-specific classification registers for this class:
 *
 * ```ts
 * ClientRegistry.setErrorClassifier(new MyMcpProtocolClassifier(), McpProtocol);
 * ```
 *
 * A `tools/call` whose tool WAS resolved names the tool's bound `@ApiPath` contract instead.
 */
export abstract class McpProtocol {}
