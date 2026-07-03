import { NoDestructureConfig, RULE_NAMES } from '@webpieces/rules-config';

import type { EditContext, Violation } from '../types';
import { Violation as V } from '../types';
import { EditRuleBase } from '../rule-base';
import { FixHint, DisableEscape } from '../fix-hint';

const VARIABLE_DESTRUCTURE = /\b(?:const|let|var)\s*\{/;

export class NoDestructureRule extends EditRuleBase<NoDestructureConfig> {
    constructor(config: NoDestructureConfig) { super(config, 'no-destructure'); }

    readonly description = 'Disallow destructuring patterns. Assign the whole result and pass it around or access properties explicitly.';
    override readonly files = ['**/*.ts', '**/*.tsx'];
    override readonly defaultOptions = { allowTopLevel: true };
    get fixHint(): FixHint {
        return new FixHint(
            'Destructuring pattern on a call result.',
            'Assign the whole result instead: const obj = methodCall(); then pass obj around or use obj.x.',
            [],
            new DisableEscape(this.config.disableAllowed ?? true, '// webpieces-disable no-destructure -- <reason>'),
        );
    }

    check(ctx: EditContext): readonly Violation[] {
        const disableAllowed = this.config.disableAllowed ?? true;
        const violations: V[] = [];
        for (let i = 0; i < ctx.strippedLines.length; i += 1) {
            const stripped = ctx.strippedLines[i];
            if (!VARIABLE_DESTRUCTURE.test(stripped)) continue;
            const lineNum = i + 1;
            if (disableAllowed && ctx.isLineDisabled(lineNum, RULE_NAMES.NO_DESTRUCTURE)) continue;
            violations.push(new V(lineNum, ctx.lines[i].trim()));
        }
        return violations;
    }
}
