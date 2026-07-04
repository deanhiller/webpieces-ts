import {
    EnforceControllerNamingConfig,
    RULE_NAMES,
    ControllerNamingViolation,
    findControllerNamingViolations,
} from '@webpieces/rules-config';

import type { EditContext, Violation } from '../types';
import { Violation as V } from '../types';
import { EditRuleBase } from '../rule-base';
import { FixHint, Option, DisableEscape } from '../fix-hint';

/**
 * enforce-controller-naming (edit-time). Blocks a write that introduces a controller class whose
 * NAME doesn't end in `Controller`, or whose FILE isn't the lower-case kebab `{something}-controller.ts`.
 * A class counts as a controller when it's `@Controller()`-decorated OR its heritage ends in `*Api`.
 *
 * The detection + kebab expectation + allowedPaths/test-file exemption is the shared engine
 * (findControllerNamingViolations); this rule adds the per-occurrence message + isLineDisabled filter.
 * Note: for an Edit (vs a whole-file Write) the hook sees only the changed hunk, so the trigger fires
 * only when the class declaration is in that hunk — the build-time validator is the full guarantor.
 */
export class EnforceControllerNamingRule extends EditRuleBase<EnforceControllerNamingConfig> {
    constructor(config: EnforceControllerNamingConfig) { super(config, 'enforce-controller-naming'); }

    readonly description = 'Any class implementing/extending an *Api must be @Controller (named {Something}Controller in {something}-controller.ts) or @NotController.';
    override readonly files = ['**/*.ts', '**/*.tsx'];
    override readonly defaultOptions = { allowedPaths: [] };

    get fixHint(): FixHint {
        return new FixHint(
            'A class implementing an *Api has not declared its controller intent, or a @Controller is misnamed.',
            'Any class whose heritage ends in *Api must declare intent, and a controller-discovery tool finds controllers by globbing **/*-controller.ts. Add this convention to your memory so you don\'t re-hit this guard and waste tokens. Pick one:',
            [
                new Option('It IS a controller → add @Controller, name the class {Something}Controller, and name the file {something}-controller.ts (kebab of the class name, e.g. SaveController → save-controller.ts).', true),
                new Option('It is NOT a controller (a simulator / in-process client / test double) → add @NotController to opt out of the naming rules.'),
            ],
            new DisableEscape(this.config.disableAllowed ?? true, '// webpieces-disable enforce-controller-naming -- <reason>'),
        );
    }

    check(ctx: EditContext): readonly Violation[] {
        const disableAllowed = this.config.disableAllowed ?? true;
        const hits = findControllerNamingViolations(ctx.strippedLines, ctx.relativePath, this.config);

        const violations: V[] = [];
        for (const hit of hits as readonly ControllerNamingViolation[]) {
            if (disableAllowed && ctx.isLineDisabled(hit.line, RULE_NAMES.ENFORCE_CONTROLLER_NAMING)) continue;
            // Pass the specific message so the report's `→` line names class-name vs file-name.
            violations.push(new V(hit.line, ctx.lines[hit.line - 1]?.trim() ?? hit.context, hit.message));
        }
        return violations;
    }
}
