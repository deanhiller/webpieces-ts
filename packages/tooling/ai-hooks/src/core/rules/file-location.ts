import * as fs from 'fs';
import * as path from 'path';

import type { FileRule, FileContext, Violation } from '../types';
import { Violation as V } from '../types';

const DEFAULT_EXCLUDE_PATHS = [
    'node_modules', 'dist', '.nx', '.git',
    'architecture', 'tmp', 'scripts',
];
const DEFAULT_ALLOWED_ROOT_FILES = ['jest.setup.ts'];

function isNodeModulesDir(name: string): boolean {
    return name === 'node_modules' || name.startsWith('node_modules_');
}

function shouldSkipDir(name: string, excludePaths: readonly string[]): boolean {
    if (isNodeModulesDir(name)) return true;
    return excludePaths.indexOf(name) >= 0;
}

function findProjectRoot(filePath: string, workspaceRoot: string): string | null {
    let dir = path.dirname(filePath);
    while (dir !== workspaceRoot && dir.startsWith(workspaceRoot)) {
        if (fs.existsSync(path.join(dir, 'project.json'))) return dir;
        dir = path.dirname(dir);
    }
    return null;
}

const fileLocationRule: FileRule = {
    name: 'file-location',
    description: 'Every .ts file must belong to a project\'s src/ directory.',
    scope: 'file',
    files: ['**/*.ts', '**/*.tsx'],
    defaultOptions: {
        excludePaths: DEFAULT_EXCLUDE_PATHS,
        allowedRootFiles: DEFAULT_ALLOWED_ROOT_FILES,
    },
    fixHint: [
        'Move the file into an existing project\'s src/ directory, or create a new project with project.json that owns the directory.',
        'Add the dir to file-location.excludePaths in webpieces.ai-hooks.json',
    ],

    check(ctx: FileContext): readonly Violation[] {
        if (ctx.tool !== 'Write') return [];

        const excludePaths = Array.isArray(ctx.options['excludePaths'])
            ? ctx.options['excludePaths'] as string[]
            : DEFAULT_EXCLUDE_PATHS;
        const allowedRootFiles = Array.isArray(ctx.options['allowedRootFiles'])
            ? ctx.options['allowedRootFiles'] as string[]
            : DEFAULT_ALLOWED_ROOT_FILES;

        const relParts = ctx.relativePath.split(path.sep);
        const topDir = relParts[0];

        if (topDir && shouldSkipDir(topDir, excludePaths)) return [];
        if (relParts.length === 1 && allowedRootFiles.indexOf(relParts[0]) >= 0) return [];

        const projectRoot = findProjectRoot(ctx.filePath, ctx.workspaceRoot);

        if (!projectRoot) {
            return [new V(
                1,
                ctx.relativePath,
                'File is not inside any Nx project. Move it into a project\'s src/ directory.',
            )];
        }

        const relToProject = path.relative(projectRoot, ctx.filePath);
        const fileName = path.basename(ctx.filePath);
        if (fileName === 'jest.config.ts') return [];
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

export default fileLocationRule;
