import { execSync } from 'child_process';

import { NoEditOnMainConfig } from '@webpieces/rules-config';

import type { FileContext, Violation } from '../types';
import { Violation as V } from '../types';
import { FileRuleBase } from '../rule-base';
import { toError } from '../to-error';

export class NoEditOnMainRule extends FileRuleBase<NoEditOnMainConfig> {
    constructor(config: NoEditOnMainConfig) { super(config, 'no-edit-on-main'); }

    readonly description = 'Block file edits when on the main branch — all work must happen on a feature branch.';
    override readonly files = ['**/*'];
    override readonly defaultOptions = {
        branchNamingConvention: '{whoami}/{featurename}',
    };
    readonly fixHint = [
        'You should not be working on main.',
        'Steps:',
        '  1. git pull origin main   ← get latest commits',
        '  2. git checkout -b <branch-name>   ← create feature branch',
        'Branch naming convention is defined in webpieces.config.json under no-edit-on-main.branchNamingConvention.',
    ];

    check(ctx: FileContext): readonly Violation[] {
        // Only apply to files inside the workspace root
        if (ctx.relativePath.startsWith('..')) return [];

        let currentBranch: string;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
                cwd: ctx.workspaceRoot,
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return [];
        }

        if (currentBranch !== 'main') return [];

        const convention = this.config.branchNamingConvention ?? '{whoami}/{featurename}';

        return [new V(
            1,
            ctx.relativePath,
            [
                'You should not be working on main.',
                'Do a `git pull origin main` to get latest, then create a feature branch based on the naming convention.',
                `Branch naming convention (from webpieces.config.json): ${convention}`,
                'Example: git checkout -b ' + convention.replace(/<[^>]+>/g, 'value'),
            ].join('\n'),
        )];
    }
}
