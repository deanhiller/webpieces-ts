import { describe, it, expect, vi, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    ChecklistDefinition, ChecklistInstructionsService, DiffScope, RepoRootFinder, ReviewJsonService, toChecklist,
} from '@webpieces/rules-config';
import { ChecklistCommand } from './checklist-command';
import { ChecklistDetector } from '../workflow/checklist-detector';
import { ChecklistNotice } from '../workflow/checklist-notice';
import { ChecklistScanner } from '../workflow/checklist-scanner';
import { ForkPoint } from '../workflow/git-findForkPoint';
import { PrContextWriter } from '../workflow/pr-context-writer';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { BranchNaming } from '../workflow/branch-naming';

function git(cwd: string, cmd: string): void {
    execSync(cmd, { cwd, stdio: 'pipe' });
}

// The checklists the stubbed config hands back, set per test.
let configured: ChecklistDefinition[] = [];

/**
 * Stub ONLY `loadAndValidate`, keeping every other export real.
 *
 * The command reads its checklists from the validated config, and validating a whole webpieces.config.json is
 * incidental to what these tests are about (the command's output). It is also actively unusable as a fixture:
 * this repo's own committed config predates several rules the local validator now requires — the config is
 * deliberately one release behind the code — so loading it here fails on unrelated missing-rule errors.
 * Config validation has its own coverage in rules-config; everything below this line is the real thing.
 */
vi.mock('@webpieces/rules-config', async (importOriginal: () => Promise<Record<string, unknown>>) => {
    const actual = await importOriginal();
    return {
        ...actual,
        loadAndValidate: (): Record<string, unknown> => ({ prGate: { checklists: configured, gateSalt: '' } }),
    };
});

// A scratch repo on a feature branch, with `configured` set to the checklists under test.
function repoWithChecklists(checklists: readonly { subagent?: string; doc?: string; patterns?: string[] }[]): string {
    configured = checklists.map((c: { subagent?: string; doc?: string; patterns?: string[] }): ChecklistDefinition => toChecklist(c));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-cmd-'));
    git(dir, 'git init -q -b main');
    git(dir, 'git config user.email t@t.co');
    git(dir, 'git config user.name T');
    fs.writeFileSync(path.join(dir, 'webpieces.config.json'), '{}');  // presence only — loadAndValidate is stubbed
    fs.writeFileSync(path.join(dir, 'README.md'), '# base\n');
    git(dir, 'git add -A');
    git(dir, 'git commit -qm base');
    git(dir, 'git checkout -q -b feature');
    return dir;
}

function commandFor(): ChecklistCommand {
    const diffScope = new DiffScope();
    const reviewJson = new ReviewJsonService();
    const scanner = new ChecklistScanner(
        new AiBranchName(new BranchNaming()), new ChecklistDetector(diffScope), diffScope,
        new ForkPoint(null as never, null as never, null as never),
        new PrContextWriter(diffScope, reviewJson), reviewJson,
    );
    return new ChecklistCommand(
        new RepoRootFinder(), scanner, new ChecklistInstructionsService(reviewJson), new ChecklistNotice(),
    );
}

// Run the command with cwd pointed at the scratch repo, capturing everything it prints.
async function runIn(dir: string): Promise<string> {
    let out = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
        out += String(chunk);
        return true;
    });
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        await commandFor().run();
    } finally {
        write.mockRestore();
        cwd.mockRestore();
    }
    return out;
}

afterEach(() => {
    vi.restoreAllMocks();
});

/**
 * `wp-checklist` ALWAYS succeeds and ALWAYS just lists. These tests assert that contract end-to-end through
 * the real command, because it is the promise `wp-start-upsert-pr` makes when it tells the AI to run this
 * first, and the reason the command may not run any throwing guard.
 */
describe('wp-checklist always succeeds', () => {
    it('resolves (never throws) with outstanding checklists and an UNCOMMITTED match', async () => {
        const dir = repoWithChecklists([{ subagent: 'db-reviewer', patterns: ['**/*.sql'] }]);
        fs.mkdirSync(path.join(dir, 'db'));
        fs.writeFileSync(path.join(dir, 'db', '001.sql'), 'CREATE TABLE a();\n'); // uncommitted + untracked
        const out = await runIn(dir);
        expect(out).toContain('db-reviewer');
        expect(out).toContain('must write:');
    });

    it('resolves when the repo has NO checklists at all', async () => {
        const out = await runIn(repoWithChecklists([]));
        expect(out).toContain('NONE CONFIGURED');
    });

    it('resolves when checklists exist but none match', async () => {
        const dir = repoWithChecklists([{ subagent: 'db-reviewer', patterns: ['**/*.sql'] }]);
        fs.writeFileSync(path.join(dir, 'notes.txt'), 'nothing a checklist cares about\n');
        const out = await runIn(dir);
        expect(out).toContain('0 matched');
    });
});

describe('wp-checklist output states its scope', () => {
    it('names the fork point and says uncommitted work counted', async () => {
        const dir = repoWithChecklists([{ subagent: 'db-reviewer', patterns: ['**/*.sql'] }]);
        fs.writeFileSync(path.join(dir, 'a.sql'), 'x\n');
        const out = await runIn(dir);
        expect(out).toContain('fork point ');
        expect(out).toContain('including uncommitted + untracked work');
    });

    // "Review once" is per subagent: the done one is shown as reused, the missing one as work, and only the
    // missing one gets instructions. Hiding the done one would make a second run look like it found fewer.
    it('marks an already-reviewed checklist ✓ and only instructs the outstanding one', async () => {
        const dir = repoWithChecklists([
            { subagent: 'db-reviewer', patterns: ['**/*.sql'] },
            { subagent: 'ops-reviewer', patterns: ['**/Dockerfile'] },
        ]);
        fs.writeFileSync(path.join(dir, 'a.sql'), 'x\n');
        fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node\n');
        const svc = new ReviewJsonService();
        const reviewPath = svc.reviewJsonPath(dir, new AiBranchName(new BranchNaming()).getFeatureName());
        fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
        fs.writeFileSync(svc.checklistResultPath(reviewPath, 'db-reviewer'),
            JSON.stringify({ id: 'db-reviewer', success: true, output: 'ok', override: '' }));

        const out = await runIn(dir);
        expect(out).toContain('✓ db-reviewer');
        expect(out).toContain('▶ ops-reviewer');
        // the instruction block must name ONLY the outstanding reviewer
        const instructions = out.slice(out.indexOf('You MUST run'));
        expect(instructions).toContain('ops-reviewer');
        expect(instructions).not.toContain('db-reviewer');
    });

    it('says ALWAYS RUNS for a patternless checklist rather than claiming a match', async () => {
        const dir = repoWithChecklists([{ subagent: 'security-reviewer' }]);
        fs.writeFileSync(path.join(dir, 'anything.txt'), 'x\n');
        const out = await runIn(dir);
        expect(out).toContain('ALWAYS RUNS');
        expect(out).not.toContain('file(s) matched');
    });
});
