import * as fs from 'fs';
import * as path from 'path';

import { isPathExcluded, Option } from '@webpieces/rules-config';
import { ValidateTsInSrcConfig } from '../../configs/rule-configs';

import type { FileContext, Violation } from '@webpieces/hook-runtime';
import { Violation as V } from '@webpieces/hook-runtime';
import { FileRuleBase } from '@webpieces/hook-runtime';
import { FixHint } from '@webpieces/hook-runtime';

// Never project source, whatever the config says: a FLOOR the rule applies itself (like GENERATED_CODE_PATHS
// for max-file-lines). The repo's own `excludePaths` — this rule's and the top-level one — are framework
// fields the engine applies before this rule is dispatched (#1253); they ADD to this list.
const BUILT_IN_EXCLUDE_PATHS = [
    'node_modules',
    'dist',
    '.nx',
    '.git',
    '**/*.d.ts',
    '**/jest.config.ts',
];
const DEFAULT_ALLOWED_ROOT_FILES = ['jest.setup.ts'];

function findProjectRoot(filePath: string, workspaceRoot: string): string | null {
    let dir = path.dirname(filePath);
    while (dir !== workspaceRoot && dir.startsWith(workspaceRoot)) {
        if (fs.existsSync(path.join(dir, 'project.json'))) return dir;
        dir = path.dirname(dir);
    }
    return null;
}

export class ValidateTsInSrcRule extends FileRuleBase<ValidateTsInSrcConfig> {
    constructor(config: ValidateTsInSrcConfig) {
        super(config, 'validate-ts-in-src', 'validate-ts-in-src');
    }

    readonly description = "Every .ts file must belong to a project's src/ directory.";
    override readonly files = ['**/*.ts', '**/*.tsx'];
    override readonly defaultOptions = {
        allowedRootFiles: DEFAULT_ALLOWED_ROOT_FILES,
    };
    readonly fixHint = new FixHint(
        'TypeScript file is outside a project src/ directory.',
        'Fix by one of:',
        [
            new Option(
                "Move the file into an existing project's src/ directory, or create a new project with project.json that owns the directory.",
                true,
            ),
            new Option(
                'Add a glob (e.g. "**/codegen.ts", "scripts/**") to validate-ts-in-src.excludePaths in {configFile}',
            ),
        ],
    );

    check(ctx: FileContext): readonly Violation[] {
        if (ctx.tool !== 'Write') return [];

        const allowedRootFiles = this.config.allowedRootFiles ?? DEFAULT_ALLOWED_ROOT_FILES;

        // The built-in floor (bare dir names + globs); configured excludePaths never reach this rule.
        if (isPathExcluded(ctx.targetRelativePath, BUILT_IN_EXCLUDE_PATHS)) return [];

        const relParts = ctx.targetRelativePath.split(path.sep);
        if (relParts.length === 1 && allowedRootFiles.indexOf(relParts[0] ?? '') >= 0) return [];

        const projectRoot = findProjectRoot(ctx.filePath, ctx.targetRoot);

        if (!projectRoot) {
            return [
                new V(
                    1,
                    ctx.targetRelativePath,
                    "File is not inside any Nx project. Move it into a project's src/ directory.",
                ),
            ];
        }

        const relToProject = path.relative(projectRoot, ctx.filePath);
        if (!relToProject.startsWith('src' + path.sep) && relToProject !== 'src') {
            const projectName = path.relative(ctx.targetRoot, projectRoot);
            return [
                new V(
                    1,
                    ctx.targetRelativePath,
                    `File is inside project \`${projectName}\` but outside its src/ directory. Move it into src/.`,
                ),
            ];
        }

        return [];
    }
}
