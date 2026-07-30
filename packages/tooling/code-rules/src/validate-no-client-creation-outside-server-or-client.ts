/**
 * Validate No Client Creation Outside Server Or Client
 *
 * Flags a project that CONSTRUCTS an rpc/pubsub transport client when the project's `role:` tag is
 * not one of the runnable/entrypoint roles (`allowedRoles`, default server | client | app).
 *
 * ============================================================================
 * WHY
 * ============================================================================
 * The runtime architecture graph draws a `uses` edge from every client-creation site to the api's
 * implementer. When the site sits in a project with a declared identity (`serviceName`) or target
 * (`callsService`) — a server, a client app, an app — the edge is attributable. When it sits in a
 * `role:lib`, the target can't be attributed, so the graph falls back to a fan-out: one `uses` edge
 * to EVERY implementer of the api, i.e. calls that cannot happen. A company-wide api (warmup,
 * browser-log, auth) then draws every caller to every server — pure fiction. This rule removes the
 * failure mode by construction: a reusable library takes the api INJECTED; the server/app module
 * binds it to a client.
 *
 * ============================================================================
 * VIOLATIONS (BAD) — flagged when the OWNING project's role is not in allowedRoles:
 * ============================================================================
 *   factory.createRpcClient(SomeApi, new ClientConfig('svc'))
 *   clientCloudTasksFactory.createPubSubClient(SomeApi, config)
 *
 * ============================================================================
 * ALLOWED
 * ============================================================================
 * - Any site in a project whose role IS in allowedRoles (server / client / app).
 * - A project with NO `role:` tag (the role-tag rule owns "every project must declare a role").
 * - Merely IMPORTING the api type or its DI token, or injecting the api — only constructing the
 *   transport (a `.createRpcClient(` / `.createPubSubClient(` CALL) is a violation.
 * - Files under allowedPaths, test files, and lines carrying the webpieces-disable escape.
 *
 * ============================================================================
 * SEVERITY (WARN first, then error)
 * ============================================================================
 * severity "warn" (default) prints the violations + migration but PASSES the build, so an upgrade
 * can't break an un-migrated Angular repo. Flip to "error" once libraries are migrated.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    hasDisable,
    RULE_NAMES,
    isPathExcluded,
    NoClientCreationOutsideServerOrClientConfig,
    ClientCreationSeverity,
    ModifiedCodeMode,
    detectBase,
    getChangedFiles,
    getFileDiff,
    getChangedLineNumbers,
} from '@webpieces/rules-config';
import { CodeValidator, ExecutorResult } from './code-validator';
import { injectable, bindingScopeValues } from 'inversify';
import { shouldSkipRule } from './resolve-mode';
import { ProjectRoleResolver } from './project-role-resolver';

const RULE_NAME = RULE_NAMES.NO_CLIENT_CREATION_OUTSIDE_SERVER_OR_CLIENT;
const DEFAULT_ALLOWED_ROLES = ['server', 'client', 'app'];
// A `.createRpcClient(` / `.createPubSubClient(` method CALL — the leading dot excludes the framework
// method DEFINITIONS (`createRpcClient<T>(apiPrototype, ...)`, no receiver); the `[(<]` requires a call
// or a generic call, so a bare property reference isn't matched.
const CLIENT_CREATE_REGEX = /\.(createRpcClient|createPubSubClient)\s*[(<]/;

/** One client-creation call site found in a file. */
class CreationSite {
    constructor(
        public readonly line: number,
        public readonly context: string,
        public readonly hasDisableComment: boolean,
    ) {}
}

/** A reported violation: a client-creation site in a project whose role is not allowed. */
class Violation {
    constructor(
        public readonly file: string,
        public readonly line: number,
        public readonly context: string,
        public readonly role: string,
    ) {}
}

