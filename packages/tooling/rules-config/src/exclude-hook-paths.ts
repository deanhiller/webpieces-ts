// Top-level `excludePaths` block from webpieces.config.json. Two independently-varying glob lists
// that suppress hook enforcement for matching files (matched against the workspace-relative path):
//  - `rules`  — paths where code-style rules are skipped (e.g. vendored repos under repositories/**).
//  - `guards` — paths where FILE-scoped guards (e.g. feature-branch-guard) are skipped. Bash git/PR
//               guards are unaffected — they reason about git state, not a file location.
// Data-only (per CLAUDE.md, classes for data). Built once by loadAndValidate after validation.
export class ExcludePaths {
    constructor(
        readonly rules: string[],
        readonly guards: string[],
    ) {}
}
