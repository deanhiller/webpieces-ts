import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { specTempDirs } from '@webpieces/tooling-testkit';
import {
    FileContext,
    NormalizedEdit,
    NormalizedToolInput,
    ProposedFile,
    ToolKind,
    runRuleCheck,
} from '@webpieces/hook-runtime';
import { SourceContributionConfig } from '../source-contribution-config';
import { CatchMustPropagateRule } from './catch-must-propagate';

const DROPS = 'export class A {\n    run(): void {\n        try {\n            work();\n        } catch (err) {\n            this.text = String(err);\n        }\n    }\n}\n';

class Fixture {
    readonly root = specTempDirs.make('wp-catch-must-propagate-');

    context(rel: string, original: string, edits: readonly NormalizedEdit[], tool: ToolKind): FileContext {
        const file = path.join(this.root, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, original);
        return new FileContext(tool, file, rel, this.root, new ProposedFile(tool, new NormalizedToolInput(file, edits)), 0, 0, 0, 0);
    }

    write(rel: string, text: string): FileContext {
        return this.context(rel, '', [new NormalizedEdit('', text, false)], 'Write');
    }
}

// webpieces-disable no-function-outside-class -- spec-local factory
function rule(mode: string, forwards: string[] | 'missing' = ['warn']): CatchMustPropagateRule {
    const config = new SourceContributionConfig();
    config.mode = mode;
    config.forwards = forwards === 'missing' ? undefined : forwards;
    return new CatchMustPropagateRule(config);
}

describe('catch-must-propagate — the Write/Edit guard half', () => {
    const fixture = new Fixture();

    it('refuses a written catch that keeps only the text, at the catch line, with the diagnosis', () => {
        const found = rule('NEW_AND_MODIFIED_CODE').check(fixture.write('src/a.ts', DROPS));
        expect(found).toMatchObject([{ line: 5, snippet: '} catch (err) {' }]);
        expect(found[0]!.message).toContain('only through its text');
    });

    it('passes a catch handing the error whole to a configured forwarder', () => {
        const text = DROPS.replace('this.text = String(err);', "log.warn('failed', err);");
        expect(rule('NEW_AND_MODIFIED_CODE').check(fixture.write('src/b.ts', text))).toEqual([]);
        expect(rule('NEW_AND_MODIFIED_CODE', []).check(fixture.write('src/b2.ts', text))).toHaveLength(1);
    });

    it('NEW_AND_MODIFIED_CODE grandfathers an untouched legacy catch; a whole-file mode judges it', () => {
        const edit = [new NormalizedEdit('run(): void {', 'run(): void {\n        prepare();', false)];
        expect(rule('NEW_AND_MODIFIED_CODE').check(fixture.context('src/c.ts', DROPS, edit, 'Edit'))).toEqual([]);
        expect(rule('NEW_AND_MODIFIED_FILES').check(fixture.context('src/d.ts', DROPS, edit, 'Edit'))).toHaveLength(1);
    });

    it('judges an edit that changes a line inside an existing catch', () => {
        const legacy = DROPS.replace('this.text = String(err);', 'throw err;');
        const edit = [new NormalizedEdit('throw err;', 'this.text = `${err}`;', false)];
        expect(rule('NEW_AND_MODIFIED_CODE').check(fixture.context('src/e.ts', legacy, edit, 'Edit'))).toMatchObject([{ line: 5 }]);
    });

    it('does not judge test files', () => {
        expect(rule('NEW_AND_MODIFIED_CODE').check(fixture.write('src/a.spec.ts', DROPS))).toEqual([]);
    });

    it('refuses to run without the required forwards list, as a structured refusal', () => {
        const found = runRuleCheck(rule('NEW_AND_MODIFIED_CODE', 'missing'), fixture.write('src/f.ts', DROPS));
        expect(found[0]!.message).toContain('"forwards"');
        expect(found[0]!.message).not.toContain('crashed');
    });

    it('surfaces a stale edit as the projection refusal, not as a crashed rule', () => {
        const stale = [new NormalizedEdit('no such text', 'x', false)];
        const found = runRuleCheck(rule('NEW_AND_MODIFIED_CODE'), fixture.context('src/g.ts', DROPS, stale, 'Edit'));
        expect(found[0]!.message).toContain('does not match the current file');
        expect(found[0]!.message).not.toContain('crashed');
        expect(found[0]!.message).not.toContain('old_string');
    });
});
