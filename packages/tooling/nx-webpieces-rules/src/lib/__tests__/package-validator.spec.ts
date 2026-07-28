import { vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type DevkitType = typeof import('@nx/devkit');

vi.mock('@nx/devkit', async () => {
    const actual = await vi.importActual<DevkitType>('@nx/devkit');
    return {
        ...actual,
        createProjectGraphAsync: vi.fn(),
        readProjectsConfigurationFromProjectGraph: vi.fn(),
    };
});

import { createProjectGraphAsync, readProjectsConfigurationFromProjectGraph } from '@nx/devkit';
import {
    PackageValidatorOptions,
    ProjectValidationResult,
    validatePackageJsonDependencies,
} from '../package-validator';

class PackageJsonSpec {
    name: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;

    constructor(
        name: string,
        dependencies?: Record<string, string>,
        devDependencies?: Record<string, string>,
        peerDependencies?: Record<string, string>
    ) {
        this.name = name;
        this.dependencies = dependencies;
        this.devDependencies = devDependencies;
        this.peerDependencies = peerDependencies;
    }
}

class ProjectConfig {
    root: string;
    packageJson: PackageJsonSpec;
    /** relative path → file contents, written under the project root */
    sources: Record<string, string>;

    constructor(root: string, packageJson: PackageJsonSpec, sources: Record<string, string> = {}) {
        this.root = root;
        this.packageJson = packageJson;
        this.sources = sources;
    }
}

class Fixture {
    tmpDir: string;
    cleanup: () => void;

    constructor(tmpDir: string, cleanup: () => void) {
        this.tmpDir = tmpDir;
        this.cleanup = cleanup;
    }
}

function writeProject(tmpDir: string, cfg: ProjectConfig): void {
    const dir = path.join(tmpDir, cfg.root);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(cfg.packageJson, null, 2));
    for (const relPath of Object.keys(cfg.sources)) {
        const absPath = path.join(dir, relPath);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, cfg.sources[relPath]);
    }
}

function setupFixture(projects: ProjectConfig[]): Fixture {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgvalidator-'));
    for (const p of projects) writeProject(tmpDir, p);

    const projectsConfig = {
        projects: Object.fromEntries(
            projects.map((p: ProjectConfig) => [
                p.packageJson.name.replace(/^@webpieces\//, ''),
                { root: p.root },
            ])
        ),
    };

    (createProjectGraphAsync as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (readProjectsConfigurationFromProjectGraph as ReturnType<typeof vi.fn>).mockReturnValue(projectsConfig);

    return new Fixture(tmpDir, (): void => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        vi.clearAllMocks();
    });
}

afterEach(() => vi.clearAllMocks());

describe('validatePackageJsonDependencies — missing dep', () => {
    it('errors when package.json is missing a graph-declared workspace dep', async () => {
        const fx = setupFixture([
            new ProjectConfig('packages/a', new PackageJsonSpec('@webpieces/a', {})),
            new ProjectConfig('packages/b', new PackageJsonSpec('@webpieces/b', {})),
        ]);
        const graph = { a: { level: 1, dependsOn: ['b'] }, b: { level: 0, dependsOn: [] } };
        const result = await validatePackageJsonDependencies(graph, fx.tmpDir);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e: string) => e.includes('missing dependencies'))).toBe(true);
        fx.cleanup();
    });
});

describe('validatePackageJsonDependencies — unreachable extra (warn-only)', () => {
    it('warns but does NOT fail when a workspace extra is not reachable via graph', async () => {
        // This is the runtime-validity trap: an unreachable package.json entry may still be a
        // real runtime/peer dependency, so it must never fail the build — only warn.
        const fx = setupFixture([
            new ProjectConfig(
                'packages/a',
                new PackageJsonSpec('@webpieces/a', { '@webpieces/b': 'workspace:*' })
            ),
            new ProjectConfig('packages/b', new PackageJsonSpec('@webpieces/b', {})),
        ]);
        const graph = { a: { level: 0, dependsOn: [] }, b: { level: 0, dependsOn: [] } };
        const result = await validatePackageJsonDependencies(graph, fx.tmpDir);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
        expect(result.warnings.some((w: string) => w.includes('a → b'))).toBe(true);
        fx.cleanup();
    });
});

describe('validatePackageJsonDependencies — transitive extras allowed', () => {
    it('allows workspace extras that are reachable transitively', async () => {
        const fx = setupFixture([
            new ProjectConfig(
                'packages/a',
                new PackageJsonSpec('@webpieces/a', {
                    '@webpieces/b': 'workspace:*',
                    '@webpieces/c': 'workspace:*',
                })
            ),
            new ProjectConfig(
                'packages/b',
                new PackageJsonSpec('@webpieces/b', { '@webpieces/c': 'workspace:*' })
            ),
            new ProjectConfig('packages/c', new PackageJsonSpec('@webpieces/c', {})),
        ]);
        const graph = {
            a: { level: 2, dependsOn: ['b'] },
            b: { level: 1, dependsOn: ['c'] },
            c: { level: 0, dependsOn: [] },
        };
        const result = await validatePackageJsonDependencies(graph, fx.tmpDir);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
        fx.cleanup();
    });
});

