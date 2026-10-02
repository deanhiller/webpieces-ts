import { injectable, bindingScopeValues } from 'inversify';

@injectable(bindingScopeValues.Singleton)
export class HookStdinSource {
    read(): Promise<string> {
        return new Promise((resolve: (value: string) => void) => {
            let data = '';
            process.stdin.setEncoding('utf8');
            process.stdin.on('data', (chunk: string) => { data += chunk; });
            process.stdin.on('end', () => { resolve(data); });
            process.stdin.on('error', () => { resolve(''); });
            if (process.stdin.isTTY) resolve('');
        });
    }
}

@injectable(bindingScopeValues.Singleton)
export class HookStdoutSink {
    write(bytes: string): void { process.stdout.write(bytes); }
}

@injectable(bindingScopeValues.Singleton)
export class HookProcessExit {
    exit(code: number): void {
        // webpieces-disable no-process-exit-outside-main -- this port is the hook protocol's terminal boundary.
        process.exit(code);
    }
}
