/**
 * Nx Inference Plugin for Circular Dependency Checking
 *
 * This plugin automatically creates a "check-circular-deps" target for ANY project
 * that has a src/ directory, similar to how @nx/eslint/plugin creates lint targets.
 *
 * Benefits:
 * - Zero configuration per project
 * - Works for ALL projects (services + libraries)
 * - New projects automatically get the target
 * - `nx affected --target=check-circular-deps` works on everything
 *
 * Usage:
 * Add to nx.json plugins array:
 * {
 *   "plugins": ["@webpieces/dev-config/plugins/circular-deps"]
 * }
 *
 * Then run:
 * - nx run <project>:check-circular-deps
 * - nx affected --target=check-circular-deps
 */

import { dirname, join } from 'path';
import { existsSync } from 'fs';
import type { CreateNodesV2, CreateNodesContextV2, CreateNodesResultV2, CreateNodesResult } from '@nx/devkit';

/**
 * Nx V2 Inference Plugin
 * Matches project.json files and creates check-circular-deps target
 */
export const createNodesV2: CreateNodesV2 = [
    // Pattern to match: look for project.json files
    '**/project.json',

    // Inference function
    async (
        projectFiles: readonly string[],
        _options: unknown,
        context: CreateNodesContextV2
    ): Promise<CreateNodesResultV2> => {
        const results: Array<readonly [string, CreateNodesResult]> = [];

        for (const projectFile of projectFiles) {
            const projectRoot = dirname(projectFile);
            const srcDir = join(context.workspaceRoot, projectRoot, 'src');

            // Only create target if project has a src/ directory
            if (existsSync(srcDir)) {
                const checkCircularDepsTarget = {
                    executor: 'nx:run-commands',
                    cache: true,
                    inputs: ['default'],
                    outputs: [] as string[],
                    options: {
                        command: 'npx madge --circular --extensions ts,tsx src',
                        cwd: projectRoot,
                    },
                    metadata: {
                        technologies: ['madge'],
                        description: 'Check for circular dependencies using madge',
                    },
                };

                const result: CreateNodesResult = {
                    projects: {
                        [projectRoot]: {
                            targets: {
                                'check-circular-deps': checkCircularDepsTarget,
                            },
                        },
                    },
                };

                results.push([projectFile, result] as const);
            }
        }

        return results;
    },
];

export default { createNodesV2 };
