export { SpecTempDirs, specTempDirs } from './spec-temp-dirs';

export { policyFixture, fixtureSchemas, fixtureTuning, fixtureMigrations, fixtureHookGuardNames } from './policy-fixture';

// Mocked process edges for feature tests (#1381): script what git and every other program answer.
export { ProcessCallDto, ScriptedProcessTable } from './process/scripted-process-table';
export type { ScriptedAnswer } from './process/scripted-process-table';
export { MockGitProcessApi } from './process/mock-git-process-api';
export { MockNativeProcessApi, ScriptedShellRun, SHELL } from './process/mock-native-process-api';
