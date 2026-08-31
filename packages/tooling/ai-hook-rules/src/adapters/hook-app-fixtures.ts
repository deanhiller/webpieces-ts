import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { HookMode } from '../core/types';

/**
 * THE WIRE BYTES the golden tests drive, and the throwaway repo they are judged against.
 *
 * Everything here exists so a reader can see EXACTLY what a harness sends: the payloads are built from
 * the measured envelope key sets (see the fixture docs on GoldenFixture below), not from anything the
 * hook itself produces, and the repo is a real `git init` with a frozen webpieces.config.json rather
 * than whatever tree the suite happens to be running in. A golden computed against the live repo would
 * change verdict with the branch you are standing on.
 *
 * This is NOT a spec file, deliberately: `tsconfig.lib.json` excludes `*.spec.ts`, so a payload builder
 * living in one would never be type-checked by the build.
 */

/** How one PreToolUse call is presented to the hook. Data class per CLAUDE.md rule 1. */
export class GoldenFixture {
    /** Stable key into `__goldens__/hook-app-goldens.json`. */
    readonly name: string;
    /** Which hook binary's mode — `guards` or `rules`. */
    readonly mode: HookMode;
    /**
     * The raw stdin bytes. A STRING, never an object, because malformed stdin is one of the fixtures
     * and a shape that cannot express "not JSON" would quietly drop the case that matters most.
     */
    readonly stdin: string;
    /** True ⇒ the fixture repo also gets a `rulesDir` whose one module throws when required. */
    readonly crashingRulesDir: boolean;

    constructor(name: string, mode: HookMode, stdin: string, crashingRulesDir: boolean = false) {
        this.name = name;
        this.mode = mode;
        this.stdin = stdin;
        this.crashingRulesDir = crashingRulesDir;
    }
}

/** A built fixture repo: where it lives, and the stdin bytes with `<REPO>` resolved into it. */
export class PreparedFixture {
    readonly repo: string;
    readonly root: string;
    readonly stdin: string;

    constructor(repo: string, root: string, stdin: string) {
        this.repo = repo;
        this.root = root;
        this.stdin = stdin;
    }
}

/**
 * The placeholder that stands for the fixture repo's absolute path, in BOTH directions: payloads are
 * written with it and it is substituted in before the run; golden bytes are compared with the real
 * path substituted back out. Guard reports legitimately name absolute paths (the git-workflow doc
 * pointer, the blocked file), and a golden that hard-coded one machine's `/var/folders/...` would be
 * a golden nobody else could run.
 */
export const REPO_TOKEN = '<REPO>';

const CLAUDE_ENVELOPE = { hook_event_name: 'PreToolUse', session_id: 'sess-golden', transcript_path: '/dev/null', cwd: REPO_TOKEN };

/**
 * The Codex additions, MEASURED from codex-cli 0.151.0: it uses Claude's key names and merely ADDS
 * `model`, `turn_id`, `tool_use_id` and `permission_mode`. `turn_id` is the one discriminator (see
 * detect-ai.ts). `agent_id` empty ⇒ the coordinator, populated ⇒ a subagent — identical semantics in
 * both harnesses.
 */
const CODEX_ENVELOPE = { ...CLAUDE_ENVELOPE, model: 'gpt-5-codex', turn_id: 'turn-golden', tool_use_id: 'call_1', permission_mode: 'default', agent_type: 'default', agent_id: '' };

// Codex's edit tool. MEASURED: the tool is named `apply_patch`, it carries `tool_input.command` (not
// file_path), hunk headers are a bare `@@`, and ONE patch may carry many files with mixed operations.
const PATCH_ADD_JS = '*** Begin Patch\n*** Add File: src/foo.js\n+var x = 1;\n*** End Patch\n';
const PATCH_ADD_TS = '*** Begin Patch\n*** Add File: scripts/added.ts\n+export const b = 2;\n*** End Patch\n';

