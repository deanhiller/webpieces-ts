/* eslint-disable */
import { ContextKey } from '@webpieces/core-util';
/**
 * FIXTURE SUPPORT. Excluded from `tsconfig.lib.json`, so it ships in no build.
 *
 * It used to declare STUB decorators, because the extractor matched decorator names as string
 * literals and deliberately linked against nothing. Those stubs are gone: the extractor now imports
 * `@webpieces/core-util`, and the fixtures do too, so a contract in this directory is typechecked
 * against the REAL decorator signatures.
 *
 * That change is the point. The stubs had drifted — one of them declared
 * `@WpMcpTool({name, readOnly, idempotent})`, a shape the real decorator has never accepted — and
 * nothing could notice, because nothing typechecked them against anything. A fixture that cannot be
 * wrong about the thing it is a fixture FOR is not testing that thing.
 *
 * What remains here is the one thing a fixture genuinely needs of its own: a path held in a constant,
 * so the suite exercises constant FOLDING across an import.
 */
export const SAVE_PATH = '/save';

/**
 * A typed context-key REGISTRY, the shape real consumers keep (#1249): every header is defined ONCE
 * as a ContextKey and every surface names the key. The extractor follows `PartnerKeys.API_KEY`,
 * across this import, into the factory call and reads its `httpHeader` — here itself a folded
 * constant.
 */
const API_KEY_HEADER = 'x-api-key';

export class PartnerKeys {
    static readonly API_KEY = ContextKey.untrusted<string>('apiKey', API_KEY_HEADER, true);
    static readonly ORG_ID = ContextKey.trusted<string>(
        'organizationId',
        'the api-key hook proves the key acts for this organization',
        'x-organization-id',
    );
    /** Context-only: no httpHeader, so it can never name a header credential. */
    static readonly IN_PROCESS = ContextKey.untrusted<string>('inProcess');
}

/** The same keys reached through an object-literal registry instead of a class. */
export const PartnerKeyTable = {
    ORG_ID: PartnerKeys.ORG_ID,
} as const;
