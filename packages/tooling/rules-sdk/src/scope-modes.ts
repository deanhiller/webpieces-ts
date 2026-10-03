/** Shared scope vocabulary for generic custom rules and independent rule contributions. */
export const FILE_LIMIT_MODES = ['OFF', 'NEW_AND_MODIFIED_FILES'] as const;

export type FileLimitMode = typeof FILE_LIMIT_MODES[number];

// The two WHOLE-SCOPE modes (#1027) reuse the existing vocabulary rather than inventing names:
//   MODIFIED_PROJECTS — every in-scope file of every project the diff touches (plus the changed files
//                       themselves, so it is never narrower than NEW_AND_MODIFIED_FILES).
//   RUN_EVERY_TIME    — every in-scope file in the repo, every run.
// Both judge WHOLE files, exactly like NEW_AND_MODIFIED_FILES — only the file SET differs. They exist so
// a rule adopted at NEW_AND_MODIFIED_CODE can be measured ("what is left?") or finished off without a
// hack, and they are what `wp-validate-code --rule=<name> --mode=<mode> --projects=a,b` accepts.
// Edit-time (ai-hooks) treats every non-OFF mode alike: it judges the content being written.
export const MODIFIED_CODE_MODES = ['OFF', 'NEW_AND_MODIFIED_CODE', 'NEW_AND_MODIFIED_FILES', 'MODIFIED_PROJECTS', 'RUN_EVERY_TIME'] as const;

export type ModifiedCodeMode = typeof MODIFIED_CODE_MODES[number];

export const ON_OFF_MODES = ['ON', 'OFF'] as const;

export type OnOffMode = typeof ON_OFF_MODES[number];
