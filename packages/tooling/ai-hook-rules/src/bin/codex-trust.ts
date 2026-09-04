import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';

import { toError } from '../core/to-error';
import { CODEX_REGISTRATION, isManagedCommand, readSettings } from './hook-registration';
import type { HookCommand, HookEntry } from './settings-shape';

/**
 * CODEX HOOK TRUST — read it, report it, NEVER write it.
 *
 * ─── What Codex actually does ─────────────────────────────────────────────────────────────────────
 * Codex trusts a hook entry TOFU. On first sight of a new or changed entry it PROMPTS
 * (`Hooks need review / 1 hook is new or changed`) and, if the human accepts, records a hash in
 * `~/.codex/config.toml`:
 *
 *     [hooks.state."<abs path to .codex/hooks.json>:pre_tool_use:<group>:<index>"]
 *     trusted_hash = "sha256:…"
 *
 * ─── Why this only ever REPORTS ───────────────────────────────────────────────────────────────────
 * The hash is NOT reproducible from outside Codex. Sixteen encodings were tried against a hooks.json we
 * wrote ourselves and none of them produced the recorded value. So an installer that tried to write one
 * would be guessing at a security decision on a human's behalf, and would either be ignored or — worse —
 * appear to succeed. Forging it is not on the table even if the encoding were known: the prompt IS the
 * mechanism, and the whole point of TOFU is that a person saw the command once.
 *
 * The consequence the installer must therefore SAY OUT LOUD: the prompt's third option is
 * `Continue without trusting (hooks won't run)`. That is one keystroke to a fully unguarded session,
 * with no later warning of any kind. Install-time verification cannot see that choice — it happens
 * afterwards, in another process — so this check reports the trust state it CAN read, names the file it
 * read it from, and stops there.
 *
 * Declining the prompt is a HUMAN's decision about their own machine, and it is deliberately left
 * standing. Tooling that tried to detect and refuse it afterwards would be voiding a setting a person
 * chose on purpose, and it has nothing to catch besides: the guards constrain the AGENT, while the
 * prompt is answered by the HUMAN, who the agent cannot impersonate. So there is no second mechanism
 * downstream of this one — this report is the whole of what webpieces knows about Codex trust.
 */

/** What one repo's Codex trust looks like right now. Data-only → a class, per CLAUDE.md. */
export class CodexTrustStatus {
    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        /** `~/.codex/config.toml`, named even when it does not exist so the report can point at it. */
        readonly configPath: string,
        readonly configExists: boolean,
        /** `[projects."<root>"] trust_level = "trusted"`. */
        readonly projectTrusted: boolean,
        /** The repo's `.codex/hooks.json`, absolute — the key every `hooks.state` entry is prefixed by. */
        readonly hooksPath: string,
        /** How many webpieces-managed PreToolUse entries that file registers. 0 ⇒ Codex is not armed. */
        readonly registeredEntries: number,
        /** How many of them `~/.codex/config.toml` records a `trusted_hash` for. */
        readonly trustedEntries: number,
    ) {}

    /** True when Codex is armed here AND every entry it would run is trusted. */
    fullyTrusted(): boolean {
        return this.registeredEntries > 0 && this.trustedEntries >= this.registeredEntries && this.projectTrusted;
    }

    /** True when there is nothing to say — this repo has not armed Codex at all. */
    notArmed(): boolean {
        return this.registeredEntries === 0;
    }

    /**
     * The report, as lines. It states what IS, then the one action that changes it — and the action is
     * always the human's, because nothing here can be repaired by a tool.
     */
    lines(): readonly string[] {
        if (this.notArmed()) return [];
        if (this.fullyTrusted()) {
            return [`  ✅ Codex trusts all ${String(this.registeredEntries)} webpieces hook(s) in ${this.hooksPath}`];
        }
        const out: string[] = [];
        out.push(`  ⚠️  Codex has NOT yet trusted the webpieces hooks in ${this.hooksPath}`);
        if (!this.configExists) {
            out.push(`     ${this.configPath} does not exist yet — Codex has never run for this user.`);
        } else if (!this.projectTrusted) {
            out.push('     this project is not marked trusted in ~/.codex/config.toml.');
        }
        if (this.trustedEntries < this.registeredEntries) {
            out.push(`     ${String(this.trustedEntries)} of ${String(this.registeredEntries)} hook entries carry a trusted_hash.`);
        }
        out.push('     Fix: run `codex` in this repo and choose "Trust all" when it asks about hooks.');
        out.push('     Its third option ("Continue without trusting") leaves the session UNGUARDED for its');
        out.push('     whole life, and nothing later in the run reports that — this message is the only notice.');
        return out;
    }
}

