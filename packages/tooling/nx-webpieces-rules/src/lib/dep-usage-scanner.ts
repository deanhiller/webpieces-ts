/**
 * Dep Usage Scanner
 *
 * Answers ONE question for a project: "is package X reached from production
 * source, or ONLY from test/dev files?"
 *
 * WHY this exists: nx derives graph edges from ALL TypeScript sources, specs
 * included. Without this scan, a package imported only by `*.spec.ts` looks
 * identical to a package imported by a controller, so the validator forces it
 * into `dependencies` — and `pnpm deploy --prod` then ships test machinery
 * (auth-bypass hooks, canned credentials, fakes) into the production image.
 * Splitting the scan by file kind lets `devDependencies` be the REQUIRED home
 * for test-only packages.
 *
 * The scan is deliberately conservative: a package is "test-only" ONLY when it
 * is imported by at least one test/dev file and by ZERO production files. Any
 * doubt (no import found at all, e.g. a runtime-only/reflection dependency)
 * resolves to "production", so this can never push a runtime-required package
 * out of `dependencies`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { toError } from '../toError';

/** Directories never worth scanning (build output, vendored code, VCS). */
const SKIP_DIRS = new Set([
    'node_modules',
    'dist',
    'build',
    'out-tsc',
    'coverage',
    '.nx',
    '.git',
    'tmp',
    '.angular',
]);

/** Source extensions whose imports we understand. */
const SOURCE_EXTENSIONS = new Set([
    '.ts',
    '.tsx',
    '.mts',
    '.cts',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
]);

/**
 * Directory names whose contents SHIP to consumers as scaffolding (copied into a consumer repo by the
 * installer), so their imports are consumer-facing PRODUCTION deps — NOT this project's own dev-time
 * tooling. A file like `templates/eslint.webpieces.config.mjs` otherwise trips DEV_CONFIG_RE on its
 * name and gets mis-bucketed as dev, which then flags a genuinely-required dependency (e.g.
 * `@webpieces/eslint-rules`, which those very templates import) as "test-only in dependencies".
 * A `templates/` segment therefore short-circuits isDevFile to production, ahead of the name heuristics.
 */
const SHIPPED_DIR_NAMES = new Set([
    'templates',
]);

/**
 * Directory names that make everything below them test/dev-only.
 * Kept tight on purpose — a false "this is a test dir" would let a real
 * production import be classified as test-only.
 */
const TEST_DIR_NAMES = new Set([
    '__tests__',
    '__mocks__',
    '__fixtures__',
    'test',
    'tests',
    'e2e',
    'e2e-tests',
]);

/** `foo.spec.ts`, `foo.test.tsx`, `foo-e2e.spec.mts`, `foo.testkit.ts`, ... */
const TEST_FILE_RE = /[.-](spec|test|e2e|testkit|mock|mocks|fixture|fixtures)\.[cm]?[jt]sx?$/;

/** Tooling config/bootstrap files: dev-time by definition. */
const DEV_CONFIG_RE =
    /^(vitest|vite|jest|playwright|cypress|karma|webpack|rollup|eslint|prettier)\.[\w.-]*config\.[cm]?[jt]s$/;

/** `jest.setup.ts`, `vitest.setup.ts`, `test-setup.ts`, ... */
const DEV_SETUP_RE = /^([\w-]*[.-])?(setup|test-setup)\.[cm]?[jt]s$/;

/** Bare-import extraction: `from 'x'`, `import 'x'`, `import('x')`, `require('x')`. */
const IMPORT_RE =
    /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;

/**
 * Which packages a project reaches from production code vs. only from test/dev code.
 * Data-only: no logic lives here (see CLAUDE.md — data structures are classes).
 */
export class DepUsage {
    prodPackages: Set<string>;
    testPackages: Set<string>;

    constructor(prodPackages: Set<string>, testPackages: Set<string>) {
        this.prodPackages = prodPackages;
        this.testPackages = testPackages;
    }

