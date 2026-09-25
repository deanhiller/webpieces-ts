import { summaryJsonSchemaHint } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
const PRE_FINISH_NOTICE = 'Compilation and tests will run during pnpm wp-finish-upsert-pr; they have not run yet.';

/** Pure instructions for the two hotfix handoffs, kept identical across stages ① and ②. */
@injectable(bindingScopeValues.Singleton)
export class HotfixInstructions {
    afterStart(summaryPath: string, context: string): string {
        return (
            '\n' +
            SEP +
            '⚠️ HOT FIX ⚠️ — reviews and policy checks are bypassed\n' +
            SEP +
            '\n' +
            PRE_FINISH_NOTICE +
            '\n\n' +
            context +
            '\n' +
            summaryJsonSchemaHint(summaryPath) +
            '\n\n' +
            'No reviewer agent runs for this /hotfix/ branch. After writing that meaningful summary, run:\n' +
            '  pnpm wp-finish-upsert-pr\n\n'
        );
    }

    reviewNoOp(summaryPath: string): string {
        return (
            '\n' +
            SEP +
            '⚠️ HOT FIX ⚠️\n' +
            SEP +
            '\n' +
            PRE_FINISH_NOTICE +
            '\n\n' +
            'Required and optional reviews are bypassed for this /hotfix/ branch. No reviewer agent ran.\n' +
            'No build, checklist scan,\n' +
            'diff materialization, reviewer briefing, or review receipt was produced by this command.\n\n' +
            summaryJsonSchemaHint(summaryPath) +
            '\n\n' +
            'Write the required summary, then run: pnpm wp-finish-upsert-pr\n\n'
        );
    }
}
