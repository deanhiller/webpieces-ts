/**
 * The three graph rules that make a tag true (#1064): api-lib-dependencies (D2), api-lib-path (D10)
 * and framework-folder (D9). Each has a red case and a green case; the "missing config entry fails the
 * load" half is proven in rules-config's tag-truth-configs.spec.ts, where the schemas live.
 */
import { describe, it, expect } from 'vitest';
import type { EnhancedGraph } from '../graph-sorter';
import { ProjectInfo } from '../project-info';
import {
    ApiLibDependenciesRule,
    ApiLibPathRule,
    FrameworkFolder,
    FrameworkFolderRule,
    ProjectImports,
    TagTruthRules,
    TagTruthValidator,
} from '../tag-truth';

class Proj {
    constructor(
        readonly name: string,
        readonly root: string,
        readonly role: string,
        readonly framework: string[],
        readonly dependsOn: string[] = [],
        readonly packageName: string | null = null,
        readonly imports: string[] = [],
    ) {}
}

class Fixture {
    readonly graph: EnhancedGraph = {};
    readonly infos = new Map<string, ProjectInfo>();
    readonly imports = new Map<string, ProjectImports>();

    constructor(projects: Proj[]) {
        for (const p of projects) {
            this.graph[p.name] = { level: 0, dependsOn: p.dependsOn, role: p.role, framework: p.framework };
            this.infos.set(p.name, new ProjectInfo(p.name, p.root, []));
            this.imports.set(p.name, new ProjectImports(p.packageName, new Set(p.imports)));
        }
    }

    problems(rules: TagTruthRules): string[] {
        return new TagTruthValidator(rules).problems(this.graph, this.infos, this.imports);
    }
}

const UNIVERSAL = ['browser', 'node', 'react-native'];

function depsRule(apiLibPackages: string[], clients: Record<string, string[]> = {}): TagTruthRules {
    return new TagTruthRules(
        new ApiLibDependenciesRule(apiLibPackages, new Map(Object.entries(clients))),
        null,
        null,
    );
}

describe('api-lib-dependencies (D2)', () => {
    it('GREEN: an api-lib depending on another api-lib and importing only listed packages', () => {
        const fx = new Fixture([
            new Proj('lang-apis', 'libraries/apis/internal/lang-apis', 'api-lib', UNIVERSAL, ['lang-dtos'], '@my/lang-apis',
                ['@my/lang-dtos', '@webpieces/core-util', 'tslib']),
            new Proj('lang-dtos', 'libraries/apis/internal/lang-dtos', 'api-lib', UNIVERSAL, [], '@my/lang-dtos'),
        ]);
        expect(fx.problems(depsRule(['@webpieces/core-util', 'tslib']))).toEqual([]);
    });

    it('RED: an api-lib depending on a role:lib project', () => {
        const fx = new Fixture([
            new Proj('lang-apis', 'libraries/apis/internal/lang-apis', 'api-lib', UNIVERSAL, ['company-core'], '@my/lang-apis',
                ['@my/company-core']),
            new Proj('company-core', 'libraries/universal/company-core', 'lib', UNIVERSAL, [], '@my/company-core'),
        ]);
        expect(fx.problems(depsRule(['tslib']))).toEqual([
            expect.stringContaining("api-lib-dependencies: 'lang-apis' (role:api-lib) must not depend on 'company-core' (role:lib)"),
        ]);
    });

    it('a workspace project listed by package name in apiLibPackages is allowed (a repo whose core-util is local)', () => {
        const fx = new Fixture([
            new Proj('a-api', 'libraries/apis/a', 'api-lib', UNIVERSAL, ['core-util'], '@x/a-api', ['@webpieces/core-util']),
            new Proj('core-util', 'packages/core/core-util', 'lib', UNIVERSAL, [], '@webpieces/core-util'),
        ]);
        expect(fx.problems(depsRule(['@webpieces/core-util']))).toEqual([]);
    });

    it('RED: an api-lib importing an outside package apiLibPackages does not list (node builtins included)', () => {
        const fx = new Fixture([
            new Proj('a-api', 'libraries/apis/a', 'api-lib', UNIVERSAL, [], '@x/a-api', ['tslib', 'fs', 'inversify']),
        ]);
        const problems = fx.problems(depsRule(['tslib']));
        expect(problems).toEqual([
            expect.stringContaining("imports 'fs', which apiLibPackages does not list"),
            expect.stringContaining("imports 'inversify', which apiLibPackages does not list"),
        ]);
    });

    it('GREEN: an api-client importing its SDK, as its apiClients entry states (globs allowed)', () => {
        const fx = new Fixture([
            new Proj('gcp-tts', 'libraries/apis/external-node/gcp-tts', 'api-client', ['node'], [], '@x/gcp-tts',
                ['@google-cloud/text-to-speech', 'inversify', 'tslib']),
        ]);
        expect(fx.problems(depsRule(['tslib'], { 'gcp-tts': ['@google-cloud/*', 'inversify'] }))).toEqual([]);
    });

    it('RED: an api-client with no apiClients entry', () => {
        const fx = new Fixture([
            new Proj('gmail', 'libraries/apis/external-node/gmail', 'api-client', ['node'], [], '@x/gmail', ['googleapis']),
        ]);
        expect(fx.problems(depsRule(['tslib']))).toEqual([
            expect.stringContaining("'gmail' (role:api-client) has no apiClients entry"),
        ]);
    });

    it('RED: an api-lib cannot borrow an api-client\'s SDK allowance', () => {
        const fx = new Fixture([
            new Proj('a-api', 'libraries/apis/a', 'api-lib', UNIVERSAL, [], '@x/a-api', ['googleapis']),
        ]);
        expect(fx.problems(depsRule(['tslib'], { gmail: ['googleapis'] }))).toHaveLength(1);
    });

    it('ignores every project that is not an api role', () => {
        const fx = new Fixture([new Proj('svc', 'apps/svc', 'server', ['express'], [], null, ['express', 'fs'])]);
        expect(fx.problems(depsRule([]))).toEqual([]);
    });
});

