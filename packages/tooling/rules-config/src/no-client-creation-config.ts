import { FieldDef, SchemaShape } from './field-def';
import { BaseRuleConfig, BASE_RULE_SCHEMA, ModifiedCodeMode, MODIFIED_CODE_MODES } from './rule-configs';

// no-client-creation-outside-server-or-client severity. Landed as a hard failure this rule would
// break every existing Angular repo on upgrade (provideCoreClient-style helpers create the client
// inside a role:lib on purpose), so it ships WARN — reports + prints the migration but passes the
// build — and a repo flips it to `error` once it has migrated its libraries.
export const CLIENT_CREATION_SEVERITIES = ['warn', 'error'] as const;
export type ClientCreationSeverity = typeof CLIENT_CREATION_SEVERITIES[number];

// no-client-creation-outside-server-or-client — flags a project that CONSTRUCTS an rpc/pubsub client
// (`factory.createRpcClient(...)` / `factory.createPubSubClient(...)`) when the project's `role:` tag
// is not one of `allowedRoles`. Only a runnable entrypoint (server / client app / app) has a declared
// identity (`serviceName`) or target (`callsService`), so a client built there is attributable in the
// runtime graph; a client built inside a `role:lib` reaches the fan-out fallback (one `uses` edge to
// EVERY implementer of the api) and draws calls that cannot happen. A reusable library takes the api
// INJECTED — the server/app module binds it to a client. Importing the api type or its DI token is
// FINE and never flagged; only constructing the transport is.
//
// `severity` ships "warn" (report + migration, build passes) so an upgrade can't break an un-migrated
// Angular repo; flip to "error" once libraries are migrated. `allowedRoles` defaults to the runnable
// roles; `allowedPaths` exempts whole file trees (shared glob semantics). Standard rollout knobs via
// the base: mode (OFF | NEW_AND_MODIFIED_CODE | NEW_AND_MODIFIED_FILES), ignoreModifiedUntilEpoch,
// branch, and disableAllowed for the inline `// webpieces-disable` escape.
export class NoClientCreationOutsideServerOrClientConfig extends BaseRuleConfig {
    declare mode?: ModifiedCodeMode;
    severity?: ClientCreationSeverity;
    disableAllowed?: boolean;
    allowedRoles?: string[];
    allowedPaths?: string[];

    static readonly SCHEMA: SchemaShape<NoClientCreationOutsideServerOrClientConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        severity: FieldDef.optional('string', CLIENT_CREATION_SEVERITIES),
        disableAllowed: FieldDef.optional('boolean'),
        allowedRoles: FieldDef.optional('string[]'),
        allowedPaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}
