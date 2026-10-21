import { ImportConfigLoader } from './config/ImportConfigLoader';
import { ContractEmitter } from './emit/ContractEmitter';
import { VendorSpec } from './spec/VendorSpec';

/**
 * Import file -> the generated contract source. Pure: it reads the import file and the spec it names
 * and RETURNS the text; writing it is the CLI's job, so the suite can assert the exact bytes.
 */
export class OpenApiImporter {
    generate(configPath: string): string {
        const config = new ImportConfigLoader().load(configPath);
        const spec = VendorSpec.load(config.specPath);
        return new ContractEmitter().emit(config, spec);
    }
}
