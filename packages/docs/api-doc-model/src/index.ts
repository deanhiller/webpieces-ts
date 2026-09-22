/**
 * `@webpieces/api-doc-model` — read a webpieces API contract with the TypeScript compiler API and
 * produce ONE in-memory {@link ApiDocModel}.
 *
 * This is the single extraction pass both the OpenAPI documents and the MCP tool list (#982) are
 * rendered from. It emits nothing itself, and it takes every decorator NAME it matches on from the
 * real `@webpieces/core-util` symbol — so renaming a decorator is a compile error here rather than a
 * literal that quietly stops matching and empties a document (issue #1001). See
 * `responsibilities.md` for why that import is not the coupling it looks like.
 */
export { ApiDocExtractor } from './extract/ApiDocExtractor';
export { ApiDocExtractionError } from './extract/ApiDocExtractionError';
export {
    ApiDocModel,
    DocumentedApiKey,
    DocumentedApiKeyCredential,
    DocumentedAuth,
    DocumentedEndpoint,
    DocumentedEndpointOptions,
    DocumentedField,
    DocumentedMcpTool,
    DocumentedType,
    UnionDiscriminator,
    UnmappedType,
} from './model/ApiDocModel';
export { McpRenderError } from './render/McpRenderError';
export { McpSchemaRenderer } from './render/McpSchemaRenderer';
export { McpToolDefinition } from './render/McpToolDefinition';
export { TypeRef } from './model/TypeRef';
export type { PrimitiveKind, TypeRefKind } from './model/TypeRef';
