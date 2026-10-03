import { SourceContributionConfig } from "../source-contribution-config";


import type { EditContext, Violation } from '@webpieces/hook-runtime';
import { Violation as V } from '@webpieces/hook-runtime';
import { EditRuleBase } from '@webpieces/hook-runtime';
import { FixHint, DisableEscape } from '@webpieces/hook-runtime';

const ARROW_PARAMS_RE = /\(([^()]*)\)\s*=>/g;
const FN_DECL_PARAMS_RE = /\bfunction\s*[\w$]*\s*\(([^()]*)\)/g;

function firstUntypedParam(paramsStr: string): string | null {
    if (paramsStr.includes('{') || paramsStr.includes('[')) return null;
    const parts = paramsStr.split(',').map((p: string) => p.trim()).filter((p: string) => p.length > 0);
    for (const part of parts) {
        if (part.startsWith('...')) continue;
        if (part.includes(':')) continue;
        if (part.includes('=')) continue;
        if (part === 'this') continue;
        if (/^[a-zA-Z_$][\w$]*$/.test(part)) return part;
    }
    return null;
}

function findOffender(line: string): string | null {
    ARROW_PARAMS_RE.lastIndex = 0;
    let m: RegExpExecArray | null = ARROW_PARAMS_RE.exec(line);
    while (m !== null) {
        const bad = firstUntypedParam(m[1]);
        if (bad) return bad;
        m = ARROW_PARAMS_RE.exec(line);
    }
    FN_DECL_PARAMS_RE.lastIndex = 0;
    m = FN_DECL_PARAMS_RE.exec(line);
    while (m !== null) {
        const bad = firstUntypedParam(m[1]);
        if (bad) return bad;
        m = FN_DECL_PARAMS_RE.exec(line);
    }
    return null;
}

export class NoImplicitAnyRule extends EditRuleBase<SourceContributionConfig> {
    constructor(config: SourceContributionConfig) { super(config, 'no-implicit-any', 'no-implicit-any'); }

    readonly description = 'Disallow function parameters without explicit type annotations (implicit-any).';
    override readonly files = ['**/*.ts', '**/*.tsx'];
    get fixHint(): FixHint {
        return new FixHint(
            'A parameter has no type annotation (implicit any).',
            'Add explicit types: (x: string) => ... or function foo(x: number).',
            [],
            new DisableEscape(this.config.disableAllowed ?? true, '// webpieces-disable no-implicit-any -- <one-line reason>'),
        );
    }

    check(ctx: EditContext): readonly Violation[] {
        const disableAllowed = this.config.disableAllowed ?? true;
        const violations: V[] = [];
        for (let i = 0; i < ctx.strippedLines.length; i += 1) {
            const stripped = ctx.strippedLines[i];
            const lineNum = i + 1;
            if (disableAllowed && ctx.isLineDisabled(lineNum, "no-implicit-any")) continue;
            const offender = findOffender(stripped);
            if (!offender) continue;
            violations.push(new V(
                lineNum,
                ctx.lines[i].trim(),
                `Parameter "${offender}" has no type annotation. Add an explicit type to avoid implicit-any.`,
            ));
        }
        return violations;
    }
}
