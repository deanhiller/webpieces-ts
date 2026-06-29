// Single source of truth for the disable-comment token and rule-name identifiers
// shared across rules-config, ai-hook-rules, code-rules, and pr-gate.
//
// There is exactly ONE disable form: `// webpieces-disable <rule>[, <rule2>] -- reason`.
// The legacy `ai-hook-disable` alias and the `-file`/`-next`/`-all` variants and the
// `*`/bare (no-rule) wildcard have been removed — every disable MUST name a rule.

export const WEBPIECES_DISABLE = 'webpieces-disable';

// Rule-name tokens as they appear AFTER `webpieces-disable` in a disable comment.
// Values must match existing comments exactly — changing a value silently breaks every
// disable that names that rule. Note MAX_LINES_MODIFIED is a prefix of
// MAX_LINES_MODIFIED_FILES (a historical substring-match quirk preserved on purpose).
export const RULE_NAMES = {
    NO_ANY_UNKNOWN: 'no-any-unknown',
    NO_IMPLICIT_ANY: 'no-implicit-any',
    NO_DESTRUCTURE: 'no-destructure',
    NO_UNMANAGED_EXCEPTIONS: 'no-unmanaged-exceptions',
    CATCH_ERROR_PATTERN: 'catch-error-pattern',
    THROW_CAUSE_REQUIRED: 'throw-cause-required',
    REQUIRE_RETURN_TYPE: 'require-return-type',
    NO_SYMBOL_DI_TOKENS: 'no-symbol-di-tokens',
    NO_INLINE_TYPES: 'no-inline-types',
    NO_DIRECT_API_RESOLVER: 'no-direct-api-resolver',
    PRISMA_CONVERTER: 'prisma-converter',
    MAX_LINES_NEW_METHODS: 'max-lines-new-methods',
    MAX_LINES_MODIFIED_FILES: 'max-lines-modified-files',
    MAX_LINES_MODIFIED: 'max-lines-modified',
} as const;

// Merge-state convention shared by the pr-gate scripts (which WRITE the marker during a
// conflicted 3-point merge) and the ai-hook-rules merge-in-progress-guard (which READS it
// to block commit/push/PR until the merge is validated). Kept here so neither package
// depends on the other — they only share this vocabulary.
export const WEBPIECES_TMP_DIR = 'webpiecesTmp';
export const MERGE_DIR_PREFIX = 'merge-';
export const MERGE_IN_PROGRESS_FILE = 'merge-in-progress.json';

/**
 * Fast predicate: does this text carry a webpieces-disable for the given rule?
 * Line-agnostic — the caller decides which line(s) or block of text to feed it.
 * This is the cheap substring form used by code-rules detection and pr-gate's
 * dashboard grep/count. (ai-hook-rules uses a richer line-mapping parser.)
 */
export function hasDisable(text: string, ruleName: string): boolean {
    return text.includes(WEBPIECES_DISABLE) && text.includes(ruleName);
}
