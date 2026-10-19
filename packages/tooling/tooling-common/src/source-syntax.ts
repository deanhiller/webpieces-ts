import * as ts from 'typescript';

/**
 * The ONE `typescript` every syntax rule walks with (#1314). A rule must test nodes with the same compiler
 * that parsed them: `ts.SyntaxKind` numbers move between TypeScript releases, so a repo-local rule that
 * walked this parse with its own `typescript` could silently misread every node. Re-exported so a rule
 * never needs a `typescript` of its own.
 */
export { ts };

/**
 * One local TypeScript parse of one file's text, shared by every syntax rule that judges it.
 * No compiler program, no import resolution, no git: a rule walks `source` and decides the policy.
 */
export class SourceSyntax {
    readonly source: ts.SourceFile;

    constructor(fileName: string, content: string) {
        this.source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
    }

    /** 1-based line of a node's first non-trivia character. */
    lineOf(node: ts.Node): number {
        return this.source.getLineAndCharacterOfPosition(node.getStart(this.source)).line + 1;
    }

    /** 1-based line of a node's last character. */
    endLineOf(node: ts.Node): number {
        return this.source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    }
}

/** A per-site disable's written reason must say WHY this one site may break the rule. */
export const MIN_DISABLE_REASON = 20;

const DIRECTIVE = /\/\/\s*webpieces-disable\s+([\w-]+(?:\s*,\s*[\w-]+)*)(?:\s*--\s*(.*?))?\s*$/;
const DIRECTIVE_LINE = /^\/\/\s*webpieces-disable\b/;

/**
 * The `// webpieces-disable <rule>[, <rule2>] -- <reason>` directives one file carries for ONE rule,
 * resolved the way every webpieces disable is: a directive after code on its line targets that line; a
 * directive on a line of its own targets the next line that is neither blank nor another directive. Only
 * the line-comment form exists — there is no block or file form to honour.
 *
 * It records the written reason, so a rule that demands one ({@link MIN_DISABLE_REASON}) can tell an
 * exempted site from a disable that names the rule but says nothing of why. Shared by
 * `catch-must-propagate` and the repo-local rules (#1314), in the guard and at the gate alike.
 */
export class SiteDisables {
    private readonly reasons = new Map<number, string>();

    constructor(text: string, ruleId: string) {
        const lines = text.split('\n');
        lines.forEach((line: string, index: number) => {
            const match = DIRECTIVE.exec(line);
            if (!match) return;
            const rules = (match[1] ?? '').split(',').map((rule: string) => rule.trim());
            if (!rules.includes(ruleId)) return;
            const target = line.slice(0, line.indexOf('//')).trim() !== '' ? index + 1 : this.nextCodeLine(lines, index);
            if (target !== undefined) this.reasons.set(target, (match[2] ?? '').trim());
        });
    }

    /** The written reason of the disable aimed at 1-based `line` ('' when it has none), or undefined. */
    reasonAt(line: number): string | undefined {
        return this.reasons.get(line);
    }

    private nextCodeLine(lines: readonly string[], index: number): number | undefined {
        for (let next = index + 1; next < lines.length; next++) {
            const trimmed = (lines[next] ?? '').trim();
            if (trimmed !== '' && !DIRECTIVE_LINE.test(trimmed)) return next + 1;
        }
        return undefined;
    }
}
