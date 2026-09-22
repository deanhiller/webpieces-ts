import { ApiDocModel } from '@webpieces/api-doc-model';
import { JsonObject } from '../json/JsonObject';
import { ApiEntry, OpenApiManifest } from '../manifest/OpenApiManifest';

/** One manifest entry, paired with the model extracted from the file it names. */
export class ContractModel {
    constructor(
        readonly entry: ApiEntry,
        readonly model: ApiDocModel,
        /** Absolute path to the contract, so a refusal can name a file somebody can open. */
        readonly file: string,
    ) {}
}

/**
 * One response header, with its name already FOLDED out of the constant the manifest named.
 *
 * The folding happens before generation, not during it, so the generator is a pure function of
 * already-established facts: everything that can fail by reading the world has failed by then.
 */
export class ResolvedResponseHeader {
    constructor(
        readonly headerName: string,
        readonly description: string | undefined,
    ) {}
}

/**
 * Everything generation needs, with every file already read and every constant already folded.
 *
 * Separating this from {@link OpenApiGenerator} is what makes the generator testable without a
 * filesystem — and, more usefully, what makes the two documents provably one generation pass: they
 * are rendered from THIS value, twice, with only the hidden-endpoint filter differing.
 */
export class GenerationInputs {
    constructor(
        readonly manifestPath: string,
        readonly manifest: OpenApiManifest,
        readonly contracts: readonly ContractModel[],
        /** The document-wide error body's model, when the manifest declared one. */
        readonly errorType: ApiDocModel | undefined,
        readonly responseHeaders: readonly ResolvedResponseHeader[],
        /** The markdown preamble's TEXT, already read from `descriptionFile`. */
        readonly description: string | undefined,
    ) {}
}

/** ONE rendered document and the name it is written under. */
export class GeneratedDocument {
    constructor(
        /** Without an extension — `--format` decides whether it is `.json`, `.yaml` or both. */
        readonly fileName: string,
        readonly document: JsonObject,
    ) {}
}

/**
 * The documents this generation pass produced — one per `@ApiType` some contract declared, and no
 * others.
 *
 * `diff full-private-openapi.json public-openapi.json` is the complete list of what these contracts
 * do not show a customer, and both are committed, so hiding a method shows up as a diff in the PR
 * that hides it. That is the property the pair exists for.
 */
export class GeneratedDocuments {
    constructor(readonly documents: readonly GeneratedDocument[]) {}
}
