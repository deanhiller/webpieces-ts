import { specTempDirs } from '@webpieces/tooling-testkit';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DiffScope, RuleFailError, RuleFileScope } from '@webpieces/rules-config';
import { CatchMustPropagateConfig } from './configs/catch-must-propagate-config';
import { CatchMustPropagateValidator } from './validate-catch-must-propagate';
import { GateScanScope } from './scan-scope';

/**
 * `catch-must-propagate` at the build gate (#1313), end to end in a throwaway git repo so the modes, the
 * changed-line scoping, `excludePaths` and the disable hatch are real. What the analyzer accepts and
 * refuses is pinned in `tooling-common/src/catch-propagation.spec.ts`; that the guard and this gate agree
 * is pinned by the conformance spec in `@webpieces/webpieces-tooling`.
 */

const DROPS = 'export class A {\n    run(): void {\n        try {\n            work();\n        } catch (err) {\n            this.text = String(err);\n        }\n    }\n}\n';

// webpieces-disable no-function-outside-class -- spec-local git helper
function git(root: string, cmd: string): string {
    // core.hooksPath=/dev/null keeps machine-global git hooks out of the throwaway test repo.
    return execSync(`git -c core.hooksPath=/dev/null ${cmd}`, {
        cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
}

class Repo {
    readonly root = specTempDirs.makeReal('catch-must-propagate-');

    constructor() {
        git(this.root, 'init -q -b main');
        git(this.root, 'config user.email test@test.com');
        git(this.root, 'config user.name test');
        this.write('libs/core/src/Legacy.ts', DROPS);
        git(this.root, 'add -A');
        git(this.root, 'commit -q -m base');
        process.env['NX_BASE'] = git(this.root, 'rev-parse HEAD');
        delete process.env['NX_HEAD'];
    }

    write(relPath: string, content: string): void {
        fs.mkdirSync(path.dirname(path.join(this.root, relPath)), { recursive: true });
        fs.writeFileSync(path.join(this.root, relPath), content);
    }

    dispose(): void {
        delete process.env['NX_BASE'];
        fs.rmSync(this.root, { recursive: true, force: true });
    }
}

/** The failure a run threw, or undefined when it passed. The catch IS the assertion. */
// webpieces-disable no-function-outside-class -- spec-local helper
async function failureOf(run: () => Promise<unknown>): Promise<RuleFailError | undefined> {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the throw IS what this helper returns
    try {
        await run();
        return undefined;
    } catch (err: unknown) {
        //const error = toError(err);
        if (err instanceof RuleFailError) return err;
        throw err;
    }
}

// webpieces-disable no-function-outside-class -- spec-local factory
function rule(mode: CatchMustPropagateConfig['mode'], excludePaths?: string[]): CatchMustPropagateValidator {
    const config = new CatchMustPropagateConfig();
    config.mode = mode;
    config.forwards = ['warn'];
    config.excludePaths = excludePaths;
    return new CatchMustPropagateValidator(config, new DiffScope(), new GateScanScope());
}

describe('catch-must-propagate — the build-gate validator, end to end', () => {
    let repo: Repo;

    beforeEach(() => {
        repo = new Repo();
    });

    afterEach(() => {
        repo.dispose();
    });

    it('THROWS one RuleFailError naming file:line and the diagnosis, with the shared cures', async () => {
        repo.write('libs/core/src/New.ts', DROPS);

        const failure = await failureOf(() => rule('NEW_AND_MODIFIED_CODE').run(repo.root));

        expect(failure?.ruleName).toBe('catch-must-propagate');
        expect(failure?.humanMessage).toContain('libs/core/src/New.ts:5 — This catch uses `err` only through its text');
        expect(failure?.humanMessage).toContain('// webpieces-disable catch-must-propagate -- <why');
        expect(failure?.fixOptions.map((option: { preferred: boolean }) => option.preferred)).toEqual([true, false, false, false]);
    });

    it('NEW_AND_MODIFIED_CODE grandfathers an untouched catch; NEW_AND_MODIFIED_FILES judges the whole changed file', async () => {
        repo.write('libs/core/src/Legacy.ts', DROPS.replace('run(): void {', 'run(): void {\n        prepare();'));

        expect(await failureOf(() => rule('NEW_AND_MODIFIED_CODE').run(repo.root))).toBeUndefined();
        expect((await failureOf(() => rule('NEW_AND_MODIFIED_FILES').run(repo.root)))?.humanMessage)
            .toContain('libs/core/src/Legacy.ts:6');
    });

    it('NEW_AND_MODIFIED_CODE judges a changed line inside an existing catch', async () => {
        repo.write('libs/core/src/Legacy.ts', DROPS.replace('String(err)', '`${err}`'));

        expect((await failureOf(() => rule('NEW_AND_MODIFIED_CODE').run(repo.root)))?.humanMessage)
            .toContain('libs/core/src/Legacy.ts:5');
    });

    it('honours a per-site disable with a reason, mode OFF, excludePaths and test files', async () => {
        repo.write('libs/core/src/Disabled.ts', DROPS.replace('} catch (err) {',
            '} catch (err) { // webpieces-disable catch-must-propagate -- expected: the probe file may not exist'));
        repo.write('libs/core/src/New.spec.ts', DROPS);
        repo.write('libs/generated/src/Gen.ts', DROPS);

        const scoped = rule('NEW_AND_MODIFIED_CODE', ['libs/generated/**']);
        expect(await failureOf(() => new RuleFileScope().runWithin(scoped.fileExclusions([]), () => scoped.run(repo.root))))
            .toBeUndefined();
        repo.write('libs/core/src/New.ts', DROPS);
        expect(await failureOf(() => rule('OFF').run(repo.root))).toBeUndefined();
    });
});
