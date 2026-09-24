import * as fs from 'fs';
import * as path from 'path';
import { ProjectIndex } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

import { ExecutorResult, RuleRun } from './code-validator';
import { DebugTarget } from './rule-scope-plan';
import { RuleReporter } from './rule-reporter';

/** The shape of console.log / console.error / console.warn. */
// webpieces-disable no-any-unknown -- console methods take any printable values
type ConsoleFn = (...args: unknown[]) => void;

/** One site a rule printed: a file inside a project, and the line when the rule named one. Data-only. */
class PrintedSite {
    constructor(
        readonly relFile: string,
        readonly line: string | null,
        readonly projectRoot: string,
    ) {}
}

/**
 * Runs a DEBUG run (#1027): one rule, labelled as not the gate, its own failure text printed exactly as
 * the build prints it, then a count of sites per project. Nothing is written to webpieces.config.json.
 *
 * The count is taken from what the rule PRINTED — every `path` / `path:line` it named that is a file in
 * a project — rather than from each rule's internals, because the rules report through one renderer
 * but hold their sites in thirty different shapes. A site named twice (in the message and in a cure)
 * counts once. A passing run has no sites by definition, whatever file names it logged on the way.
 */
@injectable(bindingScopeValues.Singleton)
export class DebugRunReport {
    constructor(private readonly reporter: RuleReporter) {}

    async run(workspaceRoot: string, runs: readonly RuleRun[], target: DebugTarget): Promise<ExecutorResult> {
        this.printBanner(target);
        const captured: string[] = [];
        const result = await this.capture(captured, () => this.reporter.runValidators(runs));
        const sites = result.success ? [] : this.sitesIn(workspaceRoot, captured.join('\n'));
        this.printCounts(workspaceRoot, target, sites);
        return { success: result.success };
    }

    private printBanner(target: DebugTarget): void {
        const projects = target.projectNames === null ? 'every project' : target.projectNames.join(', ');
        console.log('');
        console.log('🔬 DEBUG RUN — not the gate. Nothing on disk changes; the build keeps judging the committed mode.');
        console.log(`   rule:     ${target.rule}`);
        console.log(`   mode:     ${target.mode}${target.mode === target.committedMode ? ' (committed)' : ` (committed: ${target.committedMode})`}`);
        console.log(`   projects: ${projects}`);
        console.log('   turnOffRuleUntilEpoch / turnOffRuleWhileOnBranch are ignored for this run.');
        console.log('');
    }

    // Tee console output: it still reaches the terminal, and the report reads it back afterwards.
    private async capture(into: string[], work: () => Promise<ExecutorResult>): Promise<ExecutorResult> {
        const originals: ConsoleFn[] = [console.log, console.error, console.warn];
        const tee = (original: ConsoleFn): ConsoleFn => (...args: Parameters<ConsoleFn>): void => {
            into.push(args.map(String).join(' '));
            original(...args);
        };
        console.log = tee(originals[0]);
        console.error = tee(originals[1]);
        console.warn = tee(originals[2]);
        // webpieces-disable no-unmanaged-exceptions -- restores the console on every path; the reporter already isolates rule failures
        try {
            return await work();
        } finally {
            console.log = originals[0];
            console.error = originals[1];
            console.warn = originals[2];
        }
    }

    private sitesIn(workspaceRoot: string, text: string): PrintedSite[] {
        const projects = new ProjectIndex(workspaceRoot);
        const byKey = new Map<string, PrintedSite>();
        for (const raw of text.split(/\s+/)) {
            const site = this.siteOf(workspaceRoot, raw, projects);
            if (site !== null) byKey.set(`${site.relFile}:${site.line ?? ''}`, site);
        }
        const lined = new Set(Array.from(byKey.values()).filter((s: PrintedSite) => s.line !== null).map((s: PrintedSite) => s.relFile));
        return Array.from(byKey.values()).filter((s: PrintedSite) => s.line !== null || !lined.has(s.relFile));
    }

    private siteOf(workspaceRoot: string, raw: string, projects: ProjectIndex): PrintedSite | null {
        const token = raw.replace(/^[^\w./@-]+/, '').replace(/[^\w/]+$/, '');
        const match = /^(.+?\.[A-Za-z0-9]+)(?::(\d+))?(?::\d+)?$/.exec(token);
        if (match === null) return null;
        const prefix = workspaceRoot.endsWith('/') ? workspaceRoot : `${workspaceRoot}/`;
        const relFile = match[1].startsWith(prefix) ? match[1].slice(prefix.length) : match[1];
        if (path.isAbsolute(relFile) || !fs.existsSync(path.join(workspaceRoot, relFile))) return null;
        const projectRoot = projects.rootOf(relFile);
        if (projectRoot === null) return null;
        return new PrintedSite(relFile, match[2] ?? null, projectRoot);
    }

    private printCounts(workspaceRoot: string, target: DebugTarget, sites: readonly PrintedSite[]): void {
        const projects = new ProjectIndex(workspaceRoot);
        const counts = new Map<string, number>();
        for (const root of target.projectRoots ?? []) counts.set(root, 0);
        for (const site of sites) {
            if (target.projectRoots !== null && !counts.has(site.projectRoot)) continue;
            counts.set(site.projectRoot, (counts.get(site.projectRoot) ?? 0) + 1);
        }
        const names = new Map<string, string>();
        for (const root of counts.keys()) names.set(root, projects.nameOf(root));
        const total = Array.from(counts.values()).reduce((a: number, b: number) => a + b, 0);
        const width = Math.max(5, ...Array.from(names.values()).map((n: string) => n.length));
        console.log('');
        console.log(`🔬 DEBUG RUN — ${target.rule} @ ${target.mode}: sites per project`);
        for (const root of counts.keys()) {
            console.log(`   ${(names.get(root) ?? root).padEnd(width)}  ${counts.get(root) ?? 0}`);
        }
        console.log(`   ${'TOTAL'.padEnd(width)}  ${total}`);
        console.log('');
    }
}
