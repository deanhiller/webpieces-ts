import type { Fixture } from './wiring-fixture';

const WEBSITE_APIS = [
    'LangAdminApi', 'LangAdsAdminApi', 'LangCourseAuthorApi', 'LangCourseSummaryApi', 'LangLanguageAdminApi',
    'LangLeaderboardApi', 'LangLessonApi', 'LangLessonAudioGenerationApi', 'LangListeningApi',
    'LangPlaybackSettingsApi', 'LangReusableTtsAudioApi', 'LangSecureAdminApi', 'LangSecureApi',
    'LangStarterListApi', 'LangWordUploadApi', 'McpDiagnosticApi',
];
const PUBSUB_APIS = ['LangReusableTtsAudioApi', 'LangLessonAudioGenerationApi'];
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
    LangAdsFsdbApi,
    LangCourseAudioClipFsdbApi,
    LangCourseFsdbApi,
    LangFsdbApi,
    LangLessonFsdbApi,
    McpAuthorizationGrantApi,
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
    JWT_HOOK,
    LESSON_RULE_LIB_TYPES,
    WARMUP_TYPES,
} from '../../lesson-rules/src/index';
import { LessonRulesBindModule } from '../../lesson-rules/src/wiring';
import { GcpStorageBindModule } from '../../lib-gcp-storage/src/wiring';
import { GcpTtsBindModule } from '../../lib-gcp-tts/src/wiring';
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
    McpFirstSeenFilter,
    OfflineConfig,
    PreparedLangAppWiring,
    TermsGateFilter,
    WebAppConfig,
} from './support';

export class AppBindModule implements BindModule {
    constructor(
        private readonly webApp: WebAppConfig,
        private readonly offline: OfflineConfig,
    ) {}
    configure(binder: Binder): void {
        binder.bind(WebAppConfig).toConstantValue(this.webApp);
        binder.bind(OfflineConfig).toConstantValue(this.offline);
        binder
            .bind(JWT_HOOK)
            .toDynamicValue((context: ResolutionContext) => context.get(LangMcpTokenAuthority))
            .inSingletonScope();
        binder.bind(AppSettingsProvider).to(LangAppSettingsProvider).inSingletonScope();
        binder.createPubSubClientAndBind(LangReusableTtsAudioApi, 'lang');
        binder.createPubSubClientAndBind(LangLessonAudioGenerationApi, 'lang');
    }
}

