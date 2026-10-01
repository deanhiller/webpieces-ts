/**
 * `@webpieces/openapi-generator` — render an `ApiDocModel` to OpenAPI 3.1.0.
 *
 * ONE generation pass produces TWO documents: the CANONICAL internal one, which carries every
 * operation including hidden ones plus the `x-mcp-*` extensions, and the CUSTOMER one, from which a
 * hidden endpoint is absent entirely. They are byte-identical when nothing is hidden, which is the
 * property that makes hiding reviewable — see `responsibilities.md`.
 *
 * It ships the `wp-openapi` bin, and depends on `typescript` and `@webpieces/api-doc-model` alone.
 */
export { OpenApiGenerationError } from './OpenApiGenerationError';
export { JsonObject } from './json/JsonObject';
export type { JsonValue } from './json/JsonObject';
export { JsonWriter } from './json/JsonWriter';
export { YamlWriter } from './json/YamlWriter';
export { YamlReader } from './json/YamlReader';
export {
    ApiEntry,
    ComponentsManifest,
    ErrorResponseEntry,
    ErrorsEntry,
    OpenApiManifest,
    ResponseHeaderEntry,
    ServerEntry,
} from './manifest/OpenApiManifest';
export { JsonReader } from './manifest/JsonReader';
export { ManifestLoader } from './manifest/ManifestLoader';
export {
    ComponentsInputs,
    ContractModel,
    GeneratedDocument,
    GeneratedDocuments,
    GenerationInputs,
    ResolvedResponseHeader,
} from './generate/GenerationInputs';
export {
    DocumentSelection,
    INTERNAL_ONLY_LINE,
    OPERATION_SEMANTICS,
} from './generate/DocumentSelection';
export { OpenApiGenerator } from './generate/OpenApiGenerator';
export { OperationRenderer, ResponseContract } from './generate/OperationRenderer';
export { SchemaRenderer, UnmappedField } from './generate/SchemaRenderer';
export {
    BundledNames,
    BundledPlacement,
    ComponentsReference,
    DiscoveryPlacement,
    SplitPlacement,
} from './generate/SchemaPlacement';
export type { SchemaPlacement } from './generate/SchemaPlacement';
export {
    MissingComponents,
    PublishedComponents,
    UpstreamComponentsIndex,
} from './generate/UpstreamComponents';
export { ComponentsLocator, LocatedComponents } from './load/ComponentsLocator';
export { SecurityDeriver } from './generate/SecurityDeriver';
export { ExportedConstantFolder } from './load/ExportedConstantFolder';
export { ForeignFailure } from './load/ForeignFailure';
export { InputsLoader } from './load/InputsLoader';
export { ArtifactWriter, GeneratedArtifact } from './emit/ArtifactWriter';
export type { OutputFormat } from './emit/ArtifactWriter';
export { CliResult, OpenApiCli, USAGE } from './cli/OpenApiCli';
export { WpOpenApiMain } from './cli/WpOpenApiMain';