@injectable(bindingScopeValues.Singleton)
export class NoClientCreationOutsideServerOrClientValidator extends CodeValidator<NoClientCreationOutsideServerOrClientConfig> {
    constructor(
        config: NoClientCreationOutsideServerOrClientConfig,
        private readonly roleResolver: ProjectRoleResolver,
    ) {
        super(config, RULE_NAME);
    }

    async run(workspaceRoot: string): Promise<ExecutorResult> {
        const mode = this.resolveMode(this.config.mode ?? 'OFF');
        if (mode === 'OFF') {
            console.log(`\n⏭️  Skipping ${RULE_NAME} validation (mode: OFF)`);
            console.log('');
            return { success: true };
        }

        const severity: ClientCreationSeverity = this.config.severity ?? 'warn';
        console.log(`\n📏 Validating No Client Creation Outside Server Or Client\n`);
        console.log(`   Mode: ${mode} · Severity: ${severity}`);

        const base = this.resolveBase(workspaceRoot);
        if (base === null) return { success: true };
        const head = process.env['NX_HEAD'];

        console.log(`   Base: ${base}`);
        console.log(`   Head: ${head ?? 'working tree (includes uncommitted changes)'}`);
        console.log('');

        const changedFiles = getChangedFiles(workspaceRoot, base, head);
        if (changedFiles.length === 0) {
            console.log('✅ No TypeScript files changed');
            return { success: true };
        }

        console.log(`📂 Checking ${changedFiles.length} changed file(s)...`);
        const violations = this.findViolations(workspaceRoot, changedFiles, mode, base, head);

        if (violations.length === 0) {
            console.log('✅ No client-creation-in-a-library violations found');
            return { success: true };
        }

        this.report(violations, severity);
        // WARN reports but passes; only "error" fails the build.
        return { success: severity !== 'error' };
    }

    private allowedRoles(): string[] {
        const configured = this.config.allowedRoles;
        return configured && configured.length > 0 ? configured : DEFAULT_ALLOWED_ROLES;
    }

    private disableAllowed(): boolean {
        return this.config.disableAllowed ?? true;
    }

    private allowedPaths(): string[] {
        return this.config.allowedPaths ?? [];
    }

    private resolveMode(normalMode: ModifiedCodeMode): ModifiedCodeMode {
        if (normalMode === 'OFF') return normalMode;
        const skip = shouldSkipRule(this.config.turnOffRuleUntilEpoch, this.config.turnOffRuleWhileOnBranch);
        if (skip.skip) {
            console.log(`\n⏭️  Skipping ${RULE_NAME} validation (${skip.reason})`);
            console.log('');
            return 'OFF';
        }
        return normalMode;
    }

    private resolveBase(workspaceRoot: string): string | null {
        const envBase = process.env['NX_BASE'];
        if (envBase) return envBase;
        const detected = detectBase(workspaceRoot);
        if (!detected) {
            console.log(`\n⏭️  Skipping ${RULE_NAME} validation (could not detect base branch)`);
            console.log('');
            return null;
        }
        return detected;
    }

    /** Violations across changed files: a creation site in a project whose role is not allowed. In
     *  NEW_AND_MODIFIED_CODE only sites on changed lines count; in NEW_AND_MODIFIED_FILES every site
     *  in a changed file counts. */
    private findViolations(
        workspaceRoot: string,
        changedFiles: string[],
        mode: ModifiedCodeMode,
        base: string,
        head: string | undefined,
    ): Violation[] {
        const allowed = new Set(this.allowedRoles());
        const violations: Violation[] = [];
        for (const file of changedFiles) {
            if (this.isExempt(file)) continue;

            const role = this.roleResolver.roleOf(workspaceRoot, file);
            // No role tag → role-tag rule owns it; an allowed role → fine. Either way, skip.
            if (role === null || allowed.has(role)) continue;

            const changedLines = mode === 'NEW_AND_MODIFIED_CODE'
                ? getChangedLineNumbers(getFileDiff(workspaceRoot, file, base, head))
                : null;
            if (changedLines !== null && changedLines.size === 0) continue;

            for (const site of this.scanFile(workspaceRoot, file)) {
                if (this.disableAllowed() && site.hasDisableComment) continue;
                if (changedLines !== null && !changedLines.has(site.line)) continue;
                violations.push(new Violation(file, site.line, site.context, role));
            }
        }
        return violations;
    }