export class RemoteFsdbBindModule implements BindModule {
    configure(binder: Binder): void {
        binder
            .bind<CourseSummaryStoreApi>(LESSON_RULE_LIB_TYPES.CourseSummaryStoreApi)
            .to(LangCourseSummaryStore);
        binder.createRpcClientAndBind(LangFsdbApi, 'lang-fsdb');
        binder.createRpcClientAndBind(McpAuthorizationGrantApi, 'lang-fsdb');
        binder.createRpcClientAndBind(LangCourseFsdbApi, 'lang-fsdb');
        binder.createRpcClientAndBind(LangCourseAudioClipFsdbApi, 'lang-fsdb');
        binder.createRpcClientAndBind(LangAdsFsdbApi, 'lang-fsdb');
        binder.createRpcClientAndBind(LangLessonFsdbApi, 'lang-fsdb');
        binder.createRpcClientAndBind(AuthStoreApi, 'lang-fsdb');
        binder
            .bind(WARMUP_TYPES.DownstreamWarmup)
            .toDynamicValue((ctx: ResolutionContext) => ctx.get(AuthStoreApi))
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

export class LangAppWiring extends PreparedLangAppWiring implements AppWiring {
    getBindModules(): BindModule[] {
        return [
            new RemoteFsdbBindModule(),
            new LessonRulesBindModule(LangCourseStore),
            new GcpStorageBindModule(this.config.storage, this.config.privateStorage),
            new GcpTtsBindModule(this.config.tts),
            new AppBindModule(this.config.webApp, this.config.offline),
        ];
    }
    getRouteModules(): RouteModule[] {
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
 * The complete lang-server wiring.ts in its #1150 shape (ctoteachings/monorepo#1751), with only its
 * import specifiers pointed at fixture projects. Every client, task client, controller, filter and DI
 * binding stays visible beside the AppWiring class, and each vendor library's BindModule (with its
 * bindExternal edge) is selected in one line from that library's canonical wiring.ts.
 */
export class LangWiring {
    install(fixture: Fixture): string {
        fixture.write('lang-website-apis', 'index.ts', [
            'function PubSub(): (target: object) => void { return () => undefined; }',
            ...WEBSITE_APIS.map((name: string) => `${PUBSUB_APIS.includes(name) ? '@PubSub() ' : ''}export class ${name} {}`),
        ].join('\n'));
        fixture.write('lang-fsdb-api', 'index.ts', [
            ...FSDB_APIS.map((name: string) => `export class ${name} {}`),
            'export class LangHeadersDto { static readonly ALL_HEADERS: string[] = []; }',
            'export class CompanyHeaders { static readonly ALL: string[] = []; }',
        ].join('\n'));
        fixture.write('lesson-rules', 'index.ts', `export const LESSON_RULE_LIB_TYPES = { CourseSummaryStoreApi: Symbol.for('CourseSummaryStoreApi') };
            export interface CourseSummaryStoreApi { summary(): void; }
            export const WARMUP_TYPES = { DownstreamWarmup: Symbol.for('DownstreamWarmup') };
            export const JWT_HOOK = Symbol.for('JwtHook');
            export const LESSON_RULES_TYPES = { CourseStore: Symbol.for('CourseStore') };
            export class AppSettingsProvider {} export class LessonRules {} export class Vocabulary {}`);
        fixture.write('lesson-rules', 'wiring.ts', fixture.source(`import { LESSON_RULES_TYPES, LessonRules, Vocabulary } from './index';
            export class LessonRulesBindModule implements BindModule {
                constructor(private readonly courseStore: object) {}
                configure(binder: Binder): void {
                    binder.bind(LESSON_RULES_TYPES.CourseStore).toConstantValue(this.courseStore);
                    binder.bind(LessonRules).toSelf().inSingletonScope();
                    binder.bind(Vocabulary).toSelf().inSingletonScope();
                }
            }`));
        fixture.write('lib-gcp-storage', 'api.ts', `export abstract class StorageApi { abstract read(): void; }
            export class GcpStorageClient extends StorageApi { read(): void {} }
            export const GCP_STORAGE_TYPES = { Config: Symbol.for('StorageConfig'), PrivateConfig: Symbol.for('PrivateStorageConfig') };`);
        fixture.write('lib-gcp-storage', 'wiring.ts', fixture.source(`import { GCP_STORAGE_TYPES, GcpStorageClient, StorageApi } from './api';
            export class GcpStorageBindModule implements BindModule {
                constructor(private readonly config: object, private readonly privateConfig: object) {}
                configure(binder: Binder): void {
                    binder.bind(GCP_STORAGE_TYPES.Config).toConstantValue(this.config);
                    binder.bind(GCP_STORAGE_TYPES.PrivateConfig).toConstantValue(this.privateConfig);
                    binder.bindExternal(StorageApi, GcpStorageClient);
                }
            }`));
        fixture.write('lib-gcp-tts', 'api.ts', `export abstract class TextToSpeechApi { abstract speak(): void; }
            export class GcpTextToSpeechClient extends TextToSpeechApi { speak(): void {} }
            export const GCP_TTS_TYPES = { TextToSpeechConfigDto: Symbol.for('TextToSpeechConfigDto') };`);
        fixture.write('lib-gcp-tts', 'wiring.ts', fixture.source(`import { GCP_TTS_TYPES, GcpTextToSpeechClient, TextToSpeechApi } from './api';
            export class GcpTtsBindModule implements BindModule {
                constructor(private readonly config: object) {}
                configure(binder: Binder): void {
                    binder.bind(GCP_TTS_TYPES.TextToSpeechConfigDto).toConstantValue(this.config);
                    binder.bindExternal(TextToSpeechApi, GcpTextToSpeechClient);
                }
            }`));
        fixture.write('server-auth', 'wiring.ts', fixture.source(`
            export class AuthRouteModule implements RouteModule { configure(router: WebpiecesRouter): void { router.addRoutes(AuthApi, AuthApi); } }
            export class ServerAuthWiring implements Wiring {
                constructor(private readonly config: object) {}
                getBindModules(): BindModule[] { return []; }
                getRouteModules(): RouteModule[] { return [new AuthRouteModule()]; }
            }`));
        fixture.write('company', 'wiring.ts', fixture.source(`
            export class CompanyRouteModule implements RouteModule {
                constructor(private readonly publicWarmup: WiringPolicy) {}
                configure(router: WebpiecesRouter): void { if (this.publicWarmup.enabled) router.addRoutes(SaveApi, SaveApi); }
            }
            export class CompanyWiring implements Wiring {
                constructor(private readonly publicWarmup: WiringPolicy) {}
                getBindModules(): BindModule[] { return []; }
                getRouteModules(): RouteModule[] { return [new CompanyRouteModule(this.publicWarmup)]; }
            }`));
        fixture.write('app', 'controllers.ts', CONTROLLERS.map((name: string) => `export class ${name} {}`).join('\n'));
        fixture.write('app', 'support.ts', `export class WebAppConfig {} export class OfflineConfig {}
            export class LangMcpTokenAuthority {} export class McpFirstSeenFilter {} export class TermsGateFilter {}
            export class LangAppSettingsProvider {} export class LangCourseSummaryStore {} export class LangCourseStore {}
            export class LangConfig { webApp = new WebAppConfig(); offline = new OfflineConfig(); storage = {}; privateStorage = {}; tts = {}; }
            export class PreparedLangAppWiring { constructor(protected readonly config: LangConfig) {} userErrorCodes(): string[] { return []; } }`);
        const source = fixture.source(LANG_WIRING_BODY);
        fixture.write('app', 'wiring.ts', source);
        return source;
    }

}
