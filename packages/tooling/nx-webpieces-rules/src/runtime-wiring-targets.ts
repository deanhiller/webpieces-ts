import type { TargetConfiguration } from '@nx/devkit';
import { Option, RuleFailError } from '@webpieces/rules-config';
import type { RawProjectJson } from './generate-targets';

/** Opt-in ownership tags are the migration boundary; no broad source enforcement activates silently. */
export class RuntimeWiringTargets {
    infer(project: RawProjectJson): Record<string, TargetConfiguration> {
        if (!project.tags.includes('webpieces') && !project.tags.includes('webpieces-lib'))
            return {};
        const options = project.targets['build']?.options;
        const outputPath =
            options !== undefined && 'outputPath' in options ? options.outputPath : undefined;
        if (typeof outputPath !== 'string' || outputPath.length === 0)
            throw new RuleFailError(
                'validate-runtime-architecture',
                `${project.name} must declare build.options.outputPath for runtime wiring candidates.`,
                undefined,
                undefined,
                [
                    new Option(
                        'Declare the existing project build output directory explicitly; runtime wiring never writes candidates beside approvals.',
                        true,
                    ),
                ],
            );
        return {
            build: {
                ...project.targets['build'],
                dependsOn: [...this.buildDependencies(project), 'runtime-wiring-check'],
            },
            'runtime-wiring-check': {
                executor: '@webpieces/nx-webpieces-rules:runtime-wiring-check',
                cache: true,
                inputs: [
                    'default',
                    '{projectRoot}/runtime-deps.json',
                    '{workspaceRoot}/packages/tooling/nx-webpieces-rules/src/**/*.ts',
                    '^default',
                    '{workspaceRoot}/webpieces.config.json',
                    '{workspaceRoot}/tsconfig.base.json',
                    '{workspaceRoot}/nx.json',
                    { externalDependencies: ['@webpieces/nx-webpieces-rules'] },
                ],
                outputs: [`{workspaceRoot}/${outputPath}/runtime-deps.candidate.json`],
                options: { outputPath },
            },
        };
    }
    private buildDependencies(
        project: RawProjectJson,
    ): NonNullable<TargetConfiguration['dependsOn']> {
        return (project.targets['build']?.dependsOn ?? []).map((dependency) => {
            if (typeof dependency === 'string') return dependency;
            if (dependency.target === undefined)
                throw new RuleFailError(
                    'validate-runtime-architecture',
                    `${project.name}: build dependency requires a target.`,
                    undefined,
                    undefined,
                    [new Option('Declare a target on each build dependsOn entry.', true)],
                );
            return {
                ...dependency,
                target: dependency.target,
                projects:
                    typeof dependency.projects === 'string'
                        ? dependency.projects
                        : dependency.projects === undefined
                          ? undefined
                          : [...dependency.projects],
            };
        });
    }
}
