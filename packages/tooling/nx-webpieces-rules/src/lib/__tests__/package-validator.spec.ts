import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type DevkitType = typeof import('@nx/devkit');

jest.mock('@nx/devkit', () => {
    const actual = jest.requireActual<DevkitType>('@nx/devkit');
    return {
        ...actual,
        createProjectGraphAsync: jest.fn(),
        readProjectsConfigurationFromProjectGraph: jest.fn(),
    };
});

import { createProjectGraphAsync, readProjectsConfigurationFromProjectGraph } from '@nx/devkit';
import { validatePackageJsonDependencies } from '../package-validator';

interface ProjectConfig {
    root: string;
    packageJson: { name: string; dependencies?: Record<string, string> };
}

interface Fixture {
    tmpDir: string;
    cleanup: () => void;
}

function writeProject(tmpDir: string, cfg: ProjectConfig): void {
    const dir = path.join(tmpDir, cfg.root);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(cfg.packageJson, null, 2));
}

function setupFixture(projects: ProjectConfig[]): Fixture {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgvalidator-'));
    for (const p of projects) writeProject(tmpDir, p);

    const projectsConfig = {
        projects: Object.fromEntries(
            projects.map((p) => [
                p.packageJson.name.replace(/^@webpieces\//, ''),
                { root: p.root },
            ])
        ),
    };

    (createProjectGraphAsync as jest.Mock).mockResolvedValue({});
    (readProjectsConfigurationFromProjectGraph as jest.Mock).mockReturnValue(projectsConfig);

    return {
        tmpDir,
        cleanup: (): void => {
            fs.rmSync(tmpDir, { recursive: true, force: true });
            jest.clearAllMocks();
        },
    };
}

afterEach(() => jest.clearAllMocks());

describe('validatePackageJsonDependencies — missing dep', () => {
    it('errors when package.json is missing a graph-declared workspace dep', async () => {
        const fx = setupFixture([
            { root: 'packages/a', packageJson: { name: '@webpieces/a', dependencies: {} } },
            { root: 'packages/b', packageJson: { name: '@webpieces/b', dependencies: {} } },
        ]);
        const graph = { a: { level: 1, dependsOn: ['b'] }, b: { level: 0, dependsOn: [] } };
        const result = await validatePackageJsonDependencies(graph, fx.tmpDir);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('missing dependencies'))).toBe(true);
        fx.cleanup();
    });
});

describe('validatePackageJsonDependencies — unreachable extra', () => {
    it('errors when package.json has a workspace extra not reachable via graph', async () => {
        const fx = setupFixture([
            {
                root: 'packages/a',
                packageJson: {
                    name: '@webpieces/a',
                    dependencies: { '@webpieces/b': 'workspace:*' },
                },
            },
            { root: 'packages/b', packageJson: { name: '@webpieces/b', dependencies: {} } },
        ]);
        const graph = { a: { level: 0, dependsOn: [] }, b: { level: 0, dependsOn: [] } };
        const result = await validatePackageJsonDependencies(graph, fx.tmpDir);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('a → b'))).toBe(true);
        fx.cleanup();
    });
});

describe('validatePackageJsonDependencies — transitive extras allowed', () => {
    it('allows workspace extras that are reachable transitively', async () => {
        const fx = setupFixture([
            {
                root: 'packages/a',
                packageJson: {
                    name: '@webpieces/a',
                    dependencies: {
                        '@webpieces/b': 'workspace:*',
                        '@webpieces/c': 'workspace:*',
                    },
                },
            },
            {
                root: 'packages/b',
                packageJson: {
                    name: '@webpieces/b',
                    dependencies: { '@webpieces/c': 'workspace:*' },
                },
            },
            { root: 'packages/c', packageJson: { name: '@webpieces/c', dependencies: {} } },
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
            {
                root: 'packages/a',
                packageJson: {
                    name: '@webpieces/a',
                    dependencies: { eslint: '9.39.1', typescript: '5.9.3' },
                },
            },
        ]);
        const graph = { a: { level: 0, dependsOn: [] } };
        const result = await validatePackageJsonDependencies(graph, fx.tmpDir);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
        fx.cleanup();
    });
});
