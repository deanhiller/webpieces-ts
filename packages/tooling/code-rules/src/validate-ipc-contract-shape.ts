/**
 * `ipc-contract-shape` at the build gate (#1389) — see {@link IpcContractShapeAnalyzer} for what it
 * refuses. Per FILE, over the `contractPaths` files the mode selects; each file is parsed alone. The
 * project owning a judged contract file must also carry every `requiredProjectTags` tag.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DiffScope, matchesAnyGlob } from '@webpieces/rules-config';
import { InformAiError } from '@webpieces/tooling-common';
import { toError } from '@webpieces/tooling-common/to-error';
import { injectable, bindingScopeValues } from 'inversify';
import { IpcContractShapeConfig } from './configs/ipc-configs';
import { CodeValidator, ExecutorResult } from './code-validator';
import { ProjectCatalog, ProjectEntry, ScanScope } from './scan-scope';
import { IpcContractShapeAnalyzer } from './ipc/ipc-contract-shape-analyzer';
import { IpcRuleSupport } from './ipc/ipc-rule-support';
import { IpcCompilerOptionsReader, IpcFileReader, IpcFinding, IpcModuleResolver } from './ipc/ipc-source';

const RULE = 'ipc-contract-shape';

/** The only field of a project.json this reads. */
type RawProjectTags = { tags?: string[] };

@injectable(bindingScopeValues.Singleton)
export class IpcContractShapeValidator extends CodeValidator<IpcContractShapeConfig> {
    private readonly support: IpcRuleSupport;

    constructor(
        config: IpcContractShapeConfig,
        private readonly diffScope: DiffScope,
        private readonly scanScope: ScanScope,
        private readonly catalog: ProjectCatalog,
    ) {
        super(config, RULE, RULE);
        this.support = new IpcRuleSupport(diffScope, catalog);
    }

    async run(workspaceRoot: string): Promise<ExecutorResult> {
        const mode = this.config.mode;
        if (mode === undefined || mode === 'OFF') return { success: true };
        const range = await this.diffScope.resolveBase(workspaceRoot);
        if (range.base === undefined) {
            console.log(`\n⏭️  Skipping ${RULE} validation (could not detect base branch)\n`);
            return { success: true };
        }
        const reader = new IpcFileReader(workspaceRoot);
        const files = (await this.scanScope.files(workspaceRoot, mode, range.base, range.head)).filter(
            (rel: string) =>
                this.support.isProductionSource(rel) && matchesAnyGlob(rel, this.config.contractPaths) && reader.exists(rel),
        );
        if (files.length === 0) return { success: true };
        const options = new IpcCompilerOptionsReader().read(workspaceRoot, this.config.tsconfigPath);
        const analyzer = new IpcContractShapeAnalyzer(this.config, new IpcModuleResolver(workspaceRoot, options));
        const findings: IpcFinding[] = [...(await this.judgeTags(workspaceRoot, files))];
        for (const rel of files) {
            const file = reader.parse(rel);
            if (file !== undefined) findings.push(...analyzer.analyze(file));
        }
        if (findings.length === 0) return { success: true };
        this.scanScope.recordSites(RULE, findings.map((each: IpcFinding) => each.relFile));
        throw this.support.failure(
            RULE,
            'a shared IPC contract is abstract directional APIs, named DTOs and explicit @WpInternal / ' +
                '@WpIpcEndpoint / @MaskLog metadata — nothing host-, factory- or endpoint-specific.',
            findings,
        );
    }

    /** One finding per owning project missing a required tag. */
    private async judgeTags(workspaceRoot: string, files: readonly string[]): Promise<IpcFinding[]> {
        const required = this.config.requiredProjectTags;
        if (required.length === 0) return [];
        const owners = new Map<string, ProjectEntry>();
        for (const rel of files) {
            const owner = await this.catalog.ownerOf(workspaceRoot, rel);
            if (owner !== undefined) owners.set(owner.dir, owner);
        }
        const out: IpcFinding[] = [];
        for (const owner of owners.values()) {
            const projectJson = owner.dir === '' ? 'project.json' : `${owner.dir}/project.json`;
            const tags = this.tagsOf(path.join(workspaceRoot, projectJson));
            const missing = required.filter((tag: string) => !tags.includes(tag));
            if (missing.length === 0) continue;
            out.push(new IpcFinding(
                projectJson,
                1,
                `tags: [${tags.map((tag: string) => JSON.stringify(tag)).join(', ')}]`,
                `The shared IPC library ${owner.name} must carry ${required.join(', ')} (missing ${missing.join(', ')}).`,
            ));
        }
        return out;
    }

    private tagsOf(absFile: string): string[] {
        // webpieces-disable no-unmanaged-exceptions -- add the exact project.json path while preserving the parse/read failure as cause
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const parsed = JSON.parse(fs.readFileSync(absFile, 'utf-8')) as RawProjectTags;
            return Array.isArray(parsed.tags) ? parsed.tags.filter((tag: string) => typeof tag === 'string') : [];
        } catch (err: unknown) {
            const error = toError(err);
            throw new InformAiError(`${RULE}: cannot read tags from ${absFile} — fix project.json and retry.`, { cause: error });
        }
    }
}
