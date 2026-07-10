/**
 * Workspace validation target factories
 *
 * The no-argument `architecture:*` validation target configurations, extracted
 * from plugin.ts (which is at its file-size limit). Each instance method returns
 * the nx TargetConfiguration that runs one @webpieces/nx-webpieces-rules validator.
 * Instantiate once and inject the instance where the targets are assembled (no
 * static methods — a static method can't be injected).
 */

import { TargetConfiguration } from '@nx/devkit';

export class ValidationTargets {
    noCycles(): TargetConfiguration {
        return {
            executor: '@webpieces/nx-webpieces-rules:validate-no-architecture-cycles',
            cache: true,
            inputs: ['{workspaceRoot}/**/project.json', '{workspaceRoot}/architecture/dependencies.json'],
            metadata: {
                technologies: ['nx'],
                description: 'Validate the architecture has no circular project dependencies',
            },
        };
    }

    noSkipLevel(): TargetConfiguration {
        return {
            executor: '@webpieces/nx-webpieces-rules:validate-no-skiplevel-deps',
            cache: true,
            inputs: ['{workspaceRoot}/**/project.json', '{workspaceRoot}/architecture/dependencies.json'],
            metadata: {
                technologies: ['nx'],
                description: 'Validate no project has redundant transitive dependencies',
            },
        };
    }

    packageJson(): TargetConfiguration {
        return {
            executor: '@webpieces/nx-webpieces-rules:validate-packagejson',
            cache: true,
            inputs: ['{workspaceRoot}/**/project.json', '{workspaceRoot}/**/package.json'],
            metadata: {
                technologies: ['nx'],
                description: 'Validate package.json dependencies match project.json build dependencies',
            },
        };
    }

    /**
     * Combined validate-code target. Options come from webpieces.config.json at the
     * workspace root (loaded by the executor via @webpieces/rules-config — the same
     * source of truth as @webpieces/ai-hook-rules).
     */
    code(): TargetConfiguration {
        return {
            executor: '@webpieces/nx-webpieces-rules:validate-code',
            cache: false, // Don't cache - depends on git state
            inputs: ['default', '{workspaceRoot}/webpieces.config.json', {'runtime': 'node -e "process.stdout.write(String(Math.random()))"'}],
            metadata: {
                technologies: ['nx'],
                description: 'Combined validation for new methods, modified methods, and file sizes',
            },
        };
    }

    versionsLocked(): TargetConfiguration {
        return {
            executor: '@webpieces/nx-webpieces-rules:validate-versions-locked',
            cache: true,
            inputs: ['{workspaceRoot}/**/package.json'],
            metadata: {
                technologies: ['nx'],
                description:
                    'Validate package.json versions are locked (no semver ranges) and consistent across projects',
            },
        };
    }

    tsInSrc(): TargetConfiguration {
        return {
            executor: '@webpieces/nx-webpieces-rules:validate-ts-in-src',
            cache: false,
            inputs: ['default', '{workspaceRoot}/webpieces.config.json', {'runtime': 'node -e "process.stdout.write(String(Math.random()))"'}],
            metadata: {
                technologies: ['nx'],
                description: 'Validate all .ts files in projects are inside the src/ directory',
            },
        };
    }

    nxWiring(): TargetConfiguration {
        return {
            executor: '@webpieces/nx-webpieces-rules:validate-nx-wiring',
            cache: false, // Cheap; depends on nx.json + project graph, not worth caching
            inputs: ['{workspaceRoot}/nx.json'],
            metadata: {
                technologies: ['nx'],
                description: 'Validate the webpieces validators are wired into the build via nx.json dependsOn',
            },
        };
    }

    /**
     * Validate every server/client api-lib dependency is implemented or used. Scans
     * source (addRoutes = implements, createRpcClient/createPubSubClient = uses), so
     * it depends on all source + project.json, not just the committed graph.
     */
    apiRelations(): TargetConfiguration {
        return {
            executor: '@webpieces/nx-webpieces-rules:validate-api-relations',
            cache: false,
            inputs: ['default', '{workspaceRoot}/**/project.json'],
            metadata: {
                technologies: ['nx'],
                description: 'Validate every server/client api-lib dependency is implemented or used',
            },
        };
    }

    /** Validate role:api-lib ⇔ the project exports an @ApiPath/@Rpc/@PubSub contract, both directions. */
    apiLibTag(): TargetConfiguration {
        return {
            executor: '@webpieces/nx-webpieces-rules:validate-api-lib-tag',
            cache: false,
            inputs: ['default', '{workspaceRoot}/**/project.json'],
            metadata: {
                technologies: ['nx'],
                description: 'Validate role:api-lib matches the code (exports an API contract)',
            },
        };
    }
}
