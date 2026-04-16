import type { BashRule, BashContext, Violation } from '../types';
import { Violation as V } from '../types';

const FIX_HINT: readonly string[] = [
    'Shell substitutions trigger Claude Code "simple_expansion" permission prompts that interrupt the user.',
    'Instead:',
    '  • Build payload files with Write, then: node script.js < /path/to/payload',
    '  • Use Read, Grep, or Glob instead of piping shell output through $(...)',
    '  • Write a small script file with Write and execute it: bash /path/to/script.sh',
];

const noShellSubstitutionRule: BashRule = {
    name: 'no-shell-substitution',
    description: 'Reject Bash commands containing shell substitutions ($(...), backticks, $VAR).',
    scope: 'bash',
    files: [],
    defaultOptions: {},
    fixHint: FIX_HINT,

    check(ctx: BashContext): readonly Violation[] {
        const scanned = stripSingleQuoted(ctx.command);
        const violations: Violation[] = [];

        if (/\$\(/.test(scanned)) {
            violations.push(new V(
                1,
                truncate(ctx.command),
                'Command contains `$(...)` command substitution.',
            ));
        }
        if (hasUnescapedBacktick(scanned)) {
            violations.push(new V(
                1,
                truncate(ctx.command),
                'Command contains backtick command substitution.',
            ));
        }
        if (/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(scanned) || hasBareVarExpansion(scanned)) {
            violations.push(new V(
                1,
                truncate(ctx.command),
                'Command contains `$VAR` or `${VAR}` variable expansion.',
            ));
        }
        return violations;
    },
};

function stripSingleQuoted(cmd: string): string {
    return cmd.replace(/'[^']*'/g, "''");
}

function hasUnescapedBacktick(cmd: string): boolean {
    for (let i = 0; i < cmd.length; i += 1) {
        if (cmd[i] === '`' && (i === 0 || cmd[i - 1] !== '\\')) return true;
    }
    return false;
}

function hasBareVarExpansion(cmd: string): boolean {
    const re = /(^|[^\\])\$([A-Za-z_][A-Za-z0-9_]*)/g;
    return re.test(cmd);
}

function truncate(s: string): string {
    const MAX = 120;
    if (s.length <= MAX) return s;
    return s.slice(0, MAX) + '…';
}

export default noShellSubstitutionRule;
