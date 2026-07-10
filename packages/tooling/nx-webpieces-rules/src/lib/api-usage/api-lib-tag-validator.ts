/**
 * API-lib tag validator (two-way)
 *
 * Keeps the `role:api-lib` tag and the CODE in sync, both directions:
 *   - a project tagged `role:api-lib` MUST export ≥1 API contract (an `abstract class` carrying
 *     `@ApiPath`/`@Rpc`/`@PubSub`) — else the tag is a lie;
 *   - a project that DOES export such a contract MUST be tagged `role:api-lib` — else the arch
 *     graph, the edge line-styles, and validate-api-relations can't treat it as an api-lib.
 *
 * "Exports an API contract" is answered by the same source scan that owns apiRelations
 * (scan.apiLibProjects), so the tag can never drift from the code.
 */

import { ProjectInfo } from '../project-info';
import { resolveRole } from '../role-resolver';
import { ApiScanResult } from './api-scanner';

const API_LIB_ROLE = 'api-lib';

/**
 * A tag/code mismatch:
 *  - 'missing-tag'     — exports an API contract but is not tagged role:api-lib.
 *  - 'unnecessary-tag' — tagged role:api-lib but exports no API contract.
 */
export interface ApiLibTagViolation {
    project: string;
    kind: 'missing-tag' | 'unnecessary-tag';
}

/** Both-directions tag ⇔ code check. Uses the scan's detected api-lib set as ground truth. */
// webpieces-disable no-function-outside-class -- validator-lib entry point, matches api-relations-validator.ts
export function findApiLibTagViolations(
    projectInfos: Map<string, ProjectInfo>,
    scan: ApiScanResult,
): ApiLibTagViolation[] {
    const violations: ApiLibTagViolation[] = [];
    for (const projectName of projectInfos.keys()) {
        const info = projectInfos.get(projectName)!;
        const isTagged = resolveRole(info).role === API_LIB_ROLE;
        const exportsApi = scan.apiLibProjects.has(projectName);

        if (exportsApi && !isTagged) {
            violations.push({ project: projectName, kind: 'missing-tag' });
        }
        // Only flag an unnecessary tag when we actually SCANNED the project's source — otherwise we
        // can't prove it exports no contract (an unscannable project would falsely look empty).
        if (isTagged && !exportsApi && scan.scannedProjects.has(projectName)) {
            violations.push({ project: projectName, kind: 'unnecessary-tag' });
        }
    }
    return violations.sort((a: ApiLibTagViolation, b: ApiLibTagViolation) => a.project.localeCompare(b.project));
}

/** Human-readable, fix-oriented report for one tag/code mismatch. */
// webpieces-disable no-function-outside-class -- pure formatter, matches api-relations-validator.ts
export function describeApiLibTagViolation(violation: ApiLibTagViolation): string {
    if (violation.kind === 'missing-tag') {
        return (
            `  ❌ '${violation.project}' exports an API contract (an abstract @ApiPath/@Rpc/@PubSub class) ` +
            `but is not tagged 'role:api-lib'.\n` +
            `     Add "role:api-lib" to its project.json "tags" (replacing any "role:lib").`
        );
    }
    return (
        `  ❌ '${violation.project}' is tagged 'role:api-lib' but exports NO API contract ` +
        `(no abstract @ApiPath/@Rpc/@PubSub class).\n` +
        `     Either add the API contract it should own, or retag it (e.g. "role:lib").`
    );
}
