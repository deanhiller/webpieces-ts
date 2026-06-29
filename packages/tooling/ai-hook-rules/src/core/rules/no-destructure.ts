import { NoDestructureConfig, RULE_NAMES } from '@webpieces/rules-config';

import type { EditContext, Violation } from '../types';
import { Violation as V } from '../types';
import { EditRuleBase } from '../rule-base';

const VARIABLE_DESTRUCTURE = /\b(?:const|let|var)\s*\{/;

export class NoDestructureRule extends EditRuleBase<NoDestructureConfig> {
    constructor(config: NoDestructureConfig) { super(config, 'no-destructure'); }

    readonly description = 'Disallow destructuring patterns. Assign the whole result and pass it around or access properties explicitly.';
    override readonly files = ['**/*.ts', '**/*.tsx'];
    override readonly defaultOptions = { allowTopLevel: true };
    readonly fixHint = [
        'Instead of: const { x, y } = methodCall(); prefer const obj = methodCall(); then pass obj to other methods or use obj.x',
        '// webpieces-disable no-destructure -- <reason>',
    ];

    check(ctx: EditContext): readonly Violation[] {
        const violations: V[] = [];
        for (let i = 0; i < ctx.strippedLines.length; i += 1) {
            const stripped = ctx.strippedLines[i];
            if (!VARIABLE_DESTRUCTURE.test(stripped)) continue;
            const lineNum = i + 1;
            if (ctx.isLineDisabled(lineNum, RULE_NAMES.NO_DESTRUCTURE)) continue;
            violations.push(new V(
                lineNum,
                ctx.lines[i].trim(),
                'Destructuring pattern. Assign the whole result instead: const obj = methodCall(); then pass obj around or use obj.x',
            ));
        }
        return violations;
    }
}
