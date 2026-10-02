import type { CreateNodesResultV2 } from '@nx/devkit';

/** Adds the single virtual owner for root webpieces policy when a source checkout has no declaration. */
export class RulesTarget {
    add(results: CreateNodesResultV2, projectFiles: readonly string[]): void {
        // A source checkout carries the declaration explicitly so it can exercise the target before
        // this plugin release exists in node_modules. Once installed, that declaration wins.
        if (projectFiles.includes('rules/project.json')) return;
        const firstProjectFile = projectFiles[0];
        if (!firstProjectFile) return;
        results.push([firstProjectFile, {
            projects: {
                rules: {
                    name: 'rules',
                    root: '.',
                    tags: ['type:tooling', 'role:app', 'framework:node'],
                    targets: {
                        check: {
                            executor: '@webpieces/nx-webpieces-rules:validate-rules-config',
                            cache: true,
                            inputs: ['rulesConfig'],
                            metadata: {
                                technologies: ['nx'],
                                description: 'Validate the root webpieces.config.json policy declaration',
                            },
                        },
                    },
                },
            },
        }] as const);
    }
}
