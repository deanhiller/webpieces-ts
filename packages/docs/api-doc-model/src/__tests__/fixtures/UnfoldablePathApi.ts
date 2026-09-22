/* eslint-disable */
/**
 * A path only known at RUNTIME. The extractor must FAIL here rather than print `runtimePath()` or
 * guess: a partner-grade document that is quietly wrong about a URL is the one defect nobody catches
 * by reading it.
 *
 * Its own file, because a hard failure takes the whole model down — which is the behaviour being
 * asserted, and the reason it cannot share a file with anything else.
 */
import { ApiPath, Endpoint } from './contract-stubs';

export function runtimePath(): string {
    return process.env['SOME_PATH'] ?? '/whatever';
}

export interface Empty {
    ok: boolean;
}

@ApiPath('/api/unfoldable')
export class UnfoldablePathApi {
    @Endpoint(runtimePath(), 'rpc')
    go(request: Empty): Promise<void> {
        throw new Error('contract');
    }
}
