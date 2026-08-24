/**
 * The rule that stops the NEXT hard-coded state path from reaching a generated doc.
 *
 * Both directions are asserted throughout: a rule that never fires and a rule that fires on everything
 * are equally useless, and a single "it passes" assertion is satisfied by the first of those.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NoStatePathsInTemplatesConfig, RuleFailError } from '@webpieces/rules-config';

import { NoStatePathsInTemplatesValidator } from './validate-no-state-paths-in-templates';

const TEMPLATES = 'packages/tooling/rules-config/templates';

// The exact line that shipped: a per-worktree log restated as a relative literal in an AI-instruction doc.
const OFFENDING_DOC = `# wp-cleanup

It logs every deletion with its pre-delete SHA plus a \`recover=\` command in
\`.webpieces/logs/branch-mutations.log\`. Use this instead of \`git branch -D\`.
`;

// The same doc, fixed the way the template engine already works elsewhere.
const RENDERED_DOC = `# wp-cleanup

It logs every deletion with its pre-delete SHA plus a \`recover=\` command in
\`{{BRANCH_MUTATION_LOG}}\`. Use this instead of \`git branch -D\`.
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

function config(): NoStatePathsInTemplatesConfig {
    const cfg = new NoStatePathsInTemplatesConfig();
    cfg.mode = 'NEW_AND_MODIFIED_FILES';
    cfg.turnOffRuleUntilEpoch = 0;
    return cfg;
}

describe('NoStatePathsInTemplatesValidator', () => {
    let root: string;

    beforeEach(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'no-state-paths-')));
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

    it('FAILS a template that restates a .webpieces path', async () => {
        writeFile(root, `${TEMPLATES}/webpieces.git-workflow.md`, OFFENDING_DOC);

        await expect(new NoStatePathsInTemplatesValidator(config()).run(root)).rejects.toBeInstanceOf(RuleFailError);
    });

    it('PASSES the same doc once the path is a rendered placeholder', async () => {
        writeFile(root, `${TEMPLATES}/webpieces.git-workflow.md`, RENDERED_DOC);

        expect((await new NoStatePathsInTemplatesValidator(config()).run(root)).success).toBe(true);
    });

    /**
     * The scope call the spec made explicitly: `backlog/*.md` are frozen records of past requests, and
     * rewriting one falsifies the record. Same content, outside the template dirs, and the rule is blind
     * to it — which is what makes the narrow default honest rather than accidental.
     */
    it('is blind to the identical literal outside the template dirs', async () => {
        writeFile(root, 'backlog/bug-someone-asked-for-this.md', OFFENDING_DOC);
        writeFile(root, 'docs/tooling-logs.md', OFFENDING_DOC);

        expect((await new NoStatePathsInTemplatesValidator(config()).run(root)).success).toBe(true);
    });

    it('honours the escape hatch a doc whose SUBJECT is the layout needs', async () => {
        writeFile(root, `${TEMPLATES}/webpieces.buildlog.md`,
            '<!-- webpieces-disable no-state-paths-in-templates -- this table IS the layout -->\n'
            + '| the primary clone | `.webpieces/build.log` |\n');

        expect((await new NoStatePathsInTemplatesValidator(config()).run(root)).success).toBe(true);
    });

    it('refuses the escape hatch when disableAllowed is false', async () => {
        writeFile(root, `${TEMPLATES}/webpieces.buildlog.md`,
            '<!-- webpieces-disable no-state-paths-in-templates -- this table IS the layout -->\n'
            + '| the primary clone | `.webpieces/build.log` |\n');
        const cfg = config();
        cfg.disableAllowed = false;

        await expect(new NoStatePathsInTemplatesValidator(cfg).run(root)).rejects.toBeInstanceOf(RuleFailError);
    });

    /**
     * `~/.webpieces/config.json` is the MACHINE-LOCAL tier: the same absolute path from every tree, with
     * no resolver to call. The literal is the only spelling there is, so flagging it would teach an
     * author to replace a correct line with a placeholder that cannot exist.
     */
    it('does not flag the machine-local ~/.webpieces tier', async () => {
        writeFile(root, `${TEMPLATES}/webpieces.config-policy.md`,
            'A MACHINE-LOCAL setting lives in `~/.webpieces/config.json` under `experimental`.\n');

        expect((await new NoStatePathsInTemplatesValidator(config()).run(root)).success).toBe(true);
    });

    it('still flags a per-tree path on a line that also names the machine-local one', async () => {
        writeFile(root, `${TEMPLATES}/webpieces.buildlog.md`,
            'The ledger is `~/.webpieces/builds.log`; this build went to `.webpieces/build.log`.\n');

        await expect(new NoStatePathsInTemplatesValidator(config()).run(root)).rejects.toBeInstanceOf(RuleFailError);
    });

    it('respects a configured templateDirs and bannedPathPrefixes', async () => {
        writeFile(root, 'my/own/templates/agent.md', 'state lives in `.mytool/state/run.json`\n');
        const cfg = config();
        cfg.templateDirs = ['my/own/templates'];
        cfg.bannedPathPrefixes = ['.mytool/'];

        await expect(new NoStatePathsInTemplatesValidator(cfg).run(root)).rejects.toBeInstanceOf(RuleFailError);
    });

    it('is a no-op for a repo whose templates dir does not exist', async () => {
        writeFile(root, 'src/app.ts', 'export const a = 1;\n');

        expect((await new NoStatePathsInTemplatesValidator(config()).run(root)).success).toBe(true);
    });

    it('mode OFF never fails, whatever the template says', async () => {
        writeFile(root, `${TEMPLATES}/webpieces.git-workflow.md`, OFFENDING_DOC);
        const cfg = config();
        cfg.mode = 'OFF';

        expect((await new NoStatePathsInTemplatesValidator(cfg).run(root)).success).toBe(true);
    });

    /**
     * NEW_AND_MODIFIED_CODE is the shipped default, and the whole reason the rule can arrive ARMED:
     * an untouched legacy line is not a violation, and the same line becomes one the moment it is edited.
     */
    it('NEW_AND_MODIFIED_CODE spares an untouched legacy line and bites when it is edited', async () => {
        writeFile(root, `${TEMPLATES}/webpieces.git-workflow.md`, OFFENDING_DOC);
        git(root, 'add -A');
        git(root, 'commit -q -m legacy');
        process.env['NX_BASE'] = git(root, 'rev-parse HEAD');

        const cfg = config();
        cfg.mode = 'NEW_AND_MODIFIED_CODE';
        expect((await new NoStatePathsInTemplatesValidator(cfg).run(root)).success).toBe(true);

        writeFile(root, `${TEMPLATES}/webpieces.git-workflow.md`,
            OFFENDING_DOC.replace('Use this instead', 'Always use this instead'));
        await expect(new NoStatePathsInTemplatesValidator(cfg).run(root)).rejects.toBeInstanceOf(RuleFailError);
    });

    it('narrows its file set in exactly one place — isRelevantFile', () => {
        const validator = new NoStatePathsInTemplatesValidator(config());

        expect(validator.isRelevantFile(`${TEMPLATES}/webpieces.git-workflow.md`)).toBe(true);
        expect(validator.isRelevantFile(`${TEMPLATES}/webpieces-pr-gate.yml`)).toBe(false);
        expect(validator.isRelevantFile('backlog/bug-x.md')).toBe(false);
        expect(validator.isRelevantFile('docs/tooling-logs.md')).toBe(false);
    });

    it('reports the line and column of the restated path', () => {
        const hits = new NoStatePathsInTemplatesValidator(config()).findHits(OFFENDING_DOC);

        expect(hits.length).toBe(1);
        expect(hits[0].line).toBe(4);
        expect(hits[0].column).toBe(2);
    });

    /**
     * The failure travels as a THROWN RuleFailError carrying Option[] — the one spelling of "this
     * validator failed". The cures must NOT be hand-numbered prose in the message: the framework owns
     * the `Fix Option N:` / `(preferred)` labels, and a rule that writes its own is the second spelling
     * RuleReporter's docstring calls a shim scheduled for deletion.
     */
    it('throws the failure with framework-rendered cures, and hand-numbers nothing', async () => {
        writeFile(root, `${TEMPLATES}/webpieces.git-workflow.md`, OFFENDING_DOC);

        const error = await new NoStatePathsInTemplatesValidator(config()).run(root)
            .then((): RuleFailError | null => null, (err: unknown): RuleFailError => err as RuleFailError);

        expect(error).toBeInstanceOf(RuleFailError);
        const failure = error as RuleFailError;
        expect(failure.ruleName).toBe('no-state-paths-in-templates');
        // Two cures, the placeholder one preferred, and the escape hatch second.
        expect(failure.fixOptions.length).toBe(2);
        expect(failure.fixOptions[0].preferred).toBe(true);
        expect(failure.fixOptions[0].text).toContain('{{BRANCH_MUTATION_LOG}}');
        expect(failure.fixOptions[1].text).toContain('webpieces-disable no-state-paths-in-templates');
        // The message locates the violation and never writes the framework's own labels.
        expect(failure.aiMessage).toContain('webpieces.git-workflow.md:4:2');
        expect(failure.aiMessage).not.toContain('Fix Option');
        expect(failure.line).toBe(4);
    });
});
