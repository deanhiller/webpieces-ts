/**
 * Project Info
 *
 * Per-project metadata pulled from nx's project graph (root + tags), used to
 * enrich architecture/dependencies.json with AI-oriented fields.
 */

export class ProjectInfo {
    constructor(
        public readonly name: string,
        /** Project root, relative to the workspace root (e.g. packages/http/http-routing) */
        public readonly root: string,
        public readonly tags: string[]
    ) {}
}
