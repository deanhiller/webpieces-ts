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
                // PER-PROJECT inputs only (#1263). nx turns every `{workspaceRoot}/...` input of a
                // target into an implicit dependency of the project that carries it
                // (getImplicitlyTouchedProjects), so a workspace-wide glob here made ONE service's
                // wiring.ts change mark EVERY webpieces-tagged project affected. The check reads only
                // this project's src/wiring.ts, its runtime-deps.json, its project.json and the files
                // its own TS program imports (its graph dependencies -> ^default). The cross-service
                // half (assembling every runtime-deps.json, callers vs callees) already runs ONCE,
                // uncached, in architecture:validate-architecture-unchanged (ApprovedWiringGraph).
                // tsconfig.base.json is hashed into every task by nx itself (path mappings selectively)
                // and handled by its own affected locator, so naming it here only widened `affected`.
                inputs: [
                    'default',
                    '{projectRoot}/src/wiring.ts',
                    '{projectRoot}/runtime-deps.json',
                    '^default',
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
