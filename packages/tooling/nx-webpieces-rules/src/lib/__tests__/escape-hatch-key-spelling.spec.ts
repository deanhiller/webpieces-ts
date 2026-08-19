import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * SOURCE GUARD: there is exactly ONE spelling of each universal escape hatch.
 *
 * The two hatches every webpieces rule honors are `turnOffRuleUntilEpoch` and
 * `turnOffRuleWhileOnBranch`. They used to be called `ignoreModifiedUntilEpoch` and
 * `ignoreRuleWhileOnBranch`, and the config loader has REJECTED those spellings for several releases
 * (RENAMED_FIELD_ALIASES in rules-config/src/validate-config.ts).
 *
 * Three nx executors kept READING the old spellings out of the option bag anyway — runtime-config.ts,
 * validate-ts-in-src and validate-no-file-import-cycles. Because no legal config can contain the old
 * keys, those reads could only ever produce `undefined`: BOTH escape hatches were silent no-ops for
 * `runtime-architecture`, `validate-ts-in-src` and `no-file-import-cycles`, on every branch, forever.
 * Nothing failed — the hatch simply did not work, which is the worst possible failure mode for a
 * hatch (you find out by the build blocking you on the day you needed it not to).
 *
 * That is shim shape #1 from CLAUDE.md ("two spellings of one thing"), and its cure is deletion.
 * A one-time rename is not enough on its own, though: the old spelling can wander back in from a copied
 * snippet, an older doc, or a package published before the rename. So this spec is the ratchet — it
 * greps every tooling package — code, executor schemas AND docs — and fails on either dead spelling.
 *
 * The ONE sanctioned exception is the rejection path itself: RENAMED_FIELD_ALIASES has to name the
 * dead keys in order to reject them, and its spec has to assert the error text. That is the same
 * carve-out RETIRED_CONFIG_KEYS gets — one place, and it is the place that makes the old name fail.
 */

const DEAD_SPELLINGS = ['ignoreModifiedUntilEpoch', 'ignoreRuleWhileOnBranch'];

/**
 * A dead spelling can also come back WITHOUT being spelled out — as a claim that the old names are
 * still accepted as aliases. That sentence is worse than the literal key, because it tells a reader
 * the rejected spelling works while leaving nothing for a literal grep to catch. This PR's review
 * found exactly one such line in rule-configs.ts ("and their ignore* aliases"), which the literal
 * scan above could not see.
 */
const ALIAS_CLAIM = /ignore\*\s*alias|ignore\w*\s+alias(es)?/i;

/**
 * Files allowed to name a dead spelling, as workspace-relative paths. Keep this list at exactly the
 * rejection path plus the spec that pins its error text — anything else added here is a shim.
 */
const ALLOWED_FILES = [
    'packages/tooling/rules-config/src/validate-config.ts',
    'packages/tooling/rules-config/src/validate-config.spec.ts',
    'packages/tooling/nx-webpieces-rules/src/lib/__tests__/escape-hatch-key-spelling.spec.ts',
];

/** One source file that names a dead spelling. Data-only. */
class DeadSpellingHit {
    constructor(
        public readonly relPath: string,
        public readonly line: number,
        public readonly spelling: string,
        public readonly text: string,
    ) {}
}

function locateRepoRoot(startDir: string): string {
    let dir = startDir;
    while (!fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
        const parent = path.dirname(dir);
        if (parent === dir) throw new Error('could not locate pnpm-workspace.yaml above ' + startDir);
        dir = parent;
    }
    return dir;
}

class ToolingSourceScan {
    readonly repoRoot: string;
    private readonly files: string[] = [];

    constructor(startDir: string) {
        this.repoRoot = locateRepoRoot(startDir);
        const toolingDir = path.join(this.repoRoot, 'packages', 'tooling');
        for (const entry of fs.readdirSync(toolingDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            // Skipped HERE as well as inside collect(): this loop hands each child to collect() as a
            // ROOT, and collect() only screens the names it iterates — so a root's own name is never
            // tested by it.
            if (entry.name === '.webpieces') continue;
            // The WHOLE package, not just src/. The three files this change had to fix by hand — two
            // README.md and rules-config/templates/webpieces.noexitinmain.md — all sit outside src/,
            // and a doc that teaches a rejected key is the same defect one level out (shim shape #6).
            this.collect(path.join(toolingDir, entry.name));
        }
    }

    fileCount(): number {
        return this.files.length;
    }

    hits(): DeadSpellingHit[] {
        const found: DeadSpellingHit[] = [];
        for (const file of this.files) {
            const relPath = path.relative(this.repoRoot, file).split(path.sep).join('/');
            if (ALLOWED_FILES.includes(relPath)) continue;
            const lines = fs.readFileSync(file, 'utf8').split('\n');
            lines.forEach((text: string, index: number) => {
                for (const spelling of DEAD_SPELLINGS) {
                    if (text.includes(spelling)) {
                        found.push(new DeadSpellingHit(relPath, index + 1, spelling, text.trim()));
                    }
                }
                if (ALIAS_CLAIM.test(text)) {
                    found.push(new DeadSpellingHit(relPath, index + 1, 'claims ignore* aliases exist', text.trim()));
                }
            });
        }
        return found;
    }

    private collect(dir: string): void {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            // `.webpieces` is the GITIGNORED per-repo state dir (hook audit logs, PR-review scratch).
            // Those logs quote whatever code a hook saw, so one that ever touched the retired spelling
            // parks that string on the developer's disk forever. Scanning it made this ratchet fail
            // LOCALLY while CI — a fresh checkout with no logs — stayed green, which is the worst
            // shape a guard can have. Only tracked source is in scope here.
            if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.webpieces') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                this.collect(full);
            } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.json') || entry.name.endsWith('.md')) {
                this.files.push(full);
            }
        }
    }
}

describe('universal escape hatches have exactly one spelling', () => {
    const scan = new ToolingSourceScan(__dirname);

    it('scanned a meaningful number of tooling source files (sanity check)', () => {
        expect(scan.fileCount()).toBeGreaterThan(100);
    });

    it('names no retired hatch spelling anywhere under packages/tooling (code, schemas AND docs)', () => {
        const hits = scan.hits();
        const report = hits
            .map((h: DeadSpellingHit) => `  ${h.relPath}:${h.line}  ${h.spelling}  →  ${h.text}`)
            .join('\n');
        expect(
            hits.length,
            `Retired escape-hatch spelling(s) found. The config loader REJECTS these keys, so any code\n` +
                `reading them gets undefined and the hatch is a silent no-op. Use "turnOffRuleUntilEpoch" /\n` +
                `"turnOffRuleWhileOnBranch" instead:\n${report}`,
        ).toBe(0);
    });

    it('keeps the rejection path — the loader still knows the dead spellings so it can reject them', () => {
        const aliases = fs.readFileSync(
            path.join(scan.repoRoot, 'packages/tooling/rules-config/src/validate-config.ts'),
            'utf8',
        );
        for (const spelling of DEAD_SPELLINGS) {
            expect(aliases).toContain(spelling);
        }
    });
});
