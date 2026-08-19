/**
 * The `allowGlobs` repro, both directions.
 *
 * `no-custom-css.allowGlobs` was declared in rules-config, injected into this validator, honoured by the
 * edit-time hook rule, and never read here — so a consumer exempting a generated `design.html` watched the
 * editor go quiet while CI kept failing on that exact file. These tests fail against that validator: the
 * FIRST because the exempted file was still flagged, and they would equally fail against a validator that
 * exempts everything, because the SECOND asserts the same file still fails once the glob is removed.
 *
 * A single "it passes" assertion would be satisfied by a rule that never runs at all, which is why both
 * directions are here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NoCustomCssConfig, NoCustomCssScope } from '@webpieces/rules-config';

import { NoCustomCssValidator } from './validate-no-custom-css';

// The generated design.html legend swatch that started this: an inline style= in a file nobody hand-writes.
const DESIGN_HTML = `<div class="legend">
  <span style="background: #E3F2FD;"></span>
  <span style="background: #FCE4EC;"></span>
</div>
`;

function git(root: string, cmd: string): string {
    // core.hooksPath=/dev/null keeps machine-global git hooks out of the throwaway test repo.
    return execSync(`git -c core.hooksPath=/dev/null ${cmd}`, {
        cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
}

function writeFile(root: string, relPath: string, content: string): void {
    const fullPath = path.join(root, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
}

function config(allowGlobs: string[]): NoCustomCssConfig {
    const c = new NoCustomCssConfig();
    c.mode = 'NEW_AND_MODIFIED_FILES';
    c.turnOffRuleUntilEpoch = 0;
    c.allowGlobs = allowGlobs;
    return c;
}

describe('NoCustomCssValidator allowGlobs', () => {
    let root: string;

    beforeEach(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'no-css-globs-')));
        git(root, 'init -q -b main');
        git(root, 'config user.email test@test.com');
        git(root, 'config user.name test');
        writeFile(root, 'placeholder.txt', 'x\n');
        git(root, 'add -A');
        git(root, 'commit -q -m base');
        process.env['NX_BASE'] = git(root, 'rev-parse HEAD');
        delete process.env['NX_HEAD'];
    });

    afterEach(() => {
        delete process.env['NX_BASE'];
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('PASSES a changed file that a configured glob exempts', async () => {
        writeFile(root, 'services/grubhub-integration/design.html', DESIGN_HTML);
        const result = await new NoCustomCssValidator(config(['**/design.html'])).run(root);
        expect(result.success).toBe(true);
    });

    it('FAILS the same file, same content, once the glob is removed', async () => {
        writeFile(root, 'services/grubhub-integration/design.html', DESIGN_HTML);
        const result = await new NoCustomCssValidator(config([])).run(root);
        expect(result.success).toBe(false);
    });

    it('still enforces a non-matching file while the glob is configured', async () => {
        writeFile(root, 'services/grubhub-integration/design.html', DESIGN_HTML);
        writeFile(root, 'apps/web/src/app/a.component.html', `<div style="color:red"></div>\n`);
        const result = await new NoCustomCssValidator(config(['**/design.html'])).run(root);
        expect(result.success).toBe(false);
    });

    it('exempts in NEW_AND_MODIFIED_CODE too, not only NEW_AND_MODIFIED_FILES', async () => {
        writeFile(root, 'services/grubhub-integration/design.html', DESIGN_HTML);
        const cfg = config(['**/design.html']);
        cfg.mode = 'NEW_AND_MODIFIED_CODE';
        expect((await new NoCustomCssValidator(cfg).run(root)).success).toBe(true);

        const strict = config([]);
        strict.mode = 'NEW_AND_MODIFIED_CODE';
        expect((await new NoCustomCssValidator(strict).run(root)).success).toBe(false);
    });

    it('agrees with the shared NoCustomCssScope the hook rule consults', () => {
        const cfg = config(['**/design.html']);
        const scope = new NoCustomCssScope(cfg);
        const validator = new NoCustomCssValidator(cfg);
        for (const file of ['services/x/design.html', 'apps/web/a.component.html', 'src/a.spec.ts', 'apps/web/a.component.ts']) {
            // isRelevantFile is the ONE place this validator narrows its changed-file set, so "exempt by the
            // shared scope" must imply "never inspected here".
            if (scope.isExempt(file)) expect(validator.isRelevantFile(file)).toBe(false);
        }
    });
});
