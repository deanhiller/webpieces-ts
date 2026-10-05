import { RuleHelp } from '@webpieces/rules-sdk';

/** Owner-authored guidance consumed by the registry catalog. */
export const ruleHelp: Readonly<Record<string, RuleHelp>> = {
    'wiring-format': new RuleHelp('Check every canonical wiring.ts: its Wiring/AppWiring class plus the BindingModule/RouteModule classes it selects, with their actual registrations.', 'Declare each owner\'s Wiring/AppWiring class beside its named BindingModule/RouteModule classes and their registrations (bindRpc, provideRpcClient, bindPubSub, addRoutes, addFilter, DI binds, provider recipes) in its src/wiring.ts; select them with literal return arrays and select library Wirings only from AppWiring. Keep constructors as prepared-input storage, keep configuration building, environment discovery and initializer/factory bodies in imported implementations, use direct service strings and explicit WiringPolicy declarations. Set maxLines explicitly (agreed upstream limit: 400).'),
    'no-file-import-cycles': new RuleHelp(
        'Keep each project free of circular file imports.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'runtime-architecture': new RuleHelp(
        'Validate runtime service and API dependency declarations.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'nx-wiring': new RuleHelp(
        'Wire the required validation targets into the Nx execution graph.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'di-graph': new RuleHelp(
        'Generate and validate dependency-injection design graphs.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'missing-design-annotation': new RuleHelp(
        'Declare the application design roots required for DI analysis.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'validate-architecture-unchanged': new RuleHelp(
        'Keep the committed architecture graph aligned with current dependencies.',
        'In src/wiring.ts use new RuntimeClients(options).bindRpc(token, Api, deployment, filters?) from @webpieces/http-client-node, new RuntimeTaskClients(options).bindPubSub(token, Api, deployment) from @webpieces/cloudtasks-client, and provideRpcClient(token, Api, deployment) from @webpieces/http-client-browser. wiring-format checks canonical wiring.ts in all participating owners; preserve tokens and filters. Review graph changes and runtime-deps.json candidates explicitly.',
    ),
    'validate-no-architecture-cycles': new RuleHelp(
        'Keep the project dependency architecture free of cycles.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'validate-packagejson': new RuleHelp(
        'Align package dependencies with declared project dependencies.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'validate-versions-locked': new RuleHelp(
        'Pin dependency versions consistently across governed projects.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'validate-eslint-sync': new RuleHelp(
        'Keep managed ESLint configuration synchronized with its installed templates.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'no-root-union-api-type': new RuleHelp(
        'Use a stable named root API contract rather than a root union type.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'api-rules-for-openapi': new RuleHelp(
        'Validate API contracts against their configured OpenAPI requirements.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'api-rules-for-mcp': new RuleHelp(
        'Validate API contracts against their configured MCP requirements.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'api-lib-dependencies': new RuleHelp(
        'Validate the configured API library dependency relationships.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'api-lib-path': new RuleHelp(
        'Use the configured paths for API contract libraries.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'framework-folder': new RuleHelp(
        'Align framework declarations with their project folder layout.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
};
