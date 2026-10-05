import * as path from 'path';
import * as ts from 'typescript';
import { loadAndValidate, RuleFailError } from '@webpieces/rules-config';
import type { ProjectInfo } from '../project-info';
import { RuleGate } from '../rule-gate';
import { WiringProjectProgram } from './source-extractor';
import { WiringFormat } from './wiring-format';

/** Every participating canonical file is checked, irrespective of the current diff. */
export class WorkspaceWiringFormat {
    assert(root: string, infos: ReadonlyMap<string, ProjectInfo>, maxLines: number): void {
        const problems: string[] = [];
        for (const info of infos.values()) {
            if (!info.tags.some((tag: string) => ['webpieces', 'webpieces-lib'].includes(tag))) continue;
            const program = new WiringProjectProgram().create(root, info);
            const file = program.getSourceFile(path.resolve(root, info.root, 'src/wiring.ts'));
            if (file === undefined) problems.push(`${info.root}/src/wiring.ts: missing canonical Wiring/AppWiring declaration.`);
            else problems.push(...new WiringFormat(program.getTypeChecker(), maxLines).problems(file));
        }
        // Rendering the aggregate needs no source compiler.
        new WiringFormat(ts.createProgram([], {}).getTypeChecker(), maxLines).assert(problems);
    }

    run(root: string, infos: ReadonlyMap<string, ProjectInfo>): void {
        if (new RuleGate().skipReason(root, 'wiring-format', true) !== null) return;
        const rule = loadAndValidate(root).resolved.rules.get('wiring-format');
        const maxLines = rule?.options['maxLines'];
        if (typeof maxLines !== 'number' || !Number.isInteger(maxLines) || maxLines < 1)
            throw new RuleFailError('wiring-format', 'Declare wiring-format.maxLines as a positive integer (agreed limit: 200).');
        this.assert(root, infos, maxLines);
    }
}