    /** True when the package is imported by tests and by no production file. */
    isTestOnly(packageName: string): boolean {
        return this.testPackages.has(packageName) && !this.prodPackages.has(packageName);
    }

    /** True when we saw the package in NO file at all (kind is unknown → treat as prod). */
    isUnseen(packageName: string): boolean {
        return !this.testPackages.has(packageName) && !this.prodPackages.has(packageName);
    }
}

export class DepUsageScanner {
    /**
     * Walk a project directory and record every bare import specifier, bucketed
     * by whether the importing file is production or test/dev.
     */
    scan(absProjectDir: string): DepUsage {
        const usage = new DepUsage(new Set<string>(), new Set<string>());
        if (!fs.existsSync(absProjectDir)) return usage;
        this.walk(absProjectDir, absProjectDir, usage);
        return usage;
    }

    /**
     * Is this path a test/dev file? Path is relative to the project root and
     * uses either separator.
     */
    isDevFile(relPath: string): boolean {
        const normalized = relPath.split(path.sep).join('/');
        const segments = normalized.split('/');
        const fileName = segments[segments.length - 1];

        // Shipped scaffolding wins over every dev heuristic below: a template file's imports are
        // consumer-facing production deps, even when its NAME looks like a dev config (eslint.*.config.mjs).
        for (const dir of segments.slice(0, -1)) {
            if (SHIPPED_DIR_NAMES.has(dir)) return false;
        }
        for (const dir of segments.slice(0, -1)) {
            if (TEST_DIR_NAMES.has(dir)) return true;
        }
        if (TEST_FILE_RE.test(fileName)) return true;
        if (DEV_CONFIG_RE.test(fileName)) return true;
        if (DEV_SETUP_RE.test(fileName)) return true;
        return false;
    }

    /**
     * The package a bare specifier belongs to, or null for relative/absolute
     * paths and node: builtins. `@scope/pkg/sub` → `@scope/pkg`; `pkg/sub` → `pkg`.
     */
    toPackageName(specifier: string): string | null {
        if (specifier.length === 0) return null;
        if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
        if (specifier.startsWith('node:')) return null;
        const parts = specifier.split('/');
        if (specifier.startsWith('@')) {
            if (parts.length < 2) return null;
            return `${parts[0]}/${parts[1]}`;
        }
        return parts[0];
    }

    private walk(absDir: string, projectRoot: string, usage: DepUsage): void {
        const entries = fs.readdirSync(absDir, { withFileTypes: true });
        for (const entry of entries) {
            const absPath = path.join(absDir, entry.name);
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name)) continue;
                this.walk(absPath, projectRoot, usage);
                continue;
            }
            if (!entry.isFile()) continue;
            if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
            this.scanFile(absPath, projectRoot, usage);
        }
    }

    private scanFile(absPath: string, projectRoot: string, usage: DepUsage): void {
        const source = this.readFile(absPath);
        if (source === null) return;
        const relPath = path.relative(projectRoot, absPath);
        const bucket = this.isDevFile(relPath) ? usage.testPackages : usage.prodPackages;
        for (const packageName of this.extractPackageNames(source)) {
            bucket.add(packageName);
        }
    }

    private extractPackageNames(source: string): string[] {
        const names: string[] = [];
        IMPORT_RE.lastIndex = 0;
        let match = IMPORT_RE.exec(source);
        while (match !== null) {
            const packageName = this.toPackageName(match[1]);
            if (packageName !== null) names.push(packageName);
            match = IMPORT_RE.exec(source);
        }
        return names;
    }

    private readFile(absPath: string): string | null {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return fs.readFileSync(absPath, 'utf-8');
        } catch (err: unknown) {
            const error = toError(err);
            // An unreadable file cannot change the classification of a package; skipping it
            // only ever makes the scan MORE conservative (fewer test-only classifications).
            console.warn(`Could not read ${absPath} while classifying deps: ${error.message}`);
            return null;
        }
    }
}
