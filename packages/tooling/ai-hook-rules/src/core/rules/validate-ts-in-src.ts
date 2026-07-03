import * as fs from 'fs';
import * as path from 'path';

import { ValidateTsInSrcConfig, isPathExcluded } from '@webpieces/rules-config';

import type { FileContext, Violation } from '../types';
import { Violation as V } from '../types';
import { FileRuleBase } from '../rule-base';
import { FixHint, Option } from '../fix-hint';

const DEFAULT_EXCLUDE_PATHS = [
    'node_modules', 'dist', '.nx', '.git',
    '**/*.d.ts', '**/jest.config.ts',
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
    constructor(config: ValidateTsInSrcConfig) { super(config, 'validate-ts-in-src'); }

    readonly description = 'Every .ts file must belong to a project\'s src/ directory.';
    override readonly files = ['**/*.ts', '**/*.tsx'];
    override readonly defaultOptions = {
        excludePaths: DEFAULT_EXCLUDE_PATHS,
        allowedRootFiles: DEFAULT_ALLOWED_ROOT_FILES,
    };
    readonly fixHint = new FixHint(
        'TypeScript file is outside a project src/ directory.',
        'Fix by one of:',
        [
            new Option('Move the file into an existing project\'s src/ directory, or create a new project with project.json that owns the directory.', true),
            new Option('Add a dir or glob (e.g. "**/codegen.ts") to validate-ts-in-src.excludePaths in webpieces.config.json'),
        ],
    );

    check(ctx: FileContext): readonly Violation[] {
        if (ctx.tool !== 'Write') return [];

        const excludePaths = this.config.excludePaths ?? DEFAULT_EXCLUDE_PATHS;
        const allowedRootFiles = this.config.allowedRootFiles ?? DEFAULT_ALLOWED_ROOT_FILES;

        // Holistic exclusion (Layer 1 + Layer 2): bare dir names + globs.
        if (isPathExcluded(ctx.relativePath, excludePaths)) return [];

        const relParts = ctx.relativePath.split(path.sep);
        if (relParts.length === 1 && allowedRootFiles.indexOf(relParts[0] ?? '') >= 0) return [];

        const projectRoot = findProjectRoot(ctx.filePath, ctx.workspaceRoot);

        if (!projectRoot) {
            return [new V(
                1,
                ctx.relativePath,
                'File is not inside any Nx project. Move it into a project\'s src/ directory.',
            )];
        }

        const relToProject = path.relative(projectRoot, ctx.filePath);
        if (!relToProject.startsWith('src' + path.sep) && relToProject !== 'src') {
            const projectName = path.relative(ctx.workspaceRoot, projectRoot);
            return [new V(
                1,
                ctx.relativePath,
                `File is inside project \`${projectName}\` but outside its src/ directory. Move it into src/.`,
            )];
        }

        return [];
    }
}