describe('validatePackageJsonDependencies — external deps ignored', () => {
    it('ignores external third-party extras (non-workspace packages)', async () => {
        const fx = setupFixture([
            new ProjectConfig(
                'packages/a',
                new PackageJsonSpec('@webpieces/a', { eslint: '9.39.1', typescript: '5.9.3' })
            ),
        ]);
        const graph = { a: { level: 0, dependsOn: [] } };
        const result = await validatePackageJsonDependencies(graph, fx.tmpDir);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
        fx.cleanup();
    });
});

/**
 * The devDependencies bug: nx derives graph edges from ALL sources including specs, so a
 * package imported only by a *.spec.ts used to be forced into `dependencies` — and therefore
 * into the `pnpm deploy --prod` image.
 */
const PROD_IMPORT = `import { Thing } from '@webpieces/b';\nexport const x = Thing;\n`;
const SPEC_IMPORT = `import { Thing } from '@webpieces/b';\nit('works', () => Thing);\n`;

describe('validatePackageJsonDependencies — production import', () => {
    it('accepts a production-imported dep declared in dependencies', async () => {
        const fx = setupFixture([
            new ProjectConfig(
                'packages/a',
                new PackageJsonSpec('@webpieces/a', { '@webpieces/b': 'workspace:*' }),
                { 'src/thing.ts': PROD_IMPORT }
            ),
            new ProjectConfig('packages/b', new PackageJsonSpec('@webpieces/b', {})),
        ]);
        const graph = { a: { level: 1, dependsOn: ['b'] }, b: { level: 0, dependsOn: [] } };
        const result = await validatePackageJsonDependencies(graph, fx.tmpDir);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
        fx.cleanup();
    });

    it('FAILS when a production-imported dep is declared only in devDependencies', async () => {
        const fx = setupFixture([
            new ProjectConfig(
                'packages/a',
                new PackageJsonSpec('@webpieces/a', {}, { '@webpieces/b': 'workspace:*' }),
                { 'src/thing.ts': PROD_IMPORT }
            ),
            new ProjectConfig('packages/b', new PackageJsonSpec('@webpieces/b', {})),
        ]);
        const graph = { a: { level: 1, dependsOn: ['b'] }, b: { level: 0, dependsOn: [] } };
        const result = await validatePackageJsonDependencies(graph, fx.tmpDir);
        expect(result.valid).toBe(false);
        expect(
            result.errors.some((e: string) =>
                e.includes('declares production imports only in devDependencies')
            )
        ).toBe(true);
        fx.cleanup();
    });
});

describe('validatePackageJsonDependencies — test-only import', () => {
    it('PASSES when a spec-only dep is declared in devDependencies (the reported bug)', async () => {
        const fx = setupFixture([
            new ProjectConfig(
                'packages/a',
                new PackageJsonSpec('@webpieces/a', {}, { '@webpieces/b': 'workspace:*' }),
                { 'src/thing.spec.ts': SPEC_IMPORT }
            ),
            new ProjectConfig('packages/b', new PackageJsonSpec('@webpieces/b', {})),
        ]);
        const graph = { a: { level: 1, dependsOn: ['b'] }, b: { level: 0, dependsOn: [] } };
        const result = await validatePackageJsonDependencies(graph, fx.tmpDir);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
        fx.cleanup();
    });

    it('treats files under __tests__/ as test-only too', async () => {
        const fx = setupFixture([
            new ProjectConfig(
                'packages/a',
                new PackageJsonSpec('@webpieces/a', {}, { '@webpieces/b': 'workspace:*' }),
                { 'src/__tests__/helper.ts': SPEC_IMPORT }
            ),
            new ProjectConfig('packages/b', new PackageJsonSpec('@webpieces/b', {})),
        ]);
        const graph = { a: { level: 1, dependsOn: ['b'] }, b: { level: 0, dependsOn: [] } };
        const result = await validatePackageJsonDependencies(graph, fx.tmpDir);
        expect(result.valid).toBe(true);
        fx.cleanup();
    });

    it('errors (pointing at devDependencies) when a spec-only dep is declared nowhere', async () => {
        const fx = setupFixture([
            new ProjectConfig('packages/a', new PackageJsonSpec('@webpieces/a', {}), {
                'src/thing.spec.ts': SPEC_IMPORT,
            }),
            new ProjectConfig('packages/b', new PackageJsonSpec('@webpieces/b', {})),
        ]);
        const graph = { a: { level: 1, dependsOn: ['b'] }, b: { level: 0, dependsOn: [] } };
        const result = await validatePackageJsonDependencies(graph, fx.tmpDir);
        expect(result.valid).toBe(false);
        const missingError = result.errors.find((e: string) => e.includes('missing dependencies'));
        expect(missingError).toBeDefined();
        expect(missingError!).toContain('devDependencies');
        fx.cleanup();
    });
});