    private isExempt(file: string): boolean {
        return this.isTestFile(file) || isPathExcluded(file, this.allowedPaths());
    }

    private isTestFile(filePath: string): boolean {
        return filePath.includes('.spec.ts') || filePath.includes('.test.ts') || filePath.includes('__tests__/');
    }

    /** Every client-creation call site in a file, ignoring occurrences inside comments. */
    private scanFile(workspaceRoot: string, relFile: string): CreationSite[] {
        const fullPath = path.join(workspaceRoot, relFile);
        if (!fs.existsSync(fullPath)) return [];
        const lines = fs.readFileSync(fullPath, 'utf-8').split('\n');
        const code = this.stripComments(lines);

        const sites: CreationSite[] = [];
        for (let i = 0; i < code.length; i++) {
            if (!CLIENT_CREATE_REGEX.test(code[i] ?? '')) continue;
            const raw = lines[i] ?? '';
            const prev = i > 0 ? (lines[i - 1] ?? '') : '';
            const disabled = hasDisable(raw, RULE_NAME) || hasDisable(prev, RULE_NAME);
            sites.push(new CreationSite(i + 1, raw.trim(), disabled));
        }
        return sites;
    }

    /** The code-only text of each line: block comments (/* … *\/) and line comments (// …) blanked
     *  out, so a `factory.createRpcClient(` in a JSDoc example is never matched. */
    private stripComments(lines: string[]): string[] {
        const out: string[] = [];
        let inBlock = false;
        for (const line of lines) {
            let result = '';
            let i = 0;
            while (i < line.length) {
                if (inBlock) {
                    if (line[i] === '*' && line[i + 1] === '/') { inBlock = false; i += 2; } else { i += 1; }
                    continue;
                }
                if (line[i] === '/' && line[i + 1] === '*') { inBlock = true; i += 2; continue; }
                if (line[i] === '/' && line[i + 1] === '/') break;
                result += line[i];
                i += 1;
            }
            out.push(result);
        }
        return out;
    }

    // webpieces-disable max-lines-new-methods -- console guidance block + violation list
    private report(violations: Violation[], severity: ClientCreationSeverity): void {
        const icon = severity === 'error' ? '❌' : '⚠️';
        console.error('');
        console.error(`${icon} A library (role:lib) must NOT construct an rpc/pubsub client!`);
        console.error('');
        console.error('   Only a runnable entrypoint (role:server / role:client / role:app) has a declared identity');
        console.error('   (serviceName) or target (callsService), so a client built there is attributable in the');
        console.error('   runtime graph. A client built in a library reaches the fan-out fallback — one "uses" edge');
        console.error('   to EVERY implementer of the api, i.e. calls that cannot happen.');
        console.error('');
        console.error('   Migrate: the library takes the api INJECTED (constructor(private readonly api: SomeApi)),');
        console.error('   and the server/app DI module constructs the client with factory.createRpcClient(SomeApi, ...).');
        console.error('');
        for (const v of violations) {
            console.error(`  ${icon} ${v.file}:${v.line}   (role:${v.role})`);
            console.error(`     ${v.context}`);
        }
        console.error('');
        if (this.disableAllowed()) {
            console.error('   Escape hatch (use sparingly):');
            console.error(`   // webpieces-disable ${RULE_NAME} -- <reason>`);
        } else {
            console.error('   Escape hatch: DISABLED (disableAllowed: false)');
        }
        console.error('');
        if (severity !== 'error') {
            console.error('   Severity: WARN — reported but NOT failing the build. Migrate, then set');
            console.error(`   "severity": "error" on ${RULE_NAME} to enforce.`);
            console.error('');
        }
    }
}
