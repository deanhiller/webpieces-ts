/**
 * What generation knows about the OTHER packages a document's types are declared in (#1058) — read
 * from disk by the loader BEFORE generation, so the generator stays a pure function of established
 * facts.
 *
 * A contract (or DTO library) document defines only the schemas its own package declares and
 * `$ref`s every other one into the declaring package's `components.openapi.json`. Whether that
 * document exists, and which schemas it holds, is therefore an INPUT — and its absence is the
 * fail-closed refusal, never a reason to copy the schema in.
 */

/** A package that publishes a components document, and the schema names it holds. Data-only. */
export class PublishedComponents {
    constructor(
        readonly packageName: string,
        /** Absolute path of the `components.openapi.json` that was read. */
        readonly documentPath: string,
        /** Every key of its `components.schemas`. */
        readonly schemaNames: ReadonlySet<string>,
    ) {}
}

/** A package that publishes NO components document, and why the lookup says so. Data-only. */
export class MissingComponents {
    constructor(
        readonly packageName: string,
        /** One sentence: where it looked and what it found instead. */
        readonly reason: string,
    ) {}
}

/** Every other package a document's types are declared in, by package name. */
export class UpstreamComponentsIndex {
    constructor(
        private readonly published: ReadonlyMap<string, PublishedComponents>,
        private readonly missing: ReadonlyMap<string, MissingComponents>,
    ) {}

    // webpieces-disable no-function-outside-class -- static factory of this class
    static empty(): UpstreamComponentsIndex {
        return new UpstreamComponentsIndex(
            new Map<string, PublishedComponents>(),
            new Map<string, MissingComponents>(),
        );
    }

    publishedBy(packageName: string): PublishedComponents | undefined {
        return this.published.get(packageName);
    }

    missingFor(packageName: string): MissingComponents | undefined {
        return this.missing.get(packageName);
    }

    /** Every published upstream document, in package-name order. */
    allPublished(): readonly PublishedComponents[] {
        return Array.from(this.published.keys())
            .sort()
            .map((name: string) => this.published.get(name)!);
    }
}
