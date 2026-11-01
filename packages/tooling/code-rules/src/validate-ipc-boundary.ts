/**
 * `ipc-boundary` at the build gate (#1389) — see {@link IpcBoundaryAnalyzer} for what it refuses and
 * `IpcBoundaryConfig` for its settings. Per FILE: NEW_AND_MODIFIED_FILES judges each changed production
 * TypeScript file whole, MODIFIED_PROJECTS every file of a touched project, RUN_EVERY_TIME every file.
 * Each file is parsed alone; no `ts.Program` is built.
 */

import * as ts from 'typescript';
import { DiffScope } from '@webpieces/rules-config';
import { InformAiError } from '@webpieces/tooling-common';
import { injectable, bindingScopeValues } from 'inversify';
import { IpcBoundaryConfig } from './configs/ipc-configs';
import { CodeValidator, ExecutorResult } from './code-validator';
import { ProjectCatalog, ScanScope } from './scan-scope';
import { IpcBoundaryAnalyzer, IpcBoundaryPolicy } from './ipc/ipc-boundary-analyzer';
import { IpcRuleSupport } from './ipc/ipc-rule-support';
import { IpcCompilerOptionsReader, IpcFileReader, IpcFinding, IpcModuleResolver, IpcSourceFile } from './ipc/ipc-source';

const RULE = 'ipc-boundary';

@injectable(bindingScopeValues.Singleton)
export class IpcBoundaryValidator extends CodeValidator<IpcBoundaryConfig> {
    private readonly support: IpcRuleSupport;

    constructor(
        config: IpcBoundaryConfig,
        private readonly diffScope: DiffScope,
        private readonly scanScope: ScanScope,
        catalog: ProjectCatalog,
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
        const files = (await this.scanScope.files(workspaceRoot, mode, range.base, range.head))
            .filter((rel: string) => this.support.isProductionSource(rel) && reader.exists(rel));
        if (files.length === 0) return { success: true };
        const options = new IpcCompilerOptionsReader().read(workspaceRoot, this.config.tsconfigPath);
        const analyzer = new IpcBoundaryAnalyzer(
            new IpcBoundaryPolicy(this.config, this.legacyNames(reader)),
            new IpcModuleResolver(workspaceRoot, options),
        );
        const findings: IpcFinding[] = [];
        for (const rel of files) {
            const file = reader.parse(rel);
            if (file !== undefined) findings.push(...analyzer.analyze(file));
        }
        if (findings.length === 0) return { success: true };
        this.scanScope.recordSites(RULE, findings.map((each: IpcFinding) => each.relFile));
        throw this.support.failure(
            RULE,
            'raw IPC, the ipc-bridge factories and WebView delivery belong only to the registered transport / ' +
                'composition / bootstrap modules (see the rule\'s config); feature code injects the generated shared API.',
            findings,
        );
    }

    /** The exported constants of `legacyWireFile` — the legacy raw wire names. */
    private legacyNames(reader: IpcFileReader): Set<string> {
        const legacyFile = this.config.legacyWireFile;
        if (legacyFile === null) return new Set<string>();
        const file = reader.read(legacyFile);
        if (file === undefined) {
            throw new InformAiError(
                `${RULE}: legacyWireFile "${legacyFile}" does not exist. Point it at the file declaring the legacy ` +
                    'wire constants, or set it to null.',
            );
        }
        return this.exportedConstants(file);
    }

    private exportedConstants(file: IpcSourceFile): Set<string> {
        const names = new Set<string>();
        for (const statement of file.source.statements) {
            if (!ts.isVariableStatement(statement)) continue;
            const exported = statement.modifiers?.some((modifier: ts.ModifierLike) => modifier.kind === ts.SyntaxKind.ExportKeyword);
            if (exported !== true) continue;
            for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
            }
        }
        return names;
    }
}
