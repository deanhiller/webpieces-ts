import { ApiSpec, OperationInfo, SecuritySchemeInfo } from '../spec/ApiSpec';
import { ExampleBuilder } from '../spec/ExampleBuilder';

/** One language's sample for one operation. `id` is the tab's value, `label` is what a reader sees. */
export class CodeSample {
    constructor(
        readonly id: string,
        readonly label: string,
        readonly source: string,
    ) {}
}

/** One header a sample sends: the name the document declares, and a placeholder for the value. */
export class SampleHeader {
    constructor(
        readonly name: string,
        readonly value: string,
    ) {}
}

/**
 * Builds the code samples FROM THE SPEC: the server url, the path, the header names the document's
 * own security schemes declare, and an example body generated from the request schema.
 *
 * Nothing here is authored per operation, which is the point. A sample somebody wrote by hand is a
 * copy of the contract that no build can contradict, so the first rename leaves a partner pasting a
 * header the server stopped reading.
 *
 * ## No samples for a webhook
 *
 * A webhook's url belongs to the PARTNER. A curl of ours against one would invite them to call
 * something that does not exist, so the whole card is absent rather than present-and-wrong.
 *
 * ## No vendor logos
 *
 * The languages are labelled in words. The gopher and the Java cup are other companies'
 * trademarks, and a docs generator that ships them hands every consumer that problem too.
 */
export class CodeSampleBuilder {
    constructor(
        private readonly spec: ApiSpec,
        private readonly examples: ExampleBuilder,
    ) {}

    /** Every sample for an operation, in published tab order. Empty for a webhook. */
    samplesFor(operation: OperationInfo): readonly CodeSample[] {
        if (operation.isWebhook) {
            return [];
        }
        const url = `${this.baseUrl()}${operation.path}`;
        const headers = this.headersFor(operation);
        const body = this.examples.render(this.examples.build(operation.requestSchema));
        return [
            new CodeSample('http', 'HTTP', this.http(operation, headers, body)),
            new CodeSample(
                'javascript',
                'JavaScript',
                this.javascript(operation, url, headers, body),
            ),
            new CodeSample('go', 'Go', this.go(operation, url, headers, body)),
            new CodeSample('java', 'Java', this.java(operation, url, headers, body)),
        ];
    }

    /** The header each security scheme this operation requires is sent in. */
    headersFor(operation: OperationInfo): readonly SampleHeader[] {
        const headers: SampleHeader[] = [];
        for (const key of operation.securityKeys) {
            const scheme = this.spec.securitySchemes.find(
                (one: SecuritySchemeInfo): boolean => one.key === key,
            );
            if (scheme !== undefined && scheme.sentIn === 'header' && scheme.headerName !== '') {
                headers.push(new SampleHeader(scheme.headerName, `<your ${scheme.key}>`));
            }
        }
        return headers;
    }

    private baseUrl(): string {
        const first = this.spec.servers[0];
        return first === undefined ? '' : first.url.replace(/\/$/, '');
    }

    private hostName(): string {
        const host = this.baseUrl().replace(/^https?:\/\//, '');
        return host === '' ? 'your-api-host' : host;
    }

    private http(operation: OperationInfo, headers: readonly SampleHeader[], body: string): string {
        const lines = [
            `${operation.httpMethod} ${operation.path} HTTP/1.1`,
            `Host: ${this.hostName()}`,
        ];
        for (const header of headers) {
            lines.push(`${header.name}: ${header.value}`);
        }
        if (body !== '') {
            lines.push('Content-Type: application/json');
            lines.push('');
            lines.push(body);
        }
        return lines.join('\n');
    }

    private javascript(
        operation: OperationInfo,
        url: string,
        headers: readonly SampleHeader[],
        body: string,
    ): string {
        const lines = [
            // webpieces-disable no-fetch -- sample TEXT a partner pastes into their own client; nothing here calls anything
            `const response = await fetch('${url}', {`,
            `    method: '${operation.httpMethod}',`,
            '    headers: {',
        ];
        for (const header of headers) {
            lines.push(`        '${header.name}': '${header.value}',`);
        }
        if (body !== '') {
            lines.push("        'Content-Type': 'application/json',");
        }
        lines.push('    },');
        if (body !== '') {
            lines.push(`    body: JSON.stringify(${this.indent(body, '    ')}),`);
        }
        lines.push('});');
        lines.push('const result = await response.json();');
        return lines.join('\n');
    }

    private go(
        operation: OperationInfo,
        url: string,
        headers: readonly SampleHeader[],
        body: string,
    ): string {
        const lines: string[] = [];
        if (body === '') {
            lines.push(`req, _ := http.NewRequest("${operation.httpMethod}", "${url}", nil)`);
        } else {
            lines.push(`body := []byte(\`${body}\`)`);
            lines.push(
                `req, _ := http.NewRequest("${operation.httpMethod}", "${url}", bytes.NewReader(body))`,
            );
            lines.push('req.Header.Set("Content-Type", "application/json")');
        }
        for (const header of headers) {
            lines.push(`req.Header.Set("${header.name}", "${header.value}")`);
        }
        lines.push('resp, err := http.DefaultClient.Do(req)');
        return lines.join('\n');
    }

    private java(
        operation: OperationInfo,
        url: string,
        headers: readonly SampleHeader[],
        body: string,
    ): string {
        const lines = [
            'HttpRequest request = HttpRequest.newBuilder()',
            `    .uri(URI.create("${url}"))`,
        ];
        for (const header of headers) {
            lines.push(`    .header("${header.name}", "${header.value}")`);
        }
        if (body === '') {
            lines.push(
                `    .method("${operation.httpMethod}", HttpRequest.BodyPublishers.noBody())`,
            );
        } else {
            lines.push('    .header("Content-Type", "application/json")');
            lines.push(
                `    .method("${operation.httpMethod}", HttpRequest.BodyPublishers.ofString("""`,
            );
            lines.push(body);
            lines.push('"""))');
        }
        lines.push('    .build();');
        lines.push(
            'HttpResponse<String> response = client.send(request, BodyHandlers.ofString());',
        );
        return lines.join('\n');
    }

    private indent(body: string, prefix: string): string {
        return body
            .split('\n')
            .map((line: string, index: number): string => (index === 0 ? line : `${prefix}${line}`))
            .join('\n');
    }
}
