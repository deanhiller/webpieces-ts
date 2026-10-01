/**
 * `framework-packages` (#1064, D8) — a framework package is imported only by a project whose EVERY
 * `framework:` tag is one its config entry allows: `@angular/*` only in angular projects, `react` /
 * `react-native` / `expo*` only in react / react-native projects, `express` and the node-only SDKs
 * (`firebase-admin`, `googleapis`, `@google-cloud/*`) only in node / express projects, the browser
 * `firebase` SDK only in browser projects.
 *
 * "Every" is the point: a `browser+node` library importing `firebase-admin` is refused, because its
 * browser half cannot run it — the same reading `library-types-match-client` gives an env SET.
 *
 * The package list is the CONSUMER's (required, no default — `.claude/rules/no-rule-defaults.md`);
 * webpieces seeds and documents the recommended one (`.claude/rules/framework-tags.md`). Only
 * production source is read: a spec importing `express` to stand up a fake server is not the runtime.
 * A package no entry names is not judged. The per-site hatch is
 * `// webpieces-disable framework-packages -- <reason>` on the import line or the line above it.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    FrameworkPackagesConfig,
    FrameworkPackagesEntry,
    hasDisable,
    matchesAnyGlob,
    Option,
    RuleFailError,
    RULE_NAMES,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { CodeValidator, ExecutorResult } from './code-validator';
import { ProjectScanTargets, ScannedProject } from './project-scan-targets';

/** Directories never read: build output, vendored code. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out-tsc', 'coverage', '.nx', '.git', 'tmp']);
/** `from '…'`, `import '…'`, `require('…')`, `import('…')`. */
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;

/** ONE project importing a framework package its runtime cannot run. Data-only. */
export class FrameworkPackageViolation {
    constructor(
        readonly project: string,
        readonly frameworks: readonly string[],
        readonly packageName: string,
        /** `path/to/File.ts:LINE`, repo-relative — the first import found. */
        readonly at: string,
        /** The framework tags an entry allows for that package. */
        readonly allowed: readonly string[],
    ) {}
}

/** The audit itself — no config, no git: projects and entries in, violations out. */
export class FrameworkPackagesAudit {
    constructor(private readonly entries: readonly FrameworkPackagesEntry[]) {}

    audit(workspaceRoot: string, projects: readonly ScannedProject[]): FrameworkPackageViolation[] {
        const out: FrameworkPackageViolation[] = [];
        const nestedRoots = new Set(projects.map((p: ScannedProject) => p.dir));
        for (const project of projects) {
            if (project.frameworks.length === 0) continue; // framework-tag's job
            const seen = new Set<string>();
            for (const site of this.importsOf(workspaceRoot, project.dir, nestedRoots)) {
                if (seen.has(site.packageName)) continue;
                const matching = this.entries.filter((e: FrameworkPackagesEntry) => matchesAnyGlob(site.packageName, e.packages));
                if (matching.length === 0) continue;
                const ok = matching.some((e: FrameworkPackagesEntry) =>
                    project.frameworks.every((env: string) => e.frameworks.includes(env)));
                if (ok) continue;
                seen.add(site.packageName);
                const allowed = Array.from(new Set(matching.flatMap((e: FrameworkPackagesEntry) => e.frameworks)));
                out.push(new FrameworkPackageViolation(project.name, project.frameworks, site.packageName, site.at, allowed));
            }
        }
        return out;
    }

