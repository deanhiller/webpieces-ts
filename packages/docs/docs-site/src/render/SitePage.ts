/**
 * One PRE-RENDERED file at one URL.
 *
 * The whole site is a list of these, which is the decision every other property falls out of: a deep
 * link resolves server-side because the file is already there, the output is a folder any static
 * host serves, the page reads correctly with JS off, and a JSDoc edit shows up as a diff on the one
 * page it affects instead of inside a bundle. Client JS is left with disclosure state, the language
 * tabs and the theme — the three things that are genuinely about this reader, right now.
 */
export class SitePage {
    constructor(
        /** Relative to the output root, always ending in `index.html` so `file://` browsing works. */
        readonly url: string,
        readonly title: string,
        readonly html: string,
    ) {}
}

/** One file that is copied out verbatim beside the pages — the stylesheet and the script. */
export class SiteAsset {
    constructor(
        readonly url: string,
        readonly contents: string,
    ) {}
}

/** Everything one run produces. */
export class RenderedSite {
    constructor(
        readonly pages: readonly SitePage[],
        readonly assets: readonly SiteAsset[],
    ) {}
}
