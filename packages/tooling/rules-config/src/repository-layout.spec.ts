import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { RepositoryLayout } from '@webpieces/tooling-common';

class LayoutFixture {
    readonly root = specTempDirs.makeReal('wp-layout-');
    readonly layout = new RepositoryLayout();
    constructor() {
        this.write(
            'webpieces.config.json',
            JSON.stringify({
                rulePacks: [{ package: '@client/pack', config: '.webpieces/custom/policy.json' }],
                commands: {},
                noteWhy: 'preserve this',
            }),
        );
        this.write('.gitignore', '.webpieces/\n!/.webpieces/rules/\nnode_modules/\n');
        this.write('.webpieces/custom/policy.json', '{"rule":{"mode":"OFF"}}');
        this.write('.webpieces/rules/code.json', '{"code":1}');
        this.write('.webpieces/rules.lock.json', '{"packs":[]}');
        this.write('.webpieces/instruct-ai/rules-catalog.md', '# Policy');
        this.write('.webpieces/instruct-ai/guide.md', '# Runtime');
        this.write('.webpieces/pr-review/topic/summary.json', '{"title":"work in flight"}');
        this.write('.webpieces/merge-info/topic/state.json', '{"a":1}');
    }
    write(name: string, text: string): void {
        const file = path.join(this.root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
    }
    read(name: string): string {
        return fs.readFileSync(path.join(this.root, name), 'utf8');
    }
}

describe('repository directory migration', () => {
    it('separates committed policy from every runtime file and reduces ignore rules to one', () => {
        const fixture = new LayoutFixture();
        expect(() => fixture.layout.assertCurrent(fixture.root)).toThrow('pnpm wp-migrate-dirs');
        fixture.layout.migrate(fixture.root);
        expect(fixture.read('.webpieces-config/custom/policy.json')).toContain('OFF');
        expect(fixture.read('.webpieces-config/rules/code.json')).toBe('{"code":1}');
        expect(fixture.read('.webpieces-config/rules.lock.json')).toBe('{"packs":[]}');
        expect(fixture.read('.webpieces-config/rules-catalog.md')).toBe('# Policy');
        expect(fixture.read('.webpieces-logs/instruct-ai/guide.md')).toBe('# Runtime');
        expect(fixture.read('.webpieces-logs/pr-review/topic/summary.json')).toContain(
            'work in flight',
        );
        expect(fixture.read('.webpieces-logs/merge-info/topic/state.json')).toBe('{"a":1}');
        expect(fixture.read('webpieces.config.json')).toContain(
            '.webpieces-config/custom/policy.json',
        );
        expect(fixture.read('webpieces.config.json')).toContain('preserve this');
        expect(fixture.read('.gitignore')).toBe('node_modules/\n.webpieces-logs/\n');
        expect(fs.existsSync(path.join(fixture.root, '.webpieces'))).toBe(false);
        expect(fixture.layout.migrate(fixture.root)).toEqual([]);
        expect(() => fixture.layout.assertCurrent(fixture.root)).not.toThrow();
    });
    it('repairs runtime-directory policy using the command prescribed by the rejection', () => {
        const fixture = new LayoutFixture();
        const misplaced = '.webpieces-logs/custom/policy.json';
        fs.mkdirSync(path.join(fixture.root, '.webpieces-logs/custom'), { recursive: true });
        fs.renameSync(
            path.join(fixture.root, '.webpieces/custom/policy.json'),
            path.join(fixture.root, misplaced),
        );
        const document = JSON.parse(fixture.read('webpieces.config.json'));
        document.rulePacks[0].config = misplaced;
        fixture.write('webpieces.config.json', JSON.stringify(document));
        expect(() => fixture.layout.assertPolicyPath(misplaced)).toThrow('pnpm wp-migrate-dirs');
        fixture.layout.migrate(fixture.root);
        const migrated = JSON.parse(fixture.read('webpieces.config.json')).rulePacks[0].config;
        expect(migrated).toBe('.webpieces-config/custom/policy.json');
        expect(() => fixture.layout.assertPolicyPath(migrated)).not.toThrow();
        expect(fixture.read(migrated)).toBe('{"rule":{"mode":"OFF"}}');
        expect(fs.existsSync(path.join(fixture.root, misplaced))).toBe(false);
        expect(fixture.layout.migrate(fixture.root)).toEqual([]);
    });

    it('does not modify either version when a destination conflicts', () => {
        const fixture = new LayoutFixture();
        fixture.write('.webpieces-config/custom/policy.json', 'other policy');
        const before = fixture.read('webpieces.config.json');
        expect(() => fixture.layout.migrate(fixture.root)).toThrow('conflicts with');
        expect(fixture.read('.webpieces-config/custom/policy.json')).toBe('other policy');
        expect(fixture.read('.webpieces/custom/policy.json')).toContain('OFF');
        expect(fixture.read('webpieces.config.json')).toBe(before);
        expect(fs.existsSync(path.join(fixture.root, '.webpieces-logs'))).toBe(false);
    });
    it('rejects two different sources that would converge on one destination', () => {
        const fixture = new LayoutFixture();
        fixture.write(
            'webpieces.config.json',
            JSON.stringify({
                rulePacks: [{ package: '@client/pack', config: '.webpieces/rules-catalog.md' }],
            }),
        );
        fixture.write('.webpieces/rules-catalog.md', 'separate declared policy');
        expect(() => fixture.layout.migrate(fixture.root)).toThrow('both target');
        expect(fixture.read('.webpieces/rules-catalog.md')).toBe('separate declared policy');
        expect(fixture.read('.webpieces/instruct-ai/rules-catalog.md')).toBe('# Policy');
        expect(fs.existsSync(path.join(fixture.root, '.webpieces-logs'))).toBe(false);
    });
    it('accepts identical destinations after an interrupted migration', () => {
        const fixture = new LayoutFixture();
        fixture.write(
            '.webpieces-config/custom/policy.json',
            fixture.read('.webpieces/custom/policy.json'),
        );
        fixture.layout.migrate(fixture.root);
        expect(() => fixture.layout.assertCurrent(fixture.root)).not.toThrow();
    });
    it('refuses a symlink destination before moving source bytes', () => {
        const fixture = new LayoutFixture();
        const outside = specTempDirs.makeReal('wp-layout-outside-');
        fs.symlinkSync(outside, path.join(fixture.root, '.webpieces-config'));
        expect(() => fixture.layout.migrate(fixture.root)).toThrow('symlink');
        expect(fs.readdirSync(outside)).toEqual([]);
        expect(fixture.read('.webpieces/custom/policy.json')).toContain('OFF');
    });
    it('rejects owner settings in either retired or runtime directories', () => {
        const layout = new RepositoryLayout();
        for (const filename of ['.webpieces/rules/code.json', '.webpieces-logs/rules/code.json'])
            expect(() => layout.assertPolicyPath(filename)).toThrow('pnpm wp-migrate-dirs');
        expect(() => layout.assertPolicyPath('.webpieces-config/rules/code.json')).not.toThrow();
    });
});