    /** Every bare-package import in a project's production source, nested projects excluded. */
    private importsOf(workspaceRoot: string, dir: string, projectDirs: ReadonlySet<string>): ImportSite[] {
        const sites: ImportSite[] = [];
        const walk = (absDir: string): void => {
            for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
                const abs = path.join(absDir, entry.name);
                const rel = path.relative(workspaceRoot, abs).split(path.sep).join('/');
                if (entry.isDirectory()) {
                    if (SKIP_DIRS.has(entry.name) || entry.name === '__tests__' || projectDirs.has(rel)) continue;
                    if (fs.existsSync(path.join(abs, 'project.json'))) continue; // a nested project is judged on its own
                    walk(abs);
                } else if (/\.(ts|tsx|mts|cts)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) && !this.isTestFile(entry.name)) {
                    sites.push(...this.sitesIn(abs, rel));
                }
            }
        };
        const root = path.join(workspaceRoot, dir);
        if (fs.existsSync(root)) walk(root);
        return sites;
    }

    private isTestFile(name: string): boolean {
        return /\.(spec|test)\.[cm]?tsx?$/.test(name) || /^test-setup\./.test(name) || /\.config\.[cm]?ts$/.test(name);
    }

    private sitesIn(abs: string, rel: string): ImportSite[] {
        const lines = fs.readFileSync(abs, 'utf-8').split('\n');
        const sites: ImportSite[] = [];
        lines.forEach((line: string, index: number) => {
            IMPORT_RE.lastIndex = 0;
            let match = IMPORT_RE.exec(line);
            while (match !== null) {
                const pkg = this.packageNameOf(match[1]);
                const disabled =
                    hasDisable(line, RULE_NAMES.FRAMEWORK_PACKAGES) ||
                    (index > 0 && hasDisable(lines[index - 1], RULE_NAMES.FRAMEWORK_PACKAGES));
                if (pkg !== null && !disabled) sites.push(new ImportSite(pkg, `${rel}:${index + 1}`));
                match = IMPORT_RE.exec(line);
            }
        });
        return sites;
    }

    /** `@scope/pkg/sub` → `@scope/pkg`; `pkg/sub` → `pkg`; relative paths and `node:` builtins → null. */
    private packageNameOf(specifier: string): string | null {
        if (specifier === '' || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return null;
        const parts = specifier.split('/');
        if (specifier.startsWith('@')) return parts.length < 2 ? null : `${parts[0]}/${parts[1]}`;
        return parts[0];
    }
}

/** One import of a bare package. Data-only. */
class ImportSite {
    constructor(
        readonly packageName: string,
        readonly at: string,
    ) {}
}

/** The one structured failure for every violation, shared by the validator and its spec. */
// webpieces-disable no-function-outside-class -- one structured rule failure shared by tests and runner
export function frameworkPackagesError(violations: readonly FrameworkPackageViolation[]): RuleFailError {
    const details = violations
        .map((v: FrameworkPackageViolation) =>
            `  ${v.at} — ${v.project} [${v.frameworks.join(', ')}] imports '${v.packageName}', ` +
            `which only [${v.allowed.join(', ')}] projects may import`)
        .join('\n');
    return new RuleFailError(
        RULE_NAMES.FRAMEWORK_PACKAGES,
        'A project imports a framework package that one of the runtimes its framework tags promise cannot run.\n' + details,
        undefined,
        undefined,
        [
            new Option('Move the code that needs the package into a project whose framework tags are all ones the package runs on, and depend on that project behind an api-lib contract.', true),
            new Option('If the project really runs only where the package does, the TAGS are wrong: narrow its framework tags (and move it to that runtime\'s folder).'),
            new Option('For one import that is genuinely safe, put `// webpieces-disable framework-packages -- <reason>` on the line above it.'),
        ],
    );
}

@injectable(bindingScopeValues.Singleton)
export class FrameworkPackagesValidator extends CodeValidator<FrameworkPackagesConfig> {
    constructor(
        config: FrameworkPackagesConfig,
        private readonly targets: ProjectScanTargets,
    ) {
        super(config, RULE_NAMES.FRAMEWORK_PACKAGES, RULE_NAMES.FRAMEWORK_PACKAGES);
    }

    async run(workspaceRoot: string): Promise<ExecutorResult> {
        const mode = this.config.mode ?? 'OFF';
        if (mode === 'OFF') return { success: true };
        const allowed = this.config.allowedPaths ?? [];
        const projects = this.targets
            .projects(workspaceRoot, mode, RULE_NAMES.FRAMEWORK_PACKAGES)
            .filter((p: ScannedProject) => !matchesAnyGlob(p.dir, allowed));
        const violations = new FrameworkPackagesAudit(this.config.entries).audit(workspaceRoot, projects);
        if (violations.length === 0) return { success: true };
        throw frameworkPackagesError(violations);
    }
}
