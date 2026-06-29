import { NoImplicitAnyConfig, RULE_NAMES } from '@webpieces/rules-config';

import type { EditContext, Violation } from '../types';
import { Violation as V } from '../types';
import { EditRuleBase } from '../rule-base';

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

export class NoImplicitAnyRule extends EditRuleBase<NoImplicitAnyConfig> {
    constructor(config: NoImplicitAnyConfig) { super(config, 'no-implicit-any'); }

    readonly description = 'Disallow function parameters without explicit type annotations (implicit-any).';
    override readonly files = ['**/*.ts', '**/*.tsx'];
    readonly fixHint = [
        'Add explicit types: (x: string) => ...   or   function foo(x: number)',
        '// webpieces-disable no-implicit-any -- <one-line reason>',
    ];

    check(ctx: EditContext): readonly Violation[] {
        const violations: V[] = [];
        for (let i = 0; i < ctx.strippedLines.length; i += 1) {
            const stripped = ctx.strippedLines[i];
            const lineNum = i + 1;
            if (ctx.isLineDisabled(lineNum, RULE_NAMES.NO_IMPLICIT_ANY)) continue;
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
