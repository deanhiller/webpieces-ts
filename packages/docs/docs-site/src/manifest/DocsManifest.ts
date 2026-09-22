/** One prose page named by `docs.manifest.json`, in the order the manifest names it. */
export class ProsePageEntry {
    constructor(
        readonly file: string,
        readonly title: string,
    ) {}
}

/**
 * `docs.manifest.json` — the ORDER of the prose pages, and nothing else.
 *
 * It exists for the same reason the OpenAPI document's `tags[]` does: the order is a teaching
 * decision somebody made, and neither directory listing order nor alphabetical order is it.
 * Alphabetising this array is not a cleanup — it reorders the pages a partner reads first.
 */
export class DocsManifest {
    constructor(
        /** Overrides the document's `info.title` in the site header. Empty means "use the document's". */
        readonly title: string,
        readonly pages: readonly ProsePageEntry[],
    ) {}
}

/** One prose page, loaded: its heading, its URL segment and its markdown source. */
export class ProsePage {
    constructor(
        readonly title: string,
        readonly slug: string,
        readonly markdown: string,
    ) {}
}
