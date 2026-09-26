import { describe, expect, it } from 'vitest';
import { CheckPrCommand, PrUnderCheck } from './check-pr-command';

class TestCheckPrCommand extends CheckPrCommand {
    constructor() {
        super(null!, null!);
    }

    success(pr: PrUnderCheck): string {
        return this.successMessage(pr);
    }

    failure(pr: PrUnderCheck): string {
        return this.failureMessage(pr);
    }
}

describe('wp-check-pr gate-path messaging', () => {
    const command = new TestCheckPrCommand();
    const pr = new PrUnderCheck('42', 'abcdef1234567890', 'body');

    it('explains that a valid token can come from either supported path', () => {
        expect(command.success(pr)).toContain('automated gate or explicit human escape hatch');
    });

    it('labels both recovery paths and forbids AI attestation', () => {
        const message = command.failure(pr);
        expect(message).toContain('wp-start-upsert-pr');
        expect(message).toContain('pnpm wp-human-post-pr');
        expect(message).toContain('AI must never answer');
    });
});
