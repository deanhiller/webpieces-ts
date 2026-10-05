import type { Fixture } from './wiring-fixture';

const WEBSITE_APIS = [
    'LangAdminApi', 'LangAdsAdminApi', 'LangCourseAuthorApi', 'LangCourseSummaryApi', 'LangLanguageAdminApi',
    'LangLeaderboardApi', 'LangLessonApi', 'LangLessonAudioGenerationApi', 'LangListeningApi',
    'LangPlaybackSettingsApi', 'LangReusableTtsAudioApi', 'LangSecureAdminApi', 'LangSecureApi',
    'LangStarterListApi', 'LangWordUploadApi', 'McpDiagnosticApi',
];
const FSDB_APIS = ['LangAdsFsdbApi', 'LangCourseAudioClipFsdbApi', 'LangCourseFsdbApi', 'LangFsdbApi', 'LangLessonFsdbApi', 'McpAuthorizationGrantApi', 'AuthStoreApi'];
const CONTROLLERS = [
    'AdminController', 'AdsAdminController', 'CourseAuthorController', 'ReusableTtsAudioGenerationController',
    'CourseSummaryController', 'LanguageAdminController', 'LeaderboardController', 'LessonController',
    'LessonAudioGenerationController', 'ListeningController', 'McpDiagnosticController', 'PlaybackSettingsController',
    'SecureAdminController', 'SecureController', 'StarterListController', 'WordUploadController',
];

