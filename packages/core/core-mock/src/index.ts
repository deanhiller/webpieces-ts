/**
 * @webpieces/core-mock
 *
 * Typed mock framework for feature tests - the TypeScript port of Java
 * webpieces core-mock (MockSuperclass).
 *
 * - createMock<T>(name): Proxy-based mock implementing T + typed .mock controls
 * - MockHandler: the queue/default/drain engine, for hand-written mock classes
 */
export { createMock, MockedApi, TypedMockControls } from './createMock';
export { MockHandler, ValueToReturn, ParametersPassedIn } from './MockHandler';
