import * as fs from 'fs';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';
import { Option, RuleFailError } from '@webpieces/rules-config';
import type { ApiContracts, ExternalSystemDecls } from './api-relations';
import type { ProjectInfo } from '../project-info';
import { ApiContractFiles } from '../api-contract-files';
import { loadBlessedGraph } from '../graph-loader';

/** Source-sensitive build proof; graph generation reads these approvals without extracting source. */
export class ApiContractApproval {
    verify(
        workspaceRoot: string,
        infos: ReadonlyMap<string, ProjectInfo>,
        contracts: ApiContracts,
        systems: ExternalSystemDecls,
    ): void {
        const owners = new Set(Object.values(contracts).map((contract) => contract.owner));
        const candidates: string[] = [];
        for (const owner of owners) {
            const info = infos.get(owner);
            if (info === undefined)
                this.fail(`Missing owning project ${owner} for API contract proof.`);
            const project = JSON.parse(
                fs.readFileSync(path.join(workspaceRoot, info!.root, 'project.json'), 'utf8'),
            ) as ProjectBuildOutput;
            const outputPath = project.targets?.build?.options?.outputPath;
            if (typeof outputPath !== 'string' || outputPath.length === 0)
                this.fail(
                    `${owner} must declare its build.options.outputPath for contract candidates.`,
                );
            const own = Object.fromEntries(
                Object.entries(contracts).filter((entry) => entry[1].owner === owner),
            );
            const result = new ApiContractFiles().write(
                workspaceRoot,
                `${outputPath}/runtime-contracts.candidate.json`,
                own,
            );
            candidates.push(...result.written);
            fs.writeFileSync(
                path.join(workspaceRoot, outputPath, 'external-systems.candidate.json'),
                JSON.stringify(systems, null, 4) + '\n',
            );
        }
        const saved = loadBlessedGraph(workspaceRoot);
        if (saved === null)
            this.fail(
                'Missing saved API contract references; create reviewed contract declarations before graph generation.',
            );
        const expected = new ApiContractFiles().load(
            workspaceRoot,
            'architecture/dependencies.json',
            saved!.apiContractFiles,
        );
        if (
            !isDeepStrictEqual(
                JSON.parse(JSON.stringify(expected)),
                JSON.parse(JSON.stringify(contracts)),
            ) ||
            !isDeepStrictEqual(
                JSON.parse(JSON.stringify(saved!.externalSystems)),
                JSON.parse(JSON.stringify(systems)),
            )
        )
            this.fail(
                `Current API/DTO contracts or external declarations differ from reviewed graph metadata. Candidates:\n${candidates.join('\n')}\nReview each owning contract's candidate and explicitly update architecture/apis and contract references; generation never extracts source or approves changes.`,
            );
    }

    private fail(message: string): never {
        throw new RuleFailError('validate-runtime-architecture', message, undefined, undefined, [
            new Option(
                'Review the owning project output candidates, correct source defects, and explicitly update the approved API metadata before generation.',
                true,
            ),
        ]);
    }
}

class ProjectBuildOutput {
    constructor(public readonly targets?: { build?: { options?: { outputPath?: string } } }) {}
}
