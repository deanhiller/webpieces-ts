import * as fs from 'fs';
import * as path from 'path';

import { isPathExcluded } from '@webpieces/rules-config';

import type { FileRule, FileContext, Violation } from '../types';
import { Violation as V } from '../types';

const DEFAULT_EXCLUDE_PATHS = [
    'node_modules', 'dist', '.nx', '.git',
    'architecture', 'tmp', 'scripts',
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

const validateTsInSrcRule: FileRule = {
    name: 'validate-ts-in-src',
    description: 'Every .ts file must belong to a project\'s src/ directory.',
    scope: 'file',
    files: ['**/*.ts', '**/*.tsx'],
    defaultOptions: {
        excludePaths: DEFAULT_EXCLUDE_PATHS,
        allowedRootFiles: DEFAULT_ALLOWED_ROOT_FILES,
    },
    fixHint: [
        'Move the file into an existing project\'s src/ directory, or create a new project with project.json that owns the directory.',
        'Add a dir or glob (e.g. "**/codegen.ts") to validate-ts-in-src.excludePaths in webpieces.config.json',
    ],

    check(ctx: FileContext): readonly Violation[] {
        if (ctx.tool !== 'Write') return [];

        const excludePaths = Array.isArray(ctx.options['excludePaths'])
            ? ctx.options['excludePaths'] as string[]
            : DEFAULT_EXCLUDE_PATHS;
        const allowedRootFiles = Array.isArray(ctx.options['allowedRootFiles'])
            ? ctx.options['allowedRootFiles'] as string[]
            : DEFAULT_ALLOWED_ROOT_FILES;

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
    },
};

export default validateTsInSrcRule;