/**
 * Serializes ONE PreToolUse envelope to the bytes a harness would put on stdin. A class rather than a
 * module-scope function because that is the repo rule, and the one instance below is built at module
 * load so the fixture table can stay a plain literal list.
 */
class WirePayload {
    // webpieces-disable no-any-unknown -- these objects ARE the wire envelope; JSON.stringify of a plain object is the payload under test, and naming a type for it would assert a shape the fixtures exist to state literally
    write(envelope: Record<string, unknown>, toolName: string, toolInput: Record<string, unknown>): string {
        return JSON.stringify({ ...envelope, tool_name: toolName, tool_input: toolInput });
    }
}

const WIRE = new WirePayload();

/**
 * ONE fixture per row of the coverage the composed pipeline had none of before: for BOTH harnesses a
 * Bash deny (the ANSI-red systemMessage), a file-tool deny (NO systemMessage), an allow, a read-only
 * tool, malformed stdin, and a fail-closed crash.
 */
export const GOLDEN_FIXTURES: readonly GoldenFixture[] = [
    // ── Claude Code ────────────────────────────────────────────────────────────────────────────────
    // A Bash deny. `git merge` is blocked on every branch, so this verdict does not depend on repo
    // state — and a Bash deny is the ONE case that carries the red `systemMessage`.
    new GoldenFixture('claude/bash-deny', 'guards', WIRE.write(CLAUDE_ENVELOPE, 'Bash', { command: 'git merge main' })),
    new GoldenFixture('claude/bash-allow', 'guards', WIRE.write(CLAUDE_ENVELOPE, 'Bash', { command: 'echo hi' })),
    // The read-only tool: log-and-allow, and the only guard that can deny it is a stale `main`.
    new GoldenFixture('claude/read-allow', 'guards', WIRE.write(CLAUDE_ENVELOPE, 'Read', { file_path: `${REPO_TOKEN}/f.txt` })),
    // Write / Edit / MultiEdit denies — all three must emit NO systemMessage.
    new GoldenFixture('claude/write-deny', 'rules', WIRE.write(CLAUDE_ENVELOPE, 'Write', { file_path: `${REPO_TOKEN}/src/foo.js`, content: 'var x = 1;\n' })),
    new GoldenFixture('claude/edit-deny', 'rules', WIRE.write(CLAUDE_ENVELOPE, 'Edit', { file_path: `${REPO_TOKEN}/scripts/ok.ts`, old_string: 'const a = 1;', new_string: 'const { a } = b;' })),
    new GoldenFixture('claude/multiedit-deny', 'rules', WIRE.write(CLAUDE_ENVELOPE, 'MultiEdit', { file_path: `${REPO_TOKEN}/scripts/ok.ts`, edits: [{ old_string: 'const a = 1;', new_string: 'const { a } = b;' }] })),
    new GoldenFixture('claude/write-allow', 'rules', WIRE.write(CLAUDE_ENVELOPE, 'Write', { file_path: `${REPO_TOKEN}/scripts/ok.ts`, content: 'export const a = 1;\n' })),
    new GoldenFixture('claude/malformed', 'guards', 'not json at all'),
    new GoldenFixture('claude/crash', 'rules', WIRE.write(CLAUDE_ENVELOPE, 'Write', { file_path: `${REPO_TOKEN}/scripts/ok.ts`, content: 'export const a = 1;\n' }), true),

    // ── Codex ──────────────────────────────────────────────────────────────────────────────────────
    new GoldenFixture('codex/bash-deny', 'guards', WIRE.write(CODEX_ENVELOPE, 'Bash', { command: 'git merge main' })),
    new GoldenFixture('codex/bash-allow', 'guards', WIRE.write(CODEX_ENVELOPE, 'Bash', { command: 'echo hi' })),
    // Codex has no Read tool: a read arrives as `Bash` running a pager, which read parity turns into a
    // read-scoped verdict ON TOP of the bash guards.
    new GoldenFixture('codex/read-allow', 'guards', WIRE.write(CODEX_ENVELOPE, 'Bash', { command: `sed -n '1,240p' ${REPO_TOKEN}/f.txt` })),
    new GoldenFixture('codex/apply-patch-deny', 'rules', WIRE.write(CODEX_ENVELOPE, 'apply_patch', { command: PATCH_ADD_JS })),
    new GoldenFixture('codex/apply-patch-allow', 'rules', WIRE.write(CODEX_ENVELOPE, 'apply_patch', { command: PATCH_ADD_TS })),
    new GoldenFixture('codex/malformed', 'guards', '{"turn_id": broken'),
    new GoldenFixture('codex/crash', 'rules', WIRE.write(CODEX_ENVELOPE, 'apply_patch', { command: PATCH_ADD_TS }), true),
];

