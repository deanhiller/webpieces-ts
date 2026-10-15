import { describe, expect, it } from 'vitest';
import { InformAiError } from './inform-ai-error';

/**
 * #1273: an installed release nests a private copy of tooling-common inside every @webpieces package, so the
 * InformAiError a library throws and the one a hook adapter checks against are DIFFERENT classes. Before the
 * brand, `instanceof` said no, and a plain config problem became "hook crashed unexpectedly" on every call.
 */
describe('InformAiError is recognised across package copies', () => {
    it('matches an error constructed by a second, separately loaded copy of this module', async () => {
        // A query string makes the module loader evaluate the file a second time: a genuinely separate class.
        const secondCopy = './inform-ai-error?second-copy';
        const copy = (await import(secondCopy)) as { InformAiError: typeof InformAiError };
        expect(copy.InformAiError).not.toBe(InformAiError);
        const fromOtherCopy = new copy.InformAiError('config needs repair');
        expect(fromOtherCopy instanceof InformAiError).toBe(true);
        expect(new InformAiError('x') instanceof copy.InformAiError).toBe(true);
    });

    it('does not match a plain Error, a non-error, or a look-alike without the brand', () => {
        expect(new Error('x') instanceof InformAiError).toBe(false);
        expect(('InformAiError' as unknown) instanceof InformAiError).toBe(false);
        const lookAlike = new Error('x');
        lookAlike.name = 'InformAiError';
        expect(lookAlike instanceof InformAiError).toBe(false);
    });

    it('keeps ordinary prototype semantics for a subclass', () => {
        class Narrower extends InformAiError {}
        expect(new Narrower('x') instanceof InformAiError).toBe(true);
        expect(new Narrower('x') instanceof Narrower).toBe(true);
        expect(new InformAiError('x') instanceof Narrower).toBe(false);
    });
});