describe('validatePackageJsonDependencies — import used by BOTH prod and test', () => {
    it('requires dependencies (not devDependencies) when production also imports it', async () => {
        const fx = setupFixture([
            new ProjectConfig(
                'packages/a',
                new PackageJsonSpec('@webpieces/a', {}, { '@webpieces/b': 'workspace:*' }),
                { 'src/thing.ts': PROD_IMPORT, 'src/thing.spec.ts': SPEC_IMPORT }
            ),
            new ProjectConfig('packages/b', new PackageJsonSpec('@webpieces/b', {})),
        ]);
        const graph = { a: { level: 1, dependsOn: ['b'] }, b: { level: 0, dependsOn: [] } };
        const result = await validatePackageJsonDependencies(graph, fx.tmpDir);
        expect(result.valid).toBe(false);
        expect(
            result.errors.some((e: string) =>
                e.includes('declares production imports only in devDependencies')
            )
        ).toBe(true);
        fx.cleanup();
    });

    it('passes when a both-prod-and-test dep is in dependencies', async () => {
        const fx = setupFixture([
            new ProjectConfig(
                'packages/a',
                new PackageJsonSpec('@webpieces/a', { '@webpieces/b': 'workspace:*' }),
                { 'src/thing.ts': PROD_IMPORT, 'src/thing.spec.ts': SPEC_IMPORT }
            ),
            new ProjectConfig('packages/b', new PackageJsonSpec('@webpieces/b', {})),
        ]);
        const graph = { a: { level: 1, dependsOn: ['b'] }, b: { level: 0, dependsOn: [] } };
        const result = await validatePackageJsonDependencies(graph, fx.tmpDir);
        expect(result.valid).toBe(true);
        fx.cleanup();
    });
});

describe('validatePackageJsonDependencies — misplacement into the production closure', () => {
    function testOnlyInProdFixture(): Fixture {
        return setupFixture([
            new ProjectConfig(
                'packages/a',
                new PackageJsonSpec('@webpieces/a', { '@webpieces/b': 'workspace:*' }),
                { 'src/thing.spec.ts': SPEC_IMPORT }
            ),
            new ProjectConfig('packages/b', new PackageJsonSpec('@webpieces/b', {})),
        ]);
    }

    const graph = { a: { level: 1, dependsOn: ['b'] }, b: { level: 0, dependsOn: [] } };

    it('errors by default when a test-only dep sits in dependencies', async () => {
        const fx = testOnlyInProdFixture();
        const result = await validatePackageJsonDependencies(graph, fx.tmpDir);
        expect(result.valid).toBe(false);
        expect(
            result.errors.some((e: string) => e.includes('lists test-only packages in "dependencies"'))
        ).toBe(true);
        const projectA = result.projectResults.find(
            (r: ProjectValidationResult) => r.project === 'a'
        );
        expect(projectA!.testOnlyInProdDependencies).toEqual(['b']);
        fx.cleanup();
    });

    it('only warns in warn mode (migration path for existing repos)', async () => {
        const fx = testOnlyInProdFixture();
        const result = await validatePackageJsonDependencies(
            graph,
            fx.tmpDir,
            new PackageValidatorOptions('warn')
        );
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
        expect(result.warnings.some((w: string) => w.includes('lists test-only packages'))).toBe(true);
        fx.cleanup();
    });

    it('is silent in off mode', async () => {
        const fx = testOnlyInProdFixture();
        const result = await validatePackageJsonDependencies(
            graph,
            fx.tmpDir,
            new PackageValidatorOptions('off')
        );
        expect(result.valid).toBe(true);
        expect(result.warnings.some((w: string) => w.includes('lists test-only packages'))).toBe(false);
        fx.cleanup();
    });
});

describe('validatePackageJsonDependencies — unseen deps stay production', () => {
    it('does not call a dep test-only when no file imports it (reflection/runtime deps)', async () => {
        // Conservative by design: a dep we never saw imported must never be pushed OUT of
        // `dependencies`, or we would break a production runtime.
        const fx = setupFixture([
            new ProjectConfig(
                'packages/a',
                new PackageJsonSpec('@webpieces/a', { '@webpieces/b': 'workspace:*' }),
                { 'src/thing.ts': 'export const x = 1;\n' }
            ),
            new ProjectConfig('packages/b', new PackageJsonSpec('@webpieces/b', {})),
        ]);
        const graph = { a: { level: 1, dependsOn: ['b'] }, b: { level: 0, dependsOn: [] } };
        const result = await validatePackageJsonDependencies(graph, fx.tmpDir);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
        fx.cleanup();
    });
});
