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
    NO_CLIENT_CREATION_OUTSIDE_SERVER_OR_CLIENT: 'no-client-creation-outside-server-or-client',
    NO_PROCESS_EXIT_OUTSIDE_MAIN: 'no-process-exit-outside-main',
    NO_FUNCTION_OUTSIDE_CLASS: 'no-function-outside-class',
    INJECT_ANNOTATION_NOT_NEEDED_FOR_CONCRETE_CLASS: 'inject-annotation-not-needed-for-concrete-class',
    FRAMEWORK_TAG: 'framework-tag',
    ROLE_TAG: 'role-tag',
    NO_INLINE_TYPES: 'no-inline-types',
    NO_DIRECT_API_RESOLVER: 'no-direct-api-resolver',
    NO_CUSTOM_CSS: 'no-custom-css',
    PRISMA_CONVERTER: 'prisma-converter',
    MAX_LINES_NEW_METHODS: 'max-lines-new-methods',
    MAX_LINES_MODIFIED_FILES: 'max-lines-modified-files',
    MAX_LINES_MODIFIED: 'max-lines-modified',
} as const;

// Merge-state convention shared by the pr-gate scripts (which WRITE the marker during a
// conflicted 3-point merge) and the ai-hook-rules merge-in-progress-guard (which READS it
// to block commit/push/PR until the merge is validated). Kept here so neither package
// depends on the other — they only share this vocabulary.
//
// `.webpieces/` is the single working dir for all webpieces tooling: ai-hook-rules
// bootstrap/cache, the instruct-ai docs, and the workflow state. To keep the top level
// quiet, per-feature workflow dirs are nested one level down under `merge-info/<feature>`
// and `pr-review/<feature>` rather than scattered as top-level `merge-<feature>`/`pr-<feature>`.
// `.webpieces/` is gitignored; only the per-feature subdirs under those two homes are subject
// to 30-day cleanup (the homes themselves, like hooks/ and instruct-ai/, are permanent).
// The DIRECTORY NAME only. Never join it onto a root yourself — go through `DotWebpieces.shared()`
// (repo-wide state), `DotWebpieces.local()` (this worktree's own tooling-written state) or
// `DotWebpieces.aiWritable()` (this worktree's state that a CODING AGENT writes) so the call site
// declares its scope. In a linked worktree the three resolve to different places, and getting that
// silently wrong is the bug those methods exist to prevent.
export const WEBPIECES_TMP_DIR = '.webpieces';
export const MERGE_INFO_DIR = 'merge-info';
// The PR working home. Renamed from the legacy `pr-info` to `pr-review` for clarity (it holds the
// AI's PR review + rendered body). Old `pr-info/` dirs are gitignored local state and self-clear via
// cleanTmp's legacy `pr-` sweep.
export const PR_REVIEW_DIR = 'pr-review';
export const MERGE_IN_PROGRESS_FILE = 'merge-in-progress.json';

// The dev-deploy resolve state file, written by `wp-push-dev --resolve` and cleared by
// `wp-finish-push-dev` (or `--abort`). Named here for the same reason MERGE_IN_PROGRESS_FILE is: the
// pr-gate commands WRITE it and things outside pr-gate READ it to decide whether a resolve is
// half-finished, and neither side may depend on the other.
//
// It lives directly under `.webpieces/` local state (NOT under merge-info/), because a dev-deploy
// resolve is not a 3-point merge: it never touches the feature branch, never produces merge-info
// context, and must NOT be picked up by merge-in-progress-guard's marker scan — that guard's remedy
// is `pnpm wp-finish-upsert-pr`, which is the wrong command here and would strand the tmp branch.
export const PUSH_DEV_STATE_FILE = 'push-dev-in-progress.json';

// Proof-of-work the AI must produce for every conflicted file it resolves during a 3-point
// merge: a short explanation written NEXT TO that file's 3-point context (the same
// `updatemain-<safe_path>/` dir that holds A-forkpoint.txt / B-A.diff / C-A.diff). The
// wp-finish-upsert-pr gate requires a non-empty file of this name per conflicted file before passing —
// it is the only check on the part of the process the AI actually owns (resolving files). Using a
// sidecar file (rather than an in-source comment) works for any file type, including comment-less
// ones like JSON and files resolved by deletion.
export const MERGE_EXPLANATION_FILE = 'merge-explanation.md';

/**
 * The command that MECHANICALLY strips every unknown key from webpieces.config.json.
 *
 * An unknown key controls nothing, so deleting it is the cure — but "delete it" is a judgement call made
 * while the guard denies every Bash call, which is exactly when a reader is least able to make one. This
 * command turns that judgement into one keystroke, and every message that reports an unknown key names it.
 *
 * Lives in this leaf module (no imports) so both the banner and the validators can name it without
 * importing the pruner and re-creating an import cycle.
 */
export const PRUNE_UNKNOWN_COMMAND = 'pnpm wp-prune-unknown-config';

/**
 * Fast predicate: does this text carry a webpieces-disable for the given rule?
 * Line-agnostic — the caller decides which line(s) or block of text to feed it.
 * This is the cheap substring form used by code-rules detection and pr-gate's
 * dashboard grep/count. (ai-hook-rules uses a richer line-mapping parser.)
 */
export function hasDisable(text: string, ruleName: string): boolean {
    return text.includes(WEBPIECES_DISABLE) && text.includes(ruleName);
}
