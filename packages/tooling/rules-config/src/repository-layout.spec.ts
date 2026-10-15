import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { RepositoryLayout } from '@webpieces/tooling-common';

/** A 0.4.910-layout repo: committed policy beside gitignored state inside `.webpieces/`. */
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
        // A file an older release GENERATED here is gitignored state like any other: it never moves.
        this.write('.webpieces/instruct-ai/rules-catalog.md', '# Generated');
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
    exists(name: string): boolean {
        return fs.lstatSync(path.join(this.root, name), { throwIfNoEntry: false }) !== undefined;
    }
    // The #1254 shape: pnpm links of a deleted project, swept into trash by wp-sync-main.
    trashSymlinks(): string {
        const bin = '.webpieces/trash/2026-10-12T11-39-35Z/libraries/gone/node_modules/.bin';
        fs.mkdirSync(path.join(this.root, bin), { recursive: true });
        const link = path.join(bin, 'glob');
        fs.symlinkSync('../glob/dist/cli.js', path.join(this.root, link));
        return link;
    }
}

describe('repository directory migration', () => {
    it('moves only committed policy out of .webpieces/ and leaves every state file in place', () => {
        const fixture = new LayoutFixture();
        expect(() => fixture.layout.assertCurrent(fixture.root)).toThrow('pnpm wp-migrate-dirs');
        fixture.layout.migrate(fixture.root);
        expect(fixture.read('.webpieces-config/custom/policy.json')).toContain('OFF');
        expect(fixture.read('.webpieces-config/rules/code.json')).toBe('{"code":1}');
        expect(fixture.exists('.webpieces-config/rules-catalog.md')).toBe(false);
        expect(fixture.read('.webpieces/instruct-ai/rules-catalog.md')).toBe('# Generated');
        expect(fixture.read('.webpieces/instruct-ai/guide.md')).toBe('# Runtime');
        expect(fixture.read('.webpieces/pr-review/topic/summary.json')).toContain('work in flight');
        expect(fixture.read('.webpieces/merge-info/topic/state.json')).toBe('{"a":1}');
        expect(fixture.exists('.webpieces/rules')).toBe(false);
        expect(fixture.read('webpieces.config.json')).toContain(
            '.webpieces-config/custom/policy.json',
        );
        expect(fixture.read('webpieces.config.json')).toContain('preserve this');
        expect(fixture.read('.gitignore')).toBe('node_modules/\n.webpieces/\n');
        expect(fixture.layout.migrate(fixture.root)).toEqual([]);
        expect(() => fixture.layout.assertCurrent(fixture.root)).not.toThrow();
    });

    it('never walks state: symlinks in .webpieces/trash neither fail the migration nor block (#1254)', () => {
        const fixture = new LayoutFixture();
        const link = fixture.trashSymlinks();
        fixture.layout.migrate(fixture.root);
        expect(fs.lstatSync(path.join(fixture.root, link)).isSymbolicLink()).toBe(true);
        expect(fixture.read('.webpieces-config/rules/code.json')).toBe('{"code":1}');
        expect(() => fixture.layout.assertCurrent(fixture.root)).not.toThrow();
    });

    it('accepts a .webpieces/ that holds only state — it is the current layout, not a retired one', () => {
        const fixture = new LayoutFixture();
        fixture.layout.migrate(fixture.root);
        fixture.trashSymlinks();
        fixture.write('.webpieces/main-sync-status.json', '{}');
        expect(() => fixture.layout.assertCurrent(fixture.root)).not.toThrow();
        expect(fixture.layout.migrate(fixture.root)).toEqual([]);
    });

    it('leaves an already-correct .gitignore byte-identical', () => {
        const fixture = new LayoutFixture();
        fixture.write('.gitignore', 'dist/\n.webpieces/\nnode_modules/\n');
        fixture.layout.migrate(fixture.root);
        expect(fixture.read('.gitignore')).toBe('dist/\n.webpieces/\nnode_modules/\n');
    });

    it('renames a 0.4.911-0.4.914 .webpieces-logs/ back to .webpieces/ in one move when the name is free', () => {
        const fixture = new LayoutFixture();
        fixture.layout.migrate(fixture.root);
        fs.renameSync(path.join(fixture.root, '.webpieces'), path.join(fixture.root, '.webpieces-logs'));
        fixture.layout.migrate(fixture.root);
        expect(fixture.exists('.webpieces-logs')).toBe(false);
        expect(fixture.read('.webpieces/merge-info/topic/state.json')).toBe('{"a":1}');
    });

    it('leaves .webpieces-logs/ untouched when .webpieces/ already exists', () => {
        const fixture = new LayoutFixture();
        fixture.layout.migrate(fixture.root);
        fixture.write('.webpieces-logs/pr-review/old/summary.json', '{"old":true}');
        fixture.layout.migrate(fixture.root);
        expect(fixture.read('.webpieces-logs/pr-review/old/summary.json')).toBe('{"old":true}');
        expect(fixture.read('.webpieces/pr-review/topic/summary.json')).toContain('work in flight');
    });

    it('repairs a declaration pointing into the retired .webpieces-logs/ directory', () => {
        const fixture = new LayoutFixture();
        const misplaced = '.webpieces-logs/custom/policy.json';
        fixture.write(misplaced, fixture.read('.webpieces/custom/policy.json'));
        fs.rmSync(path.join(fixture.root, '.webpieces/custom'), { recursive: true });
        const document = JSON.parse(fixture.read('webpieces.config.json'));
        document.rulePacks[0].config = misplaced;
        fixture.write('webpieces.config.json', JSON.stringify(document));
        expect(() => fixture.layout.assertPolicyPath(misplaced)).toThrow('pnpm wp-migrate-dirs');
        fixture.layout.migrate(fixture.root);
        const migrated = JSON.parse(fixture.read('webpieces.config.json')).rulePacks[0].config;
        expect(migrated).toBe('.webpieces-config/custom/policy.json');
        expect(() => fixture.layout.assertPolicyPath(migrated)).not.toThrow();
        expect(fixture.read(migrated)).toBe('{"rule":{"mode":"OFF"}}');
        expect(fixture.exists(misplaced)).toBe(false);
        expect(fixture.layout.migrate(fixture.root)).toEqual([]);
    });

    it('does not modify either version when a destination conflicts', () => {
        const fixture = new LayoutFixture();
        fixture.write('.webpieces-config/custom/policy.json', 'other policy');
        const before = fixture.read('webpieces.config.json');
        expect(() => fixture.layout.migrate(fixture.root)).toThrow('conflicts with');
        expect(fixture.read('.webpieces-config/custom/policy.json')).toBe('other policy');
        expect(fixture.read('.webpieces/custom/policy.json')).toContain('OFF');
        expect(fixture.read('.webpieces/rules/code.json')).toBe('{"code":1}');
        expect(fixture.read('webpieces.config.json')).toBe(before);
    });

    it('rejects two different sources that would converge on one destination', () => {
        const fixture = new LayoutFixture();
        fixture.write(
            'webpieces.config.json',
            JSON.stringify({
                rulePacks: [{ package: '@client/pack', config: '.webpieces-logs/rules/code.json' }],
            }),
        );
        fixture.write('.webpieces-logs/rules/code.json', 'separate declared policy');
        expect(() => fixture.layout.migrate(fixture.root)).toThrow('both target');
        expect(fixture.read('.webpieces-logs/rules/code.json')).toBe('separate declared policy');
        expect(fixture.read('.webpieces/rules/code.json')).toBe('{"code":1}');
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

    it('rejects owner settings in the state directory or the retired .webpieces-logs/', () => {
        const layout = new RepositoryLayout();
        for (const filename of ['.webpieces/rules/code.json', '.webpieces-logs/rules/code.json'])
            expect(() => layout.assertPolicyPath(filename)).toThrow('pnpm wp-migrate-dirs');
        expect(() => layout.assertPolicyPath('.webpieces-config/rules/code.json')).not.toThrow();
    });
});