/** The consumer file body, verbatim apart from import specifiers. */
const LANG_WIRING_BODY = `
import {
    LangHeadersDto,
    CompanyHeaders,
    LANG_ADS_FSDB_TYPES,
    LANG_COURSE_AUDIO_CLIP_FSDB_TYPES,
    LANG_COURSE_FSDB_TYPES,
    LANG_FSDB_TYPES,
    LANG_LESSON_FSDB_TYPES,
    LangAdsFsdbApi,
    LangCourseAudioClipFsdbApi,
    LangCourseFsdbApi,
    LangFsdbApi,
    LangLessonFsdbApi,
    MCP_AUTHORIZATION_GRANT_TYPES,
    McpAuthorizationGrantApi,
    AUTH_STORE_TYPES,
    AuthStoreApi,
} from '../../lang-fsdb-api/src/index';
import {
    LangAdminApi,
    LangAdsAdminApi,
    LangCourseAuthorApi,
    LangCourseSummaryApi,
    LangLanguageAdminApi,
    LangLeaderboardApi,
    LangLessonApi,
    LangLessonAudioGenerationApi,
    LangListeningApi,
    LangPlaybackSettingsApi,
    LangReusableTtsAudioApi,
    LangSecureAdminApi,
    LangSecureApi,
    LangStarterListApi,
    LangWordUploadApi,
    McpDiagnosticApi,
} from '../../lang-website-apis/src/index';
import {
    AppSettingsProvider,
    CourseSummaryStoreApi,
    createCourseDbModule,
    createLessonRulesModule,
    GcpPrivateStorageModule,
    GcpStorageModule,
    GcpTtsModule,
    JWT_HOOK,
    LESSON_RULE_LIB_TYPES,
    WARMUP_TYPES,
} from '../../lesson-rules/src/index';
import { ServerAuthWiring } from '../../server-auth/src/wiring';
import { CompanyWiring } from '../../company/src/wiring';
import {
    AdminController,
    AdsAdminController,
    CourseAuthorController,
    ReusableTtsAudioGenerationController,
    CourseSummaryController,
    LanguageAdminController,
    LeaderboardController,
    LessonController,
    LessonAudioGenerationController,
    ListeningController,
    McpDiagnosticController,
    PlaybackSettingsController,
    SecureAdminController,
    SecureController,
    StarterListController,
    WordUploadController,
} from './controllers';
import {
    LangAppSettingsProvider,
    LangCourseStore,
    LangCourseSummaryStore,
    LangMcpTokenAuthority,
    LessonRulesVocabularyModule,
    McpFirstSeenFilter,
    OfflineConfig,
    PreparedLangAppWiring,
    TermsGateFilter,
    WebAppConfig,
} from './support';

export class AppBindings implements BindingModule {
    constructor(
        private readonly webApp: WebAppConfig,
        private readonly offline: OfflineConfig,
    ) {}
    configure(options: ContainerModuleLoadOptions): void {
        options.bind(WebAppConfig).toConstantValue(this.webApp);
        options.bind(OfflineConfig).toConstantValue(this.offline);
        options
            .bind(JWT_HOOK)
            .toDynamicValue((context: ResolutionContext) => context.get(LangMcpTokenAuthority))
            .inSingletonScope();
        options.bind(AppSettingsProvider).to(LangAppSettingsProvider).inSingletonScope();
        new RuntimeTaskClients(options).bindPubSub(
            LangReusableTtsAudioApi,
            LangReusableTtsAudioApi,
            'lang',
        );
        new RuntimeTaskClients(options).bindPubSub(
            LangLessonAudioGenerationApi,
            LangLessonAudioGenerationApi,
            'lang',
        );
    }
}

export class RemoteFsdbBindings implements BindingModule {
    configure(options: ContainerModuleLoadOptions): void {
        options
            .bind<CourseSummaryStoreApi>(LESSON_RULE_LIB_TYPES.CourseSummaryStoreApi)
            .to(LangCourseSummaryStore);
        const clients = new RuntimeClients(options);
        clients.bindRpc(LANG_FSDB_TYPES.LangFsdbApi, LangFsdbApi, 'lang-fsdb');
        clients.bindRpc(
            MCP_AUTHORIZATION_GRANT_TYPES.McpAuthorizationGrantApi,
            McpAuthorizationGrantApi,
            'lang-fsdb',
        );
        clients.bindRpc(LANG_COURSE_FSDB_TYPES.LangCourseFsdbApi, LangCourseFsdbApi, 'lang-fsdb');
        clients.bindRpc(
            LANG_COURSE_AUDIO_CLIP_FSDB_TYPES.LangCourseAudioClipFsdbApi,
            LangCourseAudioClipFsdbApi,
            'lang-fsdb',
        );
        clients.bindRpc(LANG_ADS_FSDB_TYPES.LangAdsFsdbApi, LangAdsFsdbApi, 'lang-fsdb');
        clients.bindRpc(LANG_LESSON_FSDB_TYPES.LangLessonFsdbApi, LangLessonFsdbApi, 'lang-fsdb');
        clients.bindRpc(AUTH_STORE_TYPES.AuthStoreApi, AuthStoreApi, 'lang-fsdb');
        options
            .bind(WARMUP_TYPES.DownstreamWarmup)
            .toDynamicValue((ctx: ResolutionContext) => ctx.get(AUTH_STORE_TYPES.AuthStoreApi))
            .inSingletonScope();
    }
}

export class AdminRoutes implements RouteModule {
    configure(router: WebpiecesRouter): void {
        router.addRoutes(LangAdminApi, AdminController);
    }
}

export class CoreRoutes implements RouteModule {
    configure(router: WebpiecesRouter): void {
        // 1700 puts this filter OUTSIDE the framework's AuthFilter (900,000) — which is exactly why
        // it does its work AFTER \`nextFilter.invoke\` returns: by then AuthFilter has run within it
        // and stamped the caller's user id. It no-ops on every request that did not arrive through
        // McpDispatch, so '*' costs one string comparison on the way out of a browser call.
        router.addFilter(new FilterDefinition(1700, McpFirstSeenFilter, '*'));
        // #1543: an account below TERMS_VERSION is refused every secure jwt call as a 401. INSIDE the
        // AuthFilter (a lower number is an inner filter), so the caller's id is stamped by the time
        // it runs. The two calls the gate page needs are exempt; see TermsGateFilter.EXEMPT.
        router.addFilter(new FilterDefinition(1600, TermsGateFilter, '*'));
        router.addRoutes(LangSecureApi, SecureController);
        router.addRoutes(LangLessonApi, LessonController);
        // #953: the starter list — created by anyone's assistant when a lesson asks for it.
        router.addRoutes(LangStarterListApi, StarterListController);
        router.addRoutes(LangPlaybackSettingsApi, PlaybackSettingsController);
        router.addRoutes(LangLessonAudioGenerationApi, LessonAudioGenerationController);
        router.addRoutes(LangListeningApi, ListeningController);
        router.addRoutes(LangLeaderboardApi, LeaderboardController);
        router.addRoutes(LangSecureAdminApi, SecureAdminController);
        // A THIRD contract, and deliberately on its OWN url prefix rather than joining the two above.
        // \`/api/web/word-upload\` is posted to by a SCRIPT holding a short-lived, single-purpose token
        // that is not an admin credential — see LangWordUploadApi. Sharing the \`/api/web/secure\`
        // prefix would put it one line from the class-level admin gate and invite the next reader to
        // assume they carry the same authority.
        router.addRoutes(LangWordUploadApi, WordUploadController);
        // ADMIN TEST AUDIO, and the SAME two-prefix split for the same reason: the four admin
        // endpoints carry the class-level admin gate, while the one endpoint a MODEL posts to sits on
        // its own prefix behind its own single-purpose role. Registering them side by side here is
        // what makes it obvious they are not the same authority.
        // #877: the render runs as a Cloud Task, never inside the submission request.
        // Source-audio synthesis for the lesson-by-lesson authoring flow runs off-request.
        router.addRoutes(LangReusableTtsAudioApi, ReusableTtsAudioGenerationController);
        // ADMIN -> MANAGE LANGUAGES. Its own contract rather than more methods on the course one:
        // the course belongs to a language, but the catalogue of languages is not the course.
        router.addRoutes(LangLanguageAdminApi, LanguageAdminController);
        // ADMIN -> MOBILE ADS (#840): the two ad numbers and the per-account ad-free flag.
        router.addRoutes(LangAdsAdminApi, AdsAdminController);
        // #1059: BUILDING a course from an assistant, with no GUI. Its own prefix
        // (\`/api/web/secure/course-db\`) because these are the course DB operations the cmdline loop
        // reads. Every method carries its own admin gate.
        router.addRoutes(LangCourseAuthorApi, CourseAuthorController);
        router.addRoutes(LangCourseSummaryApi, CourseSummaryController);
        router.addRoutes(McpDiagnosticApi, McpDiagnosticController);
    }
}

export class ExternalBindingsBindings implements BindingModule {
    configure(_options: ContainerModuleLoadOptions): void {
        new ExternalContractUse('lib-gcp-storage#StorageApi');
        new ExternalContractUse('lib-gcp-tts#TextToSpeechApi');
    }
}

export class LessonRulesBindings implements BindingModule {
    async configure(options: ContainerModuleLoadOptions): Promise<void> {
        await createLessonRulesModule().load(options);
    }
}

export class LessonRulesVocabularyBindings implements BindingModule {
    async configure(options: ContainerModuleLoadOptions): Promise<void> {
        await LessonRulesVocabularyModule.load(options);
    }
}

export class CourseDbBindings implements BindingModule {
    constructor(private readonly input0: Parameters<typeof createCourseDbModule>[0]) {}
    async configure(options: ContainerModuleLoadOptions): Promise<void> {
        await createCourseDbModule(this.input0).load(options);
    }
}

export class GcpStorageBindings implements BindingModule {
    constructor(private readonly input0: ConstructorParameters<typeof GcpStorageModule>[0]) {}
    async configure(options: ContainerModuleLoadOptions): Promise<void> {
        await new GcpStorageModule(this.input0).load(options);
    }
}

export class GcpPrivateStorageBindings implements BindingModule {
    constructor(
        private readonly input0: ConstructorParameters<typeof GcpPrivateStorageModule>[0],
    ) {}
    async configure(options: ContainerModuleLoadOptions): Promise<void> {
        await new GcpPrivateStorageModule(this.input0).load(options);
    }
}

export class GcpTtsBindings implements BindingModule {
    constructor(private readonly input0: ConstructorParameters<typeof GcpTtsModule>[0]) {}
    async configure(options: ContainerModuleLoadOptions): Promise<void> {
        await new GcpTtsModule(this.input0).load(options);
    }
}

export class LangAppWiring extends PreparedLangAppWiring implements AppWiring {
    getBindingModules(): BindingModule[] {
        return [
            new RemoteFsdbBindings(),
            new LessonRulesBindings(),
            new LessonRulesVocabularyBindings(),
            new CourseDbBindings(LangCourseStore),
            new GcpStorageBindings(this.config.storage),
            new GcpPrivateStorageBindings(this.config.privateStorage),
            new GcpTtsBindings(this.config.tts),
            new AppBindings(this.config.webApp, this.config.offline),
            new ExternalBindingsBindings(),
        ];
    }
    getRoutingModules(): RouteModule[] {
        return [new AdminRoutes(), new CoreRoutes()];
    }
    getWirings(): Wiring[] {
        return [
            new ServerAuthWiring(this.config.webApp),
            new CompanyWiring(new WiringPolicy('publicWarmup', true)),
        ];
    }
    getHeaders(): string[] {
        return [...[...LangHeadersDto.ALL_HEADERS], ...CompanyHeaders.ALL];
    }
}
`;

