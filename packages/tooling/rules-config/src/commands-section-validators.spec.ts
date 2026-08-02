import { validateCommandsSection } from './commands-section-validators';
import { validateTopLevelKeys } from './config-key-rules';

// Specs for the `commands` section and the shared key-level rules. Split out of validate-config.spec.ts
// to mirror the source split (commands-section-validators.ts / config-key-rules.ts) and to keep both
// files under the size limit.

describe('validateCommandsSection', () => {
    it('errors on a retired top-level pr-gate block', () => {
        const errors = validateCommandsSection({ 'pr-gate': { mode: 'OFF' } }, { mode: 'OFF' });
        expect(errors.some(e => e.includes('top-level "pr-gate" block is RETIRED'))).toBe(true);
    });

    it('validates commands.pr-gate (missing → error)', () => {
        const errors = validateCommandsSection({}, undefined);
        expect(errors.some(e => e.includes('[pr-gate] Not configured'))).toBe(true);
    });

    // The flat strings are RETIRED, not accepted-and-preferred-against. A config carrying them fails the
    // load with the move instruction; nothing reads them.
    it('rejects the retired flat command strings, naming their guardHints destination', () => {
        const errors = validateCommandsSection(
            { 'pr-gate': { mode: 'OFF' }, upsertPr: 'pnpm my-upsert-pr', mergeComplete: 'pnpm my-merge-complete' },
            undefined,
        );
        expect(errors.some(e => e.includes('"upsertPr" is a RETIRED') && e.includes('commands.guardHints.prCreationOrPush'))).toBe(true);
        expect(errors.some(e => e.includes('"mergeComplete" is a RETIRED') && e.includes('commands.guardHints.mergeInProgress'))).toBe(true);
    });

    it('rejects an unknown key in the commands section and points at the *Why convention', () => {
        const errors = validateCommandsSection({ 'pr-gate': { mode: 'OFF' }, buildCommand: 'pnpm ci' }, undefined);
        expect(errors.some(e => e.includes('[commands] Unknown key "buildCommand"'))).toBe(true);
        expect(errors.some(e => e.includes('"<key>Why"'))).toBe(true);
    });

    it('accepts a *Why rationale key beside a real key, and requires it to be a string', () => {
        expect(validateCommandsSection({ 'pr-gate': { mode: 'OFF' }, guardHintsWhy: 'why we set these' }, undefined)).toEqual([]);
        const errors = validateCommandsSection({ 'pr-gate': { mode: 'OFF' }, guardHintsWhy: 42 }, undefined);
        expect(errors.some(e => e.includes('"guardHintsWhy" is a *Why rationale note and must be a string'))).toBe(true);
    });

    it('rejects an unknown field inside guardHints (a hint nothing would ever read)', () => {
        const errors = validateCommandsSection({ 'pr-gate': { mode: 'OFF' }, guardHints: { prCreation: 'pnpm up' } }, undefined);
        expect(errors.some(e => e.includes('[commands.guardHints] Unknown key "prCreation"'))).toBe(true);
    });

    it('accepts a commands.guardHints object with valid command strings', () => {
        const errors = validateCommandsSection(
            { 'pr-gate': { mode: 'OFF' }, guardHints: { prCreationOrPush: 'pnpm up', mergeInProgress: 'pnpm fin' } },
            undefined,
        );
        expect(errors).toEqual([]);
    });

    it('rejects an empty guardHints command string', () => {
        const errors = validateCommandsSection({ 'pr-gate': { mode: 'OFF' }, guardHints: { prCreationOrPush: '  ' } }, undefined);
        expect(errors.some(e => e.includes('[commands] "guardHints.prCreationOrPush" must be a non-empty string'))).toBe(true);
    });

    it('rejects guardHints that is not an object', () => {
        const errors = validateCommandsSection({ 'pr-gate': { mode: 'OFF' }, guardHints: 'pnpm up' }, undefined);
        expect(errors.some(e => e.includes('[commands] "guardHints" must be an object'))).toBe(true);
    });
});

/**
 * Top-level strict rejection. Without it, a key retired at the top level — or simply misspelled — is
 * silently ignored: the config LOOKS configured while behaving as if it were not, and the dead key survives
 * every upgrade. That silence is the mechanism this whole PR exists to remove.
 */
describe('validateTopLevelKeys', () => {
    it('accepts the defined top-level sections', () => {
        expect(validateTopLevelKeys({
            rules: {}, hookGuards: {}, commands: {}, excludePaths: [], 'match-rules': [], rulesDir: [],
        })).toEqual([]);
    });

    it('rejects an unknown top-level key', () => {
        const errors = validateTopLevelKeys({ rules: {}, rulez: {} });
        expect(errors.some(e => e.includes('[webpieces.config.json] Unknown key "rulez"'))).toBe(true);
    });

    it('allows a *Why rationale note (this is how the file documents itself) and requires a string', () => {
        expect(validateTopLevelKeys({ rules: {}, upgradePolicyWhy: 'never released backwards-compatible' })).toEqual([]);
        const errors = validateTopLevelKeys({ rules: {}, upgradePolicyWhy: 42 });
        expect(errors.some(e => e.includes('must be a string'))).toBe(true);
    });

    // The retired top-level pr-gate block has its own precise "move it under commands" message from
    // validateCommandsSection. Reporting it here too would bury that instruction under a generic error.
    it('leaves the retired top-level pr-gate block to validateCommandsSection', () => {
        expect(validateTopLevelKeys({ rules: {}, 'pr-gate': {} })).toEqual([]);
    });
});
