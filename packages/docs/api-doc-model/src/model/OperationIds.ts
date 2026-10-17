/**
 * How every operation's `operationId` is spelled (#1270). OPTIONAL in a contract manifest, defaulting
 * to {@link CONTRACT_METHOD} (#1283) — the spelling every earlier release published, and the only one
 * unique by construction. `operationId` is what openapi-generator, Kiota, NSwag and friends name the
 * METHOD in every client a partner generates, so changing the spelling renames every method in every
 * partner's SDK; {@link METHOD} is the opt-in for a document that already published bare names.
 *
 * It lives beside the model rather than in the OpenAPI generator because two renderers name an
 * operation: the OpenAPI document, and an MCP tool catalog resolving a `{@link}` to a contract method
 * that is not a tool (#1284). One rule, one place.
 */
export enum OperationIdStyle {
    /** `OrdersApi_fetchOrders` — unique by construction across contracts. */
    CONTRACT_METHOD = 'contract_method',
    /**
     * `fetchOrders` — the bare method name. Two operations of one document sharing it is a HARD
     * FAILURE naming both, so the id is still unique.
     */
    METHOD = 'method',
}

/** THE operationId of a contract method, in a manifest's chosen {@link OperationIdStyle}. */
export class OperationIds {
    constructor(private readonly style: OperationIdStyle) {}

    of(contractName: string, methodName: string): string {
        return this.style === OperationIdStyle.METHOD
            ? methodName
            : `${contractName}_${methodName}`;
    }
}