/**
 * The complete lang-server wiring.ts previewed on issue #1146 (265 lines in the consumer), with only
 * its import specifiers pointed at fixture projects. Every client, task client, controller, filter,
 * DI binding and module load stays visible beside the AppWiring class.
 */
export class LangWiring {
    install(fixture: Fixture): string {
        fixture.write('lang-website-apis', 'index.ts', WEBSITE_APIS.map((name: string) => `export class ${name} {}`).join('\n'));
        fixture.write('lang-fsdb-api', 'index.ts', [
            ...FSDB_APIS.map((name: string) => `export class ${name} {}`),
            ...FSDB_APIS.map((name: string) => `export const ${this.token(name)} = { ${name}: Symbol.for('${name}') };`),
            'export class LangHeadersDto { static readonly ALL_HEADERS: string[] = []; }',
            'export class CompanyHeaders { static readonly ALL: string[] = []; }',
        ].join('\n'));
        fixture.write('lesson-rules', 'index.ts', `import { ContainerModule } from '../../node_modules/inversify/index';
            export function createLessonRulesModule(): ContainerModule { return new ContainerModule(() => undefined); }
            export function createCourseDbModule(store: object): ContainerModule { return new ContainerModule(() => undefined); }
            export class GcpStorageModule extends ContainerModule { constructor(config: object) { super(() => undefined); } }
            export class GcpPrivateStorageModule extends ContainerModule { constructor(config: object) { super(() => undefined); } }
            export class GcpTtsModule extends ContainerModule { constructor(config: object) { super(() => undefined); } }
            export const LESSON_RULE_LIB_TYPES = { CourseSummaryStoreApi: Symbol.for('CourseSummaryStoreApi') };
            export interface CourseSummaryStoreApi { summary(): void; }
            export const WARMUP_TYPES = { DownstreamWarmup: Symbol.for('DownstreamWarmup') };
            export const JWT_HOOK = Symbol.for('JwtHook');
            export class AppSettingsProvider {}`);
        fixture.write('server-auth', 'wiring.ts', fixture.source(`
            export class AuthRouteModule implements RouteModule { configure(router: WebpiecesRouter): void { router.addRoutes(AuthApi, AuthApi); } }
            export class ServerAuthWiring implements Wiring {
                constructor(private readonly config: object) {}
                getBindingModules(): BindingModule[] { return []; }
                getRoutingModules(): RouteModule[] { return [new AuthRouteModule()]; }
            }`));
        fixture.write('company', 'wiring.ts', fixture.source(`
            export class CompanyRouteModule implements RouteModule {
                constructor(private readonly publicWarmup: WiringPolicy) {}
                configure(router: WebpiecesRouter): void { if (this.publicWarmup.enabled) router.addRoutes(SaveApi, SaveApi); }
            }
            export class CompanyWiring implements Wiring {
                constructor(private readonly publicWarmup: WiringPolicy) {}
                getBindingModules(): BindingModule[] { return []; }
                getRoutingModules(): RouteModule[] { return [new CompanyRouteModule(this.publicWarmup)]; }
            }`));
        fixture.write('app', 'controllers.ts', CONTROLLERS.map((name: string) => `export class ${name} {}`).join('\n'));
        fixture.write('app', 'support.ts', `import { ContainerModule } from '../../node_modules/inversify/index';
            export class WebAppConfig {} export class OfflineConfig {}
            export class LangMcpTokenAuthority {} export class McpFirstSeenFilter {} export class TermsGateFilter {}
            export class LangAppSettingsProvider {} export class LangCourseSummaryStore {} export class LangCourseStore {}
            export const LessonRulesVocabularyModule = new ContainerModule(() => undefined);
            export class LangConfig { webApp = new WebAppConfig(); offline = new OfflineConfig(); storage = {}; privateStorage = {}; tts = {}; }
            export class PreparedLangAppWiring { constructor(protected readonly config: LangConfig) {} userErrorCodes(): string[] { return []; } }`);
        const source = fixture.source(LANG_WIRING_BODY);
        fixture.write('app', 'wiring.ts', source);
        return source;
    }

    private token(name: string): string {
        return name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase().replace(/_API$/, '_TYPES');
    }
}
