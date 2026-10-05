// Upstream exercises its unreleased wiring/graph implementation before npm publication.
// Keep the installed plugin's complete task graph; only redirect implementations and add a check.
const installed = require('@webpieces/nx-webpieces-rules');
const redirected = new Set(['runtime-wiring-check', 'di-graph-generate', 'generate', 'validate-architecture-unchanged', 'validate-api-relations', 'validate-code']);
class WiringSourceTargets {
    apply(results) {
        for (const [, result] of results) {
            for (const project of Object.values(result.projects || {})) {
                for (const [name, target] of Object.entries(project.targets || {})) {
                    if (!redirected.has(name) || !target.executor?.startsWith('@webpieces/nx-webpieces-rules:')) continue;
                    target.executor = target.executor.replace('@webpieces/nx-webpieces-rules:', '@webpieces/nx-source:');
                    if (target.inputs) target.inputs.push('{workspaceRoot}/packages/tooling/nx-webpieces-rules/src/**/*.ts');
                }
                if (project.name === 'architecture') {
                    project.targets['validate-complete'].dependsOn.push('wiring-format-source');
                }
            }
        }
        return results;
    }
}
exports.name = 'upstream-wiring-source-targets';
exports.createNodesV2 = [installed.createNodesV2[0], async (files, options, context) =>
    new WiringSourceTargets().apply(await installed.createNodesV2[1](files, options, context))];
