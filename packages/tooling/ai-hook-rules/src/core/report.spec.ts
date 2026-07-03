import { formatReport } from './report';
import { RuleGroup, Violation } from './types';
import { FixHint, Option, DisableEscape } from './fix-hint';

function report(fixHint: FixHint, violation: Violation): string {
    return formatReport('src/x.ts', [new RuleGroup('demo-rule', 'demo description', fixHint, [violation])]);
}

describe('formatReport — violation line', () => {
    it('falls back to FixHint.violation when the Violation carries no message', () => {
        const out = report(new FixHint('the canonical what-is-wrong', 'fix it'), new Violation(1, 'bad line'));
        expect(out).toContain('→ the canonical what-is-wrong');
    });

    it('uses the per-occurrence Violation.message as an override when present', () => {
        const out = report(new FixHint('the canonical what-is-wrong', 'fix it'), new Violation(1, 'bad line', 'Parameter "x" has no type'));
        expect(out).toContain('→ Parameter "x" has no type');
        expect(out).not.toContain('→ the canonical what-is-wrong');
    });
});

describe('formatReport — options', () => {
    it('numbers options once and renders (preferred) from the boolean, no double-labeling', () => {
        const out = report(
            new FixHint('what', 'Pick one:', [
                new Option('do the right thing', true),
                new Option('an alternative'),
            ]),
            new Violation(1, 'x'),
        );
        expect(out).toContain('  Pick one:');
        expect(out).toContain('Fix Option 1: (preferred) do the right thing');
        expect(out).toContain('Fix Option 2: an alternative');
        expect(out).not.toContain('Fix Option 3');
        expect(out).not.toContain('(preferred) an alternative');
    });

    it('indents multi-line option bodies under the option, not renumbered', () => {
        const out = report(
            new FixHint('what', 'Pick one:', [new Option('ask the human:\n  - detail one\n  - detail two')]),
            new Violation(1, 'x'),
        );
        expect(out).toContain('Fix Option 1: ask the human:');
        expect(out).toContain('    - detail one');
        expect(out).not.toContain('Fix Option 2');
    });

    it('emits no Fix Option lines when there are zero options', () => {
        const out = report(new FixHint('what', 'just do the thing'), new Violation(1, 'x'));
        expect(out).toContain('  just do the thing');
        expect(out).not.toContain('Fix Option');
    });

    it('skips an empty mainMessage', () => {
        const out = report(new FixHint('what', ''), new Violation(1, 'x'));
        expect(out).not.toContain('  \n  Fix');
        expect(out).toContain('→ what');
    });
});

describe('formatReport — disable escape', () => {
    it('shows the Escape line when disableAllowed is true', () => {
        const out = report(
            new FixHint('what', 'fix it', [], new DisableEscape(true, '// webpieces-disable demo-rule -- <reason>')),
            new Violation(1, 'x'),
        );
        expect(out).toContain('Escape (if truly needed): // webpieces-disable demo-rule -- <reason>');
        expect(out).not.toContain('must be followed');
    });

    it('shows the must-be-followed line (no escape) when disableAllowed is false', () => {
        const out = report(
            new FixHint('what', 'fix it', [], new DisableEscape(false, '// webpieces-disable demo-rule -- <reason>')),
            new Violation(1, 'x'),
        );
        expect(out).toContain('it must be followed.');
        expect(out).toContain('disableAllowed:false');
        expect(out).not.toContain('// webpieces-disable demo-rule');
        expect(out).not.toContain('Escape (if truly needed)');
    });

    it('omits the escape section entirely for guard rules (no escape set)', () => {
        const out = report(new FixHint('what', 'fix it'), new Violation(1, 'x'));
        expect(out).not.toContain('Escape (if truly needed)');
        expect(out).not.toContain('must be followed');
    });
});
