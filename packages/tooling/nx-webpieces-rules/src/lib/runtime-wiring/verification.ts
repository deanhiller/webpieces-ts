import * as fs from 'fs';
import * as path from 'path';
import { Option, RuleFailError } from '@webpieces/rules-config';
import type { ProjectInfo } from '../project-info';
import { RuntimeDeclarationCodec } from './codec';
import { WiringProjectProgram, WiringSourceExtractor } from './source-extractor';
import { RuntimeDeclaration } from './declaration';

/** Candidates are build outputs. The verifier has no code path that writes the approved file. */
export class RuntimeWiringVerification {
    verify(
        workspaceRoot: string,
        info: ProjectInfo,
        infos: ReadonlyMap<string, ProjectInfo>,
        outputPath: string,
    ): void {
        const candidate = new WiringSourceExtractor(
            workspaceRoot,
            info,
            infos,
            new WiringProjectProgram().create(workspaceRoot, info),
        ).extract();
        const candidatePath = path.join(workspaceRoot, outputPath, 'runtime-deps.candidate.json');
        const approvedPath = path.join(workspaceRoot, info.root, 'runtime-deps.json');
        fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
        const actual = this.format(candidate);
        fs.writeFileSync(candidatePath, actual, 'utf8');
        if (!fs.existsSync(approvedPath))
            this.fail(`Missing approved declaration ${approvedPath}. Candidate: ${candidatePath}.`);
        const approved = new RuntimeDeclarationCodec().decode(
            fs.readFileSync(approvedPath, 'utf8'),
            info.name,
        );
        const expected = this.format(approved);
        if (expected !== actual)
            this.fail(
                `${info.name} runtime wiring changed. Approved: ${approvedPath}. Candidate: ${candidatePath}.\n${this.diff(expected, actual)}`,
            );
    }

    format(declaration: RuntimeDeclaration): string {
        const exports = Object.fromEntries(
            Object.entries(declaration.exports).sort((left, right) =>
                left[0].localeCompare(right[0]),
            ),
        );
        return JSON.stringify(newDeclaration(declaration, exports), null, 4) + '\n';
    }

    private diff(expected: string, actual: string): string {
        const before = expected.split('\n');
        const after = actual.split('\n');
        const lines: string[] = [];
        for (let index = 0; index < Math.max(before.length, after.length); index++) {
            if (before[index] === after[index]) continue;
            if (before[index] !== undefined) lines.push(`- ${before[index]}`);
            if (after[index] !== undefined) lines.push(`+ ${after[index]}`);
        }
        return lines.join('\n');
    }

    private fail(message: string): never {
        throw new RuleFailError('validate-runtime-architecture', message, undefined, undefined, [
            new Option(
                'Review the candidate diff, fix incorrect wiring, then explicitly copy the reviewed candidate to runtime-deps.json. Builds never approve it automatically.',
                true,
            ),
        ]);
    }
}

// webpieces-disable no-function-outside-class -- canonical serialization of a reviewed declaration
function newDeclaration(
    declaration: RuntimeDeclaration,
    exports: RuntimeDeclaration['exports'],
): RuntimeDeclaration {
    return new RuntimeDeclaration(
        declaration.project,
        declaration.framework,
        exports,
        declaration.entry,
        declaration.host,
    );
}
