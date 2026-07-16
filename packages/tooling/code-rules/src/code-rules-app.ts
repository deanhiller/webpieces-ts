import { DocumentDesign } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

import { CodeRulesEngine } from './code-rules-engine';
import { ExecutorResult } from './code-validator';

/**
 * The code-rules application root. `container.get(CodeRulesApp)` resolves the entire validator DAG
 * (engine → 18 injected validators → their bound configs + shared helpers). `@DocumentDesign` marks
 * it the top-of-DAG the DI-design analyzer roots on, so `role:app` code-rules draws its design.
 */
@DocumentDesign()
@injectable(bindingScopeValues.Singleton)
export class CodeRulesApp {
    constructor(private readonly engine: CodeRulesEngine) {}

    /** Run every configured code validator against the workspace root bound at bootstrap. */
    run(): Promise<ExecutorResult> {
        return this.engine.run();
    }
}
