import { Option, formatFixOptions } from './fix-option';

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
 * `line`/`snippet`/`fixOptions` are optional context the ai-hook engine folds into its `Violation`.
 *
 * `fixOptions` is `readonly Option[]` — the SAME `Option` that `FixHint.fixOptions` carries, so there is
 * exactly ONE representation of "the list of cures" across both engines, and a build-time rule can mark
 * one cure `preferred` exactly like an edit-time rule can. It was `readonly string[]`; that spelling is
 * deleted and does not compile. NEVER hand-number the cures inside `aiMessage` — the framework
 * (`formatFixOptions`) owns the "Fix Option N:" numbering and the "(preferred)" tag.
 *
 * Constructor is positional to match this package's other data classes (`Violation`, `ResolvedConfig`)
 * and the project's classes-over-interfaces convention. Common throws:
 *   throw new RuleFailError('no-any-unknown', 'Avoid `any` here — use `unknown`.', 42, 'const x: any');
 *   throw new RuleFailError('max-file-lines', 'File exceeds the limit.', undefined, undefined,
 *       [new Option('Split it into two modules', true), new Option('Move the helpers to a sibling file')]);
 */
export class RuleFailError extends Error {
    override cause?: Error;
    readonly ruleName: string;
    readonly aiMessage: string;
    readonly humanMessage: string;
    readonly line: number | undefined;
    readonly snippet: string | undefined;
    readonly fixOptions: readonly Option[];

    constructor(
        ruleName: string,
        aiMessage: string,
        line?: number,
        snippet?: string,
        fixOptions: readonly Option[] = [],
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
        this.fixOptions = fixOptions;
        this.cause = cause;
    }
}

/**
 * The AI-audience rendering of a thrown `RuleFailError`: its `aiMessage` plus its cures, numbered and
 * tagged by the framework. Used by the top-level handlers in `ai-hook-rules`.
 *
 * WHY it exists: every handler used to print `aiMessage`/`humanMessage` alone, so a `RuleFailError`
 * that escaped a per-rule catch reached the AI or the CI console with its `fixOptions` SILENTLY
 * DROPPED — the rule had said how to fix the problem and the renderer threw that away. One renderer per
 * audience means a cure cannot go missing depending on which catch caught the throw.
 */
// webpieces-disable no-function-outside-class -- string formatter, sibling of formatFixOptions
export function renderRuleFailForAi(error: RuleFailError): string {
    return joinCures(error.aiMessage, error.fixOptions);
}

/** The developer/CI rendering: `humanMessage` (which defaults to `aiMessage`) plus the same cures. */
// webpieces-disable no-function-outside-class -- string formatter, sibling of formatFixOptions
export function renderRuleFailForHuman(error: RuleFailError): string {
    return joinCures(error.humanMessage, error.fixOptions);
}

// webpieces-disable no-function-outside-class -- private helper of the two renderers above
function joinCures(message: string, fixOptions: readonly Option[]): string {
    const rendered = formatFixOptions(fixOptions);
    return rendered.length === 0 ? message : `${message}\n${rendered.join('\n')}`;
}
