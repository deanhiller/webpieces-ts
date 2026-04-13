import type { EditRule, EditContext, Violation } from '../types';
import { Violation as V } from '../types';

const VARIABLE_DESTRUCTURE = /\b(?:const|let|var)\s*\{/;

const noDestructureRule: EditRule = {
    name: 'no-destructure',
    description: 'Disallow destructuring patterns. Assign the whole result and pass it around or access properties explicitly.',
    scope: 'edit',
    files: ['**/*.ts', '**/*.tsx'],
    defaultOptions: { allowTopLevel: true },
    fixHint: [
        'Instead of: const { x, y } = methodCall(); prefer const obj = methodCall(); then pass obj to other methods or use obj.x',
        '// webpieces-disable no-destructure -- <reason>',
    ],

    check(ctx: EditContext): readonly Violation[] {
        const violations: V[] = [];
        for (let i = 0; i < ctx.strippedLines.length; i += 1) {
            const stripped = ctx.strippedLines[i];
            if (!VARIABLE_DESTRUCTURE.test(stripped)) continue;
            const lineNum = i + 1;
            if (ctx.isLineDisabled(lineNum, 'no-destructure')) continue;
            violations.push(new V(
                lineNum,
                ctx.lines[i].trim(),
                'Destructuring pattern. Assign the whole result instead: const obj = methodCall(); then pass obj around or use obj.x',
            ));
        }
        return violations;
    },
};

export default noDestructureRule;
