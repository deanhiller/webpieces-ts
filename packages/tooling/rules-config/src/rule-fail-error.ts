/**
 * Thrown by ANY rule — in `ai-hook-rules` (edit-time) OR `code-rules` (build/CI-time) — to report a
 * failure from anywhere in its logic. Each engine wraps every rule in a per-rule try/catch, so a
 * thrown `RuleFailError` becomes one visible failure entry and the loop keeps going to the next rule;
 * a plain `Error` (a real bug) is caught the same way and surfaced too — one rule can never abort the
 * others.
 *
 * It is a STANDALONE `Error` — deliberately NOT an `InformAiError`. `InformAiError` is an AI-only
 * concept (it informs Claude Code); `code-rules` has no notion of "AI", so a shared rule-failure type
 * must not depend on it. Rules report failures with `RuleFailError`; `InformAiError` stays for
 * config/stdin/plumbing errors and the AI-facing guards path.
 *
 * Two audiences, one throw:
 *  - `aiMessage`    — what the AI sees in the ai-hook path (also `Error.message`).
 *  - `humanMessage` — what a developer/CI sees in the code-rules console (defaults to `aiMessage`).
 *
 * `line`/`snippet`/`fixHints` are optional context the ai-hook engine folds into its `Violation`.
 *
 * Constructor is positional to match this package's other data classes (`Violation`, `ResolvedConfig`)
 * and the project's classes-over-interfaces convention. Common throws:
 *   throw new RuleFailError('no-any-unknown', 'Avoid `any` here — use `unknown`.', 42, 'const x: any');
 *   throw new RuleFailError('max-file-lines', 'File exceeds the limit.', undefined, undefined, ['Split it up']);
 */
export class RuleFailError extends Error {
    override cause?: Error;
    readonly ruleName: string;
    readonly aiMessage: string;
    readonly humanMessage: string;
    readonly line: number | undefined;
    readonly snippet: string | undefined;
    readonly fixHints: readonly string[];

    constructor(
        ruleName: string,
        aiMessage: string,
        line?: number,
        snippet?: string,
        fixHints: readonly string[] = [],
        humanMessage?: string,
        cause?: Error,
    ) {
        super(aiMessage);
        this.name = 'RuleFailError';
        this.ruleName = ruleName;
        this.aiMessage = aiMessage;
        this.humanMessage = humanMessage ?? aiMessage;
        this.line = line;
        this.snippet = snippet;
        this.fixHints = fixHints;
        this.cause = cause;
    }
}