/**
 * Reads Codex's trust state. Never writes, never throws — an unreadable or absent config reports as
 * "not trusted", which is the true and safe answer.
 */
export class CodexTrustProbe {
    /** `~/.codex/config.toml`. `homeDir` is injectable so a unit test never reads the real one. */
    configPath(homeDir: string = homedir()): string {
        return path.join(homeDir, '.codex', 'config.toml');
    }

    read(projectRoot: string, homeDir: string = homedir()): CodexTrustStatus {
        const configPath = this.configPath(homeDir);
        const hooksPath = path.join(projectRoot, ...CODEX_REGISTRATION.settingsFiles[0].split('/'));
        const registered = this.registeredEntryCount(hooksPath);
        const raw = this.readOrEmpty(configPath);
        return new CodexTrustStatus(
            configPath, raw !== null, this.projectTrusted(raw ?? '', projectRoot),
            hooksPath, registered, this.trustedEntryCount(raw ?? '', hooksPath),
        );
    }

    /**
     * How many webpieces-managed PreToolUse commands `.codex/hooks.json` registers.
     *
     * It counts what WE own, not every hook in the file: a consumer's own unrelated hook is none of this
     * check's business, and counting it would make the report say "1 of 3 trusted" about hooks webpieces
     * neither wrote nor can advise on.
     */
    private registeredEntryCount(hooksPath: string): number {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            if (!fs.existsSync(hooksPath)) return 0;
            const entries: readonly HookEntry[] = readSettings(hooksPath).hooks?.PreToolUse ?? [];
            return entries.reduce(
                (total: number, entry: HookEntry): number =>
                    total + entry.hooks.filter((h: HookCommand): boolean => isManagedCommand(h.command)).length,
                0,
            );
        } catch (err: unknown) {
            const error = toError(err);
            void error; // an unreadable/invalid hooks.json is "not armed"; the drift check is what reports that
            return 0;
        }
    }

    private readOrEmpty(configPath: string): string | null {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null;
        } catch (err: unknown) {
            const error = toError(err);
            void error; // unreadable → treated as absent, which reports as "not trusted"
            return null;
        }
    }

    /**
     * `[projects."<root>"]` carrying `trust_level = "trusted"`.
     *
     * A LINE SCAN, not a TOML parser, and deliberately: this package must load on a tree too broken to
     * build a DI container, so it takes no dependency it does not need, and the two shapes it reads are
     * both written by Codex itself in one fixed form. It over-reports "not trusted" for anything it
     * cannot recognise, which is the safe direction — the consequence is one advisory line too many,
     * never a session reported as guarded when it is not.
     */
    private projectTrusted(raw: string, projectRoot: string): boolean {
        return this.sectionBody(raw, `projects."${projectRoot}"`)
            .some((line: string): boolean => /^\s*trust_level\s*=\s*"trusted"\s*$/.test(line));
    }

    /**
     * How many `hooks.state."<hooksPath>:pre_tool_use:<group>:<index>"` sections carry a `trusted_hash`.
     *
     * The count is compared against the number of entries the file registers rather than matched
     * one-for-one to a specific group/index: the group and index are Codex's own numbering of a file it
     * re-reads on every launch, and an installer that assumed a numbering would report a false alarm the
     * first time Codex renumbered.
     */
    private trustedEntryCount(raw: string, hooksPath: string): number {
        const prefix = `hooks.state."${hooksPath}:pre_tool_use:`;
        let trusted = 0;
        let inEntry = false;
        for (const line of raw.split('\n')) {
            const header = this.headerOf(line);
            if (header !== null) inEntry = header.startsWith(prefix);
            else if (inEntry && /^\s*trusted_hash\s*=\s*"/.test(line)) trusted += 1;
        }
        return trusted;
    }

    /** The body lines of one TOML section, or [] when the file carries no such header. */
    private sectionBody(raw: string, wanted: string): readonly string[] {
        const body: string[] = [];
        let inside = false;
        for (const line of raw.split('\n')) {
            const header = this.headerOf(line);
            if (header !== null) inside = header === wanted;
            else if (inside) body.push(line);
        }
        return body;
    }

    /** The `<name>` of a `[<name>]` header line, or null for anything else. */
    private headerOf(line: string): string | null {
        const match = /^\s*\[([^\]]+)\]\s*$/.exec(line);
        return match === null ? null : match[1];
    }
}
