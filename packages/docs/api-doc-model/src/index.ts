/**
 * `@webpieces/api-doc-model` — read a webpieces API contract with the TypeScript compiler API and
 * produce ONE in-memory {@link ApiDocModel}.
 *
 * This is the single extraction pass both the OpenAPI documents and the MCP tool list (#982) are
 * rendered from. It emits nothing itself, and it depends on `typescript` and nothing else, so it can
 * be pointed at any upstream project's contract — see `responsibilities.md` for why that constraint
 * is worth stating rather than leaving to be discovered.
 */
export { ApiDocExtractor } from './extract/ApiDocExtractor';
export { ApiDocExtractionError } from './extract/ApiDocExtractionError';
export {
    ApiDocModel,
    DocumentedAuth,
    DocumentedEndpoint,
    DocumentedEndpointOptions,
    DocumentedField,
    DocumentedMcpTool,
    DocumentedType,
    UnionDiscriminator,
    UnmappedType,
} from './model/ApiDocModel';
export { TypeRef } from './model/TypeRef';
export type { PrimitiveKind, TypeRefKind } from './model/TypeRef';
