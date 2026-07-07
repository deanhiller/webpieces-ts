import { NoProcessExitOutsideMainConfig, RULE_NAMES, writeTemplateIfMissing } from '@webpieces/rules-config';

import type { EditContext, Violation } from '../types';
import { Violation as V } from '../types';
import { EditRuleBase } from '../rule-base';
import { FixHint, Option, DisableEscape } from '../fix-hint';

const INSTRUCT_FILE = 'webpieces.noexitinmain.md';
const EXIT_REGEX = /\bprocess\.exit\s*\(/;
// `import { ... main ... } from '...'` — importing another module's `main` (incl. `main as X`).
const IMPORT_MAIN_REGEX = /^\s*import\b[^;]*\{[^}]*\bmain\b[^}]*\}[^;]*\bfrom\b/;
// Named function / arrow-const openers, used to find the enclosing function's name. Deliberately
// only matches DEFINITIONS (`function foo(`, `const foo = (`/`= function`), never a call like
// `main()` — so `main().catch(...)` inside runMain is skipped and the scan reaches `function runMain`.
const FUNC_DEF_REGEX = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(|(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:\(|function\b)/;
const ALLOWED_FN = new Set(['main', 'runMain']);

// Walk backward from `idx` for the nearest NAMED function/arrow definition and return its name.
// Line-based heuristic (the edit engine has no AST): good enough to recognise a `main`/`runMain`
// wrapper enclosing the exit. Returns null at module scope (no enclosing named function).
function enclosingFunctionName(strippedLines: readonly string[], idx: number): string | null {
    for (let j = idx; j >= 0; j -= 1) {
        const m = FUNC_DEF_REGEX.exec(strippedLines[j] ?? '');
        if (m) return m[1] ?? m[2] ?? null;
    }
    return null;
}

export class NoProcessExitOutsideMainRule extends EditRuleBase<NoProcessExitOutsideMainConfig> {
    constructor(config: NoProcessExitOutsideMainConfig) { super(config, 'no-process-exit-outside-main'); }

    readonly description = 'Disallow process.exit() outside a main()/runMain wrapper (and importing another module\'s main). A deep exit crashes a reused server/command too early; throw a semantic error and let main pick the exit code.';
    override readonly files = ['**/*.ts', '**/*.tsx'];
    override readonly defaultOptions = {};
    get fixHint(): FixHint {
        return new FixHint(
            'process.exit() outside main()/runMain (or an import of another module\'s `main`) — a deep exit can crash a reused server or command far too early, and exit 0 masquerades as success.',
            'READ .webpieces/instruct-ai/webpieces.noexitinmain.md, then:',
            [
                new Option('Throw a semantic error instead of exiting — RuleFailError for an expected failure, an ordinary Error for a bug/precondition — and let main()/runMain translate it to an exit code.', true),
                new Option('A bin owns the single exit: `if (require.main === module) runMain(main)`. Need a specific code deep down? `throw new CliExitError(code, message)`.'),
                new Option('Do not import another module\'s `main` — call a named function; only a thin wrapper calls main.'),
            ],
            new DisableEscape(this.config.disableAllowed ?? true, '// webpieces-disable no-process-exit-outside-main -- <reason>'),
        );
    }

    check(ctx: EditContext): readonly Violation[] {
        const disableAllowed = this.config.disableAllowed ?? true;
        const violations: V[] = [];
        for (let i = 0; i < ctx.strippedLines.length; i += 1) {
            const stripped = ctx.strippedLines[i] ?? '';
            const isExit = EXIT_REGEX.test(stripped)
                && !ALLOWED_FN.has(enclosingFunctionName(ctx.strippedLines, i) ?? '');
            const isImportMain = IMPORT_MAIN_REGEX.test(stripped);
            if (!isExit && !isImportMain) continue;
            const lineNum = i + 1;
            if (disableAllowed && ctx.isLineDisabled(lineNum, RULE_NAMES.NO_PROCESS_EXIT_OUTSIDE_MAIN)) continue;
            violations.push(new V(lineNum, ctx.lines[i]?.trim() ?? ''));
        }
        if (violations.length > 0) writeTemplateIfMissing(ctx.workspaceRoot, INSTRUCT_FILE);
        return violations;
    }
}
