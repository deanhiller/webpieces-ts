/**
 * `Option` is THE representation of one cure — "here is a way to fix this" — for BOTH rule engines.
 *
 * It lives HERE, in the lowest-level package, because both engines need it and the dependency runs one
 * way: `@webpieces/ai-hook-rules` depends on `@webpieces/rules-config` (see its package.json), never the
 * reverse. `RuleFailError` (this package) carries `readonly Option[]`, and `FixHint`
 * (`ai-hook-rules/src/core/fix-hint.ts`) carries the same `Option` — one class, one import path.
 *
 * WHY it was moved down (2026-08-18): `RuleFailError.fixHints` used to be `readonly string[]` while
 * `FixHint.fixOptions` was `readonly Option[]`. That was TWO shapes for one concept — the shim shape
 * CLAUDE.md calls "two spellings of one thing" — and the `string[]` half could not express `preferred`
 * at all, so a build-time rule had no way to say which cure to reach for first. There is now exactly one
 * spelling; the old one does not compile.
 *
 * The framework — `formatFixOptions` below, and `report.ts` in ai-hook-rules — owns the
 * "Fix Option N:" numbering and the "(preferred)" tag. Rule authors NEVER hand-write those labels, and
 * never hand-number cures inside a string literal.
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
 * The ONE renderer for a list of cures, so the numbering and the "(preferred)" tag have a single
 * implementation across the edit-time report, the edit-time thrown-rule path, and the build-time
 * console. `indent` is the leading whitespace for the "Fix Option N:" line; continuation lines of a
 * multi-line option get `indent + '  '`.
 */
// webpieces-disable no-function-outside-class -- a pure string formatter, sibling to `atRoot`; a class around it would be ceremony
export function formatFixOptions(options: readonly Option[], indent = '  '): readonly string[] {
    const lines: string[] = [];
    options.forEach((opt: Option, i: number) => {
        const optLines = opt.text.split('\n');
        const tag = opt.preferred ? '(preferred) ' : '';
        lines.push(`${indent}Fix Option ${String(i + 1)}: ${tag}${optLines[0] ?? ''}`);
        for (const l of optLines.slice(1)) lines.push(`${indent}  ${l}`);
    });
    return lines;
}
