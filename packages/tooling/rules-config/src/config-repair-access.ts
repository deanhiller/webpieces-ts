import { injectable, bindingScopeValues } from 'inversify';
import { ConfigRepairProbe } from './config-repair-probe';

/** Repair access has one canonical probe shared with the bootstrap shim. */
@injectable(bindingScopeValues.Singleton)
export class ConfigRepairAccess {
    isRepairFile(root: string, filename: string): boolean {
        return new ConfigRepairProbe().isRepairFile(root, filename);
    }

    /** The one L0 edit-escape verdict both shim halves ask — see ConfigRepairProbe.recoveryVerdict. */
    recoveryVerdict(cwd: string, toolName: string, filePath: string, command: string): readonly string[] {
        return new ConfigRepairProbe().recoveryVerdict(cwd, toolName, filePath, command);
    }

    /** `functions.apply_patch` → `apply_patch`; every other tool name unchanged. */
    canonicalTool(toolName: string): string {
        return new ConfigRepairProbe().canonicalTool(toolName);
    }
}
