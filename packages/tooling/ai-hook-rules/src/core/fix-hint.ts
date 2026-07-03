/**
 * Structured fix guidance shown under a violation in a blocked-write / blocked-bash report.
 *
 * A rule authors its user-facing text once here: a required `violation` (the "what's wrong"
 * line — the rule-level default for the `→` line; a dynamic per-occurrence `Violation.message`
 * overrides it), a `mainMessage` (fix prose, or a lead-in to the options), an optional list of
 * genuinely distinct `fixOptions`, and — for the disable-able code-style rules — a framework-
 * owned `escape`.
 *
 * The framework (report.ts) — not the rule author — owns the "Fix Option N:" numbering, the
 * "(preferred)" tag, and the escape/`disableAllowed` rendering. So a multi-line message can
 * never be mis-split into fake options, and authors never hand-write those labels.
 */
export class Option {
    /** The fix text. May be multi-line; continuation lines are indented under the option. */
    readonly text: string;
    /** When true the framework prefixes the rendered option with "(preferred) ". */
    readonly preferred: boolean;

    constructor(text: string, preferred = false) {
        this.text = text;
        this.preferred = preferred;
    }
}

/**
 * Framework-owned `// webpieces-disable` escape hatch for a rule, gated by the team's
 * `disableAllowed` config (default true). `comment` is the exact suppress syntax to show
 * (usually `// webpieces-disable <rule> -- <reason>`; max-file-lines uses the eslint form).
 * When `allowed` is false the framework prints a "must be followed" line instead of the escape.
 */
export class DisableEscape {
    readonly allowed: boolean;
    readonly comment: string;

    constructor(allowed: boolean, comment: string) {
        this.allowed = allowed;
        this.comment = comment;
    }
}

export class FixHint {
    /** Required: the "what's wrong" line (rule-level default for the `→` line). */
    readonly violation: string;
    /** Required (may be ''): fix prose, or a lead-in to the options. Multi-line ok. */
    readonly mainMessage: string;
    /** Real fixes only — NEVER the disable escape (that is `escape`). */
    readonly fixOptions: readonly Option[];
    /** Present only for disable-able rules; absent for guards. */
    readonly escape?: DisableEscape;
    /**
     * True for the git/PR/branch/merge WORKFLOW GUARDS the AI re-triggers every session — it keeps
     * reaching for `gh pr create`, editing on main, branching off a feature branch, merging directly,
     * etc., and each hit is a wasted blocked-command round-trip. When set, the framework (report.ts)
     * appends a one-line nudge telling the AI to persist the correct workflow (e.g. "PRs go only
     * through wp-start-upsert-pr") to its Claude memory so it uses the gated flow up front instead of
     * getting blocked. Off for the code-style rules and situational rules (file size), where the
     * per-occurrence fix is context-specific and a saved memory would not stop the next hit.
     */
    readonly frequentlyHit: boolean;

    constructor(
        violation: string,
        mainMessage: string,
        fixOptions: readonly Option[] = [],
        escape?: DisableEscape,
        frequentlyHit = false,
    ) {
        this.violation = violation;
        this.mainMessage = mainMessage;
        this.fixOptions = fixOptions;
        this.escape = escape;
        this.frequentlyHit = frequentlyHit;
    }
}
