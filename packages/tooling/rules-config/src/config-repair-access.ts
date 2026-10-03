import { injectable, bindingScopeValues } from 'inversify';
import { ConfigRepairProbe } from './config-repair-probe';

/** Repair access has one canonical probe shared with the bootstrap shim. */
@injectable(bindingScopeValues.Singleton)
export class ConfigRepairAccess {
    isRepairFile(root: string, filename: string): boolean {
        return new ConfigRepairProbe().isRepairFile(root, filename);
    }
}
