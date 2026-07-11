import { DocumentDesign } from '@webpieces/core-util';
import { provideSingleton } from '@webpieces/core-context';
import { injectable } from 'inversify';

import { CodeRulesEngine } from './code-rules-engine';
import { ExecutorResult } from './code-validator';

/**
 * The code-rules application root. `container.get(CodeRulesApp)` resolves the entire validator DAG
 * (engine → 18 injected validators → their bound configs + shared helpers). `@DocumentDesign` marks
 * it the top-of-DAG the DI-design analyzer roots on, so `role:app` code-rules draws its design.
 */
@DocumentDesign()
@provideSingleton()
@injectable()
export class CodeRulesApp {
    constructor(private readonly engine: CodeRulesEngine) {}

    /** Run every configured code validator against the workspace root bound at bootstrap. */
    run(): Promise<ExecutorResult> {
        return this.engine.run();
    }
}
