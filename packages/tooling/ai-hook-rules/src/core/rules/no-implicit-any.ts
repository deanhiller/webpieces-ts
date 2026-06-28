import type { EditRule, EditContext, Violation } from '../types';
import { Violation as V } from '../types';

const ARROW_PARAMS_RE = /\(([^()]*)\)\s*=>/g;
const FN_DECL_PARAMS_RE = /\bfunction\s*[\w$]*\s*\(([^()]*)\)/g;

function firstUntypedParam(paramsStr: string): string | null {
    if (paramsStr.includes('{') || paramsStr.includes('[')) return null;
    const parts = paramsStr.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
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

const noImplicitAnyRule: EditRule = {
    name: 'no-implicit-any',
    description: 'Disallow function parameters without explicit type annotations (implicit-any).',
    scope: 'edit',
    files: ['**/*.ts', '**/*.tsx'],
    defaultOptions: {},
    fixHint: [
        'Add explicit types: (x: string) => ...   or   function foo(x: number)',
        '// webpieces-disable no-implicit-any -- <one-line reason>',
    ],

    check(ctx: EditContext): readonly Violation[] {
        const violations: V[] = [];
        for (let i = 0; i < ctx.strippedLines.length; i += 1) {
            const stripped = ctx.strippedLines[i];
            const lineNum = i + 1;
            if (ctx.isLineDisabled(lineNum, 'no-implicit-any')) continue;
            const offender = findOffender(stripped);
            if (!offender) continue;
            violations.push(new V(
                lineNum,
                ctx.lines[i].trim(),
                `Parameter "${offender}" has no type annotation. Add an explicit type to avoid implicit-any.`,
            ));
        }
        return violations;
    },
};

export default noImplicitAnyRule;
