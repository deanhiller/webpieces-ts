import * as fs from 'fs';
import * as ts from 'typescript';
import { GraphVisualizer } from '../packages/tooling/nx-webpieces-rules/src/lib/graph-visualizer';
import { ArchitectureGenerator } from '../packages/tooling/nx-webpieces-rules/src/executors/generate/executor';
import { renderRuleFailForHuman, RuleFailError } from '@webpieces/rules-config';

/** Supply browser assets to the source generator through its normal visualization dependency. */
class WiringSourceGeneration {
    private client(name: string): string {
        return ts.transpileModule(
            fs.readFileSync(`packages/tooling/nx-webpieces-rules/src/lib/${name}.ts`, 'utf8'),
            { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
        ).outputText;
    }

    run(): Promise<void> {
        const visualizer = new GraphVisualizer(
            (): string => this.client('graph-visualizer.client'),
            (): string => this.client('graph-filter.client'),
        );
        return new ArchitectureGenerator(visualizer).generate(process.cwd(), 'architecture/dependencies.json');
    }
}

new WiringSourceGeneration().run().catch((error: Error) => {
    console.error(error instanceof RuleFailError ? renderRuleFailForHuman(error) : error.message);
    process.exitCode = 1;
});