describe('api-lib-path (D10)', () => {
    const rules = new TagTruthRules(null, new ApiLibPathRule(['libraries/apis/**']), null);

    it('GREEN: api projects under the api globs, everything else outside them', () => {
        const fx = new Fixture([
            new Proj('a-api', 'libraries/apis/internal/a-api', 'api-lib', UNIVERSAL),
            new Proj('gmail', 'libraries/apis/external-node/gmail', 'api-client', ['node']),
            new Proj('core', 'libraries/universal/core', 'lib', UNIVERSAL),
        ]);
        expect(fx.problems(rules)).toEqual([]);
    });

    it('RED: an api-lib outside the api globs', () => {
        const fx = new Fixture([new Proj('shell-api', 'libraries/react-native/shell-api', 'api-lib', ['react-native'])]);
        expect(fx.problems(rules)).toEqual([
            expect.stringContaining("api-lib-path: 'shell-api' is role:api-lib but lives at 'libraries/react-native/shell-api'"),
        ]);
    });

    it('RED: a role:lib under the api globs', () => {
        const fx = new Fixture([new Proj('lang-dtos', 'libraries/apis/internal/lang-dtos', 'lib', UNIVERSAL)]);
        expect(fx.problems(rules)).toEqual([
            expect.stringContaining("'lang-dtos' lives at 'libraries/apis/internal/lang-dtos', under api-lib-path.paths"),
        ]);
    });
});

describe('framework-folder (D9)', () => {
    const rules = new TagTruthRules(
        null,
        null,
        new FrameworkFolderRule([
            new FrameworkFolder(['libraries/node/**'], ['node', 'express'], ['lib', 'designed-lib']),
            new FrameworkFolder(['libraries/universal/**'], [FrameworkFolder.canonical(UNIVERSAL)], ['lib', 'designed-lib']),
            new FrameworkFolder(['libraries/apis/internal/**'], [FrameworkFolder.canonical(UNIVERSAL)], ['api-lib']),
        ]),
    );

    it('canonicalises a framework set whatever order it is written in', () => {
        expect(FrameworkFolder.canonical(['react-native', 'browser', 'node'])).toBe('browser+node+react-native');
    });

    it('GREEN: every library carries its folder\'s set and role; apps are not placed', () => {
        const fx = new Fixture([
            new Proj('n1', 'libraries/node/n1', 'lib', ['node']),
            new Proj('n2', 'libraries/node/n2', 'designed-lib', ['express']),
            new Proj('u1', 'libraries/universal/u1', 'lib', ['react-native', 'node', 'browser']),
            new Proj('a1', 'libraries/apis/internal/a1', 'api-lib', UNIVERSAL),
            new Proj('svc', 'apps/svc', 'server', ['express']),
        ]);
        expect(fx.problems(rules)).toEqual([]);
    });

    it('RED: a library in a folder whose framework set it does not carry', () => {
        const fx = new Fixture([new Proj('u1', 'libraries/universal/u1', 'lib', ['browser', 'node'])]);
        expect(fx.problems(rules)).toEqual([
            expect.stringContaining("framework-folder: 'u1' at 'libraries/universal/u1' carries framework set [browser+node]"),
        ]);
    });

    it('RED: an internal api library that is not usable by every runtime', () => {
        const fx = new Fixture([new Proj('a1', 'libraries/apis/internal/a1', 'api-lib', ['browser', 'node'])]);
        expect(fx.problems(rules)).toHaveLength(1);
    });

    it('RED: a role the folder does not hold', () => {
        const fx = new Fixture([new Proj('a1', 'libraries/apis/internal/a1', 'lib', UNIVERSAL)]);
        expect(fx.problems(rules)).toEqual([expect.stringContaining('is role:lib, but the folder')]);
    });

    it('RED: a library carrying a mapped set, living outside every folder that holds it', () => {
        const fx = new Fixture([new Proj('stray', 'libraries/browser-node/stray', 'lib', ['node'])]);
        expect(fx.problems(rules)).toEqual([
            expect.stringContaining("'stray' at 'libraries/browser-node/stray' is a role:lib carrying [node], which framework-folder places under libraries/node/**"),
        ]);
    });

    it('a library whose set no folder maps is not placed', () => {
        const fx = new Fixture([new Proj('web', 'libraries/web/w', 'lib', ['react'])]);
        expect(fx.problems(rules)).toEqual([]);
    });
});

describe('TagTruthRules', () => {
    it('none() checks nothing', () => {
        const fx = new Fixture([new Proj('x', 'anywhere/x', 'api-lib', ['node'], [], null, ['fs'])]);
        expect(TagTruthRules.none().anyEnabled()).toBe(false);
        expect(fx.problems(TagTruthRules.none())).toEqual([]);
    });
});