// A rules module that blows up the moment it is required — the shortest honest way to reach the hook's
// fail-closed boundary from OUTSIDE the hook, i.e. without stubbing anything the pipeline owns.
const CRASHING_RULE_MODULE = "throw new Error('boom from a custom rule module');\n";

/**
 * Builds ONE throwaway git repo per fixture and returns it with the payload's `<REPO>` resolved.
 *
 * A FRESH repo per fixture, not one shared: the hook writes `.webpieces/` state (the decision log, the
 * main-sync cache) as it runs, so a shared tree would let fixture N's leftovers decide fixture N+1's
 * verdict — an order-dependent suite, which is the one kind of golden test worse than none.
 *
 * `realpathSync` matters on macOS: `os.tmpdir()` hands back `/var/folders/...` which resolves to
 * `/private/var/...`, and the L1 location guard compares the payload's cwd against the resolved repo
 * root. Without it every fixture denies with "run git from the repo root" instead of the verdict under
 * test.
 */
export class GoldenRepoBuilder {
    private readonly configJson: string;

    constructor() {
        this.configJson = fs.readFileSync(path.join(__dirname, '__goldens__', 'fixture-webpieces.config.json'), 'utf8');
    }

    build(fixture: GoldenFixture): PreparedFixture {
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-hook-golden-')));
        const repo = path.join(root, 'repo');
        fs.mkdirSync(repo);
        this.git(repo, 'init -q -b main');
        // The developer's own commit hooks would otherwise fire inside this throwaway repo.
        this.git(repo, 'config core.hooksPath /dev/null');
        this.git(repo, 'config user.email t@t.co');
        this.git(repo, 'config user.name tester');
        fs.writeFileSync(path.join(repo, 'webpieces.config.json'), this.repoConfig(fixture));
        fs.writeFileSync(path.join(repo, 'f.txt'), 'hello\n');
        fs.mkdirSync(path.join(repo, 'scripts'));
        fs.writeFileSync(path.join(repo, 'scripts', 'ok.ts'), 'const a = 1;\n');
        if (fixture.crashingRulesDir) {
            fs.mkdirSync(path.join(repo, 'wprules'));
            fs.writeFileSync(path.join(repo, 'wprules', 'crash.js'), CRASHING_RULE_MODULE);
        }
        this.git(repo, 'add -A');
        this.git(repo, 'commit -qm init');
        // A local origin/main, so `origin/main..<branch>` resolves exactly as it does in a real clone.
        this.git(repo, 'update-ref refs/remotes/origin/main HEAD');
        // A feature branch, because that is where an agent actually works.
        this.git(repo, 'checkout -q -b dean/fixture');
        return new PreparedFixture(repo, root, fixture.stdin.split(REPO_TOKEN).join(repo));
    }

    private repoConfig(fixture: GoldenFixture): string {
        if (!fixture.crashingRulesDir) return this.configJson;
        // webpieces-disable no-any-unknown -- the frozen fixture config is data on disk; re-parsing it into a named type here would be a second declaration of a file whose whole point is being literal
        const parsed = JSON.parse(this.configJson) as Record<string, unknown>;
        parsed['rulesDir'] = ['wprules'];
        return JSON.stringify(parsed, null, 4);
    }

    private git(repo: string, args: string): void {
        execSync(`git ${args}`, { cwd: repo, encoding: 'utf8' });
    }
}
