import { describe, it, expect } from 'vitest';

import { Option, formatFixOptions } from './fix-option';

describe('Option', () => {
    it('defaults preferred to false so the wide/first-choice claim is always explicit', () => {
        expect(new Option('do the thing').preferred).toBe(false);
        expect(new Option('do the thing', true).preferred).toBe(true);
    });
});

describe('formatFixOptions — the ONE renderer both engines use', () => {
    it('renders nothing for no cures (so callers can concatenate unconditionally)', () => {
        expect(formatFixOptions([])).toEqual([]);
    });

    it('owns the numbering, so a rule author never hand-writes "1." inside a message', () => {
        expect(formatFixOptions([new Option('alpha'), new Option('beta')])).toEqual([
            '  Fix Option 1: alpha',
            '  Fix Option 2: beta',
        ]);
    });

    it('owns the "(preferred)" tag', () => {
        expect(formatFixOptions([new Option('alpha', true)])).toEqual([
            '  Fix Option 1: (preferred) alpha',
        ]);
    });

    it('indents continuation lines of a multi-line cure under the option', () => {
        expect(formatFixOptions([new Option('alpha\n- detail one\n- detail two')])).toEqual([
            '  Fix Option 1: alpha',
            '    - detail one',
            '    - detail two',
        ]);
    });

    it('honours the caller indent (code-rules prints one space deeper than the hook report)', () => {
        expect(formatFixOptions([new Option('alpha\nmore')], '   ')).toEqual([
            '   Fix Option 1: alpha',
            '     more',
        ]);
    });
});
