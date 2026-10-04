import * as fs from 'fs';
import * as path from 'path';
import { Option, RuleFailError } from '@webpieces/rules-config';
import { RuntimeDeclarationCodec } from './codec';
import { RuntimeWiringAssembler } from './assembler';
import type { RuntimeDeclaration } from './declaration';
import type { EnhancedGraph } from '../graph-sorter';
import type { ProjectInfo } from '../project-info';
import type { ApiRef, ProjectApiRelations } from '../api-usage/api-relations';
import { loadBlessedGraph, DEFAULT_GRAPH_PATH } from '../graph-loader';
import { ApiContractFiles } from '../api-contract-files';

/** Assembly consumes approvals only. Source verification is a separate per-project build target. */
export class ApprovedWiringGraph {
    attach(
        workspaceRoot: string,
        graph: EnhancedGraph,
        infos: ReadonlyMap<string, ProjectInfo>,
        graphPath: string = DEFAULT_GRAPH_PATH,
    ): void {
        const previous = loadBlessedGraph(workspaceRoot, graphPath);
        if (previous === null)
            this.fail(
                'Missing saved graph. Complete the runtime declaration migration before generating architecture.',
            );
        const declarations = new Map<string, RuntimeDeclaration>();
        for (const project of infos) {
            const name = project[0];
            const info = project[1];
            const tagged = info.tags.includes('webpieces') || info.tags.includes('webpieces-lib');
            const existingRelations = previous.projects[name]?.apiRelations;
            if (!tagged && existingRelations !== undefined)
                this.fail(
                    `${name} has saved runtime facts but is untagged. Migrate it before using declaration-only generation.`,
                );
            if (!tagged) continue;
            const file = path.join(workspaceRoot, info.root, 'runtime-deps.json');
            if (!fs.existsSync(file)) this.fail(`Missing approved declaration ${file}.`);
            declarations.set(
                name,
                new RuntimeDeclarationCodec().decode(fs.readFileSync(file, 'utf8'), name),
            );
            graph[name].runtimeDeclaration = `${info.root}/runtime-deps.json`;
        }
        const assembler = new RuntimeWiringAssembler(declarations);
        for (const project of declarations) {
            const name = project[0];
            const declaration = project[1];
            if (declaration.entry === undefined) continue;
            const entry = graph[name];
            if (declaration.host !== undefined && entry.serviceName !== declaration.host)
                this.fail(
                    `${name}: plan host ${declaration.host} disagrees with project serviceName ${entry.serviceName}.`,
                );
            const relations: ProjectApiRelations = {};
            for (const resolved of assembler.assemble(name)) {
                const relation = relations[resolved.owner] ?? {
                    kind: 'uses',
                    implements: [],
                    uses: [],
                };
                const ref: ApiRef = { api: resolved.api, type: resolved.transport };
                if (resolved.conditional !== undefined) ref.conditional = resolved.conditional;
                if (!resolved.via.startsWith(`${name}#`)) ref.declaredVia = resolved.via;
                if (resolved.target?.kind === 'service')
                    ref.targetService = resolved.target.service;
                if (resolved.transport === 'pubsub' && resolved.direction === 'uses')
                    ref.methodsInferred = true;
                relation[resolved.direction].push(ref);
                relation.kind =
                    relation.implements.length === 0
                        ? 'uses'
                        : relation.uses.length === 0
                          ? 'implements'
                          : 'uses-implements';
                relations[resolved.owner] = relation;
            }
            entry.apiRelations = relations;
            entry.runtimeComposition = true;
        }
        this.validateTargets(workspaceRoot, graphPath, graph);
    }

    private validateTargets(workspaceRoot: string, graphPath: string, graph: EnhancedGraph): void {
        const hosts = new Map<string, string>();
        for (const [name, entry] of Object.entries(graph)) {
            if (entry.serviceName === undefined) continue;
            if (hosts.has(entry.serviceName))
                this.fail(
                    `Duplicate service identity ${entry.serviceName}: ${hosts.get(entry.serviceName)} and ${name}.`,
                );
            hosts.set(entry.serviceName, name);
        }
        const saved = loadBlessedGraph(workspaceRoot, graphPath);
        if (saved === null)
            this.fail('Missing saved contract references for approved runtime wiring.');
        const contracts = new ApiContractFiles().load(
            workspaceRoot,
            graphPath,
            saved.apiContractFiles,
        );
        for (const [name, entry] of Object.entries(graph))
            for (const [owner, relation] of Object.entries(entry.apiRelations ?? {})) {
                for (const ref of [...relation.implements, ...relation.uses]) {
                    if (
                        ref.type !== 'external' &&
                        (contracts[ref.api]?.owner !== owner ||
                            contracts[ref.api]?.apiKind !== ref.type)
                    )
                        this.fail(`${name}: unknown qualified contract ${owner}#${ref.api}.`);
                }
                for (const ref of relation.uses) {
                    if (ref.targetService === undefined) continue;
                    if (
                        Object.values(saved!.externalSystems).some((system) =>
                            system.apis.includes(ref.api),
                        )
                    )
                        continue;
                    const provider = hosts.get(ref.targetService);
                    const implemented =
                        provider === undefined
                            ? undefined
                            : graph[provider].apiRelations?.[owner]?.implements;
                    if (!implemented?.some((api) => api.api === ref.api && api.type === ref.type))
                        this.fail(
                            `${name}: target ${ref.targetService} does not implement ${owner}#${ref.api} (${ref.type}).`,
                        );
                }
            }
    }

    private fail(message: string): never {
        throw new RuleFailError('validate-runtime-architecture', message, undefined, undefined, [
            new Option(
                'Migrate canonical src/wiring.ts, tag owners webpieces/webpieces-lib, and review runtime-deps.json candidates before generation. Saved visualizations remain available.',
                true,
            ),
        ]);
    }
}
