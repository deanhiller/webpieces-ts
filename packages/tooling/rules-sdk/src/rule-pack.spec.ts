import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FieldDef, BASE_RULE_SCHEMA } from './index';

class ContractSources {
    static imports(): string[] {
        const files = fs.readdirSync(__dirname).filter(file => file.endsWith('.ts') && !file.endsWith('.spec.ts'));
        return files.flatMap(file => [...fs.readFileSync(path.join(__dirname, file), 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1]));
    }
}

describe('rules SDK remains a pure leaf', () => {
    it('has no filesystem, Git, Nx, DI, execution-engine, or concrete schema dependencies', () => {
        expect(ContractSources.imports().filter(moduleName => !moduleName.startsWith('./'))).toEqual([]);
    });

    it('keeps universal escape hatch fields required and branch omission explicit', () => {
        expect(BASE_RULE_SCHEMA.turnOffRuleUntilEpoch.type).toBe('number');
        expect(BASE_RULE_SCHEMA.turnOffRuleUntilEpoch.optional).toBe(false);
        expect(BASE_RULE_SCHEMA.turnOffRuleWhileOnBranch.optional).toBe(false);
        expect(BASE_RULE_SCHEMA.turnOffRuleWhileOnBranch.nullable).toBe(true);
        expect(FieldDef.optional('number').optional).toBe(true);
    });
});
