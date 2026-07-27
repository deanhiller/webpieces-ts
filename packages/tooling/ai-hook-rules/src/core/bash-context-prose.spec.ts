import { describe, it, expect } from 'vitest';
import { BashContext } from './types';

const code = (command: string): string => new BashContext(command, '/repo').commandCode;

// Every blocklist-shaped guard matches on ctx.commandCode, so these cases decide what they see. The
// guards' own regexes are tested in their specs; this pins the ONE input transformation they share.
describe('BashContext.commandCode strips prose so guards do not block writing about the tooling', () => {
    it('drops a heredoc body — the case that blocked committing this feature', () => {
        const command = "git commit -F - <<'EOF'\nRedirect a hand-rolled gh pr merge to wp-land-pr\nEOF";
        expect(code(command)).not.toContain('gh pr merge');
        expect(code(command)).toContain('git commit');
    });

    it('drops an unquoted heredoc body and the `<<-` form too', () => {
        expect(code('cat <<EOF\ngit push --force\nEOF')).not.toContain('git push');
        expect(code('cat <<-END\ngh pr create\nEND')).not.toContain('gh pr create');
    });

    it('drops a quoted commit message that merely mentions a blocked command', () => {
        expect(code('git commit -m "explain why git push is blocked"')).not.toContain('git push');
    });

    it('KEEPS a quoted span with no whitespace — `"main"` is an argument, not prose', () => {
        expect(code('git checkout "main"')).toContain('git checkout main');
    });

    it('leaves an ordinary command untouched', () => {
        expect(code('gh pr merge --squash')).toBe('gh pr merge --squash');
        expect(code('git push origin HEAD')).toBe('git push origin HEAD');
    });

    /**
     * The deliberate cost of this trade, pinned so nobody "fixes" it by accident and nobody is
     * surprised by it later. Stripping quoted spans means a command SMUGGLED inside quotes stops
     * matching. That is acceptable ONLY because these guards catch a forgetful agent, not an
     * adversarial one — if that threat model ever changes, this test is the thing that must change
     * first. It asserts the hole exists rather than pretending it does not.
     */
    it('KNOWN HOLE: a command hidden in a shell -c string no longer matches', () => {
        expect(code("sh -c 'gh pr merge --squash'")).not.toContain('gh pr merge');
    });

    it('is computed for every context, so a guard can never read undefined and fail open', () => {
        expect(new BashContext('git status', '/repo').commandCode).toBe('git status');
        expect(typeof new BashContext('', '/repo').commandCode).toBe('string');
    });
});
