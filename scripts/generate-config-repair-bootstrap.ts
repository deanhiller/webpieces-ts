import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

/** Compile the dependency-free repair probe before guard renderers import its serialized artifact. */
class RepairBootstrapGenerator {
    run(): void {
        const directory = path.join(__dirname, '../packages/tooling/rules-config/src');
        const filename = path.join(directory, 'config-repair-probe.ts');
        const source = ts.createSourceFile(
            filename,
            fs.readFileSync(filename, 'utf8'),
            ts.ScriptTarget.Latest,
            true,
        );
        const declaration = source.statements.find(
            (statement: ts.Statement) =>
                ts.isClassDeclaration(statement) && statement.name?.text === 'ConfigRepairProbe',
        ) as ts.ClassDeclaration;
        if (!declaration) throw new Error('ConfigRepairProbe source declaration is missing.');
        const plain = ts.factory.updateClassDeclaration(
            declaration,
            undefined,
            declaration.name,
            undefined,
            undefined,
            declaration.members,
        );
        const printed = ts.createPrinter().printNode(ts.EmitHint.Unspecified, plain, source);
        const compiled = ts.transpileModule(printed, {
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
        }).outputText;
        fs.writeFileSync(
            path.join(directory, 'config-repair-bootstrap-source.ts'),
            '/** Generated from ConfigRepairProbe by pnpm guards:generate; never edit this artifact. */\n' +
                '// webpieces-disable no-unmanaged-exceptions -- serialized bootstrap catches malformed external declarations without package imports\n' +
            `export const CONFIG_REPAIR_BOOTSTRAP_SOURCE = ${JSON.stringify(compiled)};\n`,
        );
    }
}

new RepairBootstrapGenerator().run();
