import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';

import { renderShim } from './shim';

/**
 * `$CMD` and `$CMD_LOG` look like the same extraction written twice. They are a SECURITY BOUNDARY, and
 * until this spec existed a code comment was the only thing holding it.
 *
 *   $CMD      — the DECISION input. The L0 allowlist greps it. Its sed pattern requires the CLOSING
 *               quote, so a JSON payload that escapes an embedded quote as \\" yields the EMPTY STRING.
 *               That is the SAFE direction: empty matches no allowlist entry, so the call falls to the
 *               deny. FAIL CLOSED.
 *   $CMD_LOG  — the AUDIT input, and nothing else. It drops the closing quote so it captures the
 *               command PREFIX instead of nothing (79.5% of shim audit lines used to record no command).
 *
 * WHY THEY CANNOT BE MERGED: every L0 allowlist ERE is anchored `^…[[:space:]]*$` and tolerates
 * trailing whitespace. Give $CMD the audit pattern and `pnpm install "; rm -rf /"` captures as
 * `pnpm install ` — which MATCHES — so the injection after the quote rides through allowlisted.
 *
 * These tests fail the build if anyone "simplifies" that away.
 */
const SHIM = renderShim();

// Every line that mentions CMD_LOG, so the assertions below can be about ROLE rather than position.
function linesWith(token: string): readonly string[] {
    return SHIM.split('\n').filter((l: string): boolean => l.includes(token));
}

describe('the $CMD / $CMD_LOG boundary', () => {
    it('defines both, from DIFFERENT sed patterns', () => {
        const cmd = linesWith('CMD="$(printf');
        const log = linesWith('CMD_LOG="$(printf');
        expect(cmd.length).toBe(1);
        expect(log.length).toBe(1);
        expect(cmd[0]).not.toBe(log[0]);
    });

    // The decision pattern ends with a CLOSING quote; the audit one deliberately does not.
    it('keeps the CLOSING quote only on the decision pattern', () => {
        const cmd = linesWith('CMD="$(printf')[0];
        const log = linesWith('CMD_LOG="$(printf')[0];
        expect(cmd).toContain('\\)".*/');
        expect(log).not.toContain('\\)".*/');
    });

    /**
     * THE LOAD-BEARING ASSERTION. `CMD_LOG` may appear only where it is defined, where it falls back to
     * `$CMD`, and in the audit `printf`. If it ever shows up on a line that also greps, tests or
     * branches, the decision path has started reading the permissive value.
     */
    it('never lets CMD_LOG reach a decision', () => {
        for (const line of linesWith('CMD_LOG')) {
            const isDefinition = line.includes('CMD_LOG="$(printf') || line.includes('CMD_LOG="$CMD"');
            const isAuditPrintf = line.includes('>> "$_wp_f"');
            if (isDefinition || isAuditPrintf) continue;
            throw new Error(`CMD_LOG reached a non-audit line, which may be a decision path:\n  ${line}`);
        }
    });

    // Only the greps whose INPUT is the command matter here; the shim also greps package.json for the
    // version-drift scrape, and that has nothing to do with this boundary.
    it('greps the L0 allowlist against $CMD, never $CMD_LOG', () => {
        const commandGreps = SHIM.split('\n').filter(
            (l: string): boolean => l.includes('grep -Eq') && l.includes('$CMD'));
        expect(commandGreps.length).toBeGreaterThan(0);
        for (const line of commandGreps) {
            expect(line).toContain('"$CMD"');
            expect(line).not.toContain('$CMD_LOG');
        }
    });
});

describe('the extraction behaves as specified, in real sh', () => {
    // Run the ACTUAL sed the shim runs, so this cannot pass on a TypeScript approximation.
    function extract(command: string): { decide: string; audit: string } {
        const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
        const script = `
CMD="$(printf '%s' "$1" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\\([^"\\\\]*\\)".*/\\1/p')"
CMD_LOG="$(printf '%s' "$1" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\\([^"\\\\]*\\).*/\\1/p')"
[ -n "$CMD_LOG" ] || CMD_LOG="$CMD"
printf '%s\\n%s' "$CMD" "$CMD_LOG"`;
        const out = spawnSync('sh', ['-c', script, 'sh', payload], { encoding: 'utf8' }).stdout ?? '';
        const [decide, audit] = out.split('\n');
        return { decide: decide ?? '', audit: audit ?? '' };
    }

    it('is identical for a command with no quotes', () => {
        const r = extract('pnpm install');
        expect(r.decide).toBe('pnpm install');
        expect(r.audit).toBe('pnpm install');
    });

    it('audits a useful prefix while the decision stays EMPTY on a quoted command', () => {
        const r = extract('cd /a/b && echo "hi"');
        expect(r.decide).toBe('');
        expect(r.audit).toBe('cd /a/b && echo ');
    });

    // The reason the merge is forbidden, pinned as a test.
    it('cannot let an injection after a quote reach the decision input', () => {
        const r = extract('pnpm install "; rm -rf /"');
        expect(r.decide).toBe('');            // matches no allowlist entry -> falls to the deny
        expect(r.audit).toBe('pnpm install '); // …which is exactly what WOULD have matched. Hence two vars.
    });

    it('leaves single-quoted paths fully intact for BOTH, so the cd-prefix cure still matches', () => {
        const r = extract("cd '/path with spaces' && pnpm install");
        expect(r.decide).toBe("cd '/path with spaces' && pnpm install");
        expect(r.audit).toBe(r.decide);
    });
});
