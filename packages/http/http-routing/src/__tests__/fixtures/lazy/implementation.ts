import type { BindModule } from '../../../BindModule';
import type { Binder } from '../../../Binder';
import { injectable, bindingScopeValues } from 'inversify';
import { RequestContext } from '@webpieces/core-context';
import { WebpiecesCoreHeaders } from '@webpieces/core-util';
import {
    AdminRequest,
    AdminResponse,
    DeferredAdminApi,
    SharedCounter,
    OtherDeferredAdminApi,
} from './contracts';

@injectable()
export class AdminState {
    readonly initializedAs = RequestContext.getTrusted(WebpiecesCoreHeaders.USER_ID);
}
@injectable()
export class DeferredAdminController extends DeferredAdminApi {
    constructor(
        private readonly state: AdminState,
        private readonly shared: SharedCounter,
    ) {
        super();
    }
    override async read(request: AdminRequest): Promise<AdminResponse> {
        return new AdminResponse(
            request.value,
            RequestContext.getTrusted(WebpiecesCoreHeaders.USER_ID),
            this.state.initializedAs,
            this.shared.next(),
        );
    }
    override async other(request: AdminRequest): Promise<AdminResponse> {
        return this.read(request);
    }
}

@injectable()
export class UnimplementedController extends DeferredAdminApi {}
class PrivateCandidate {
    readonly value = 'private';
}
export class FailedBindings implements BindModule {
    configure(binder: Binder): void {
        binder.bind(PrivateCandidate).toConstantValue(new PrivateCandidate());
        throw new Error('feature binding failed after a private candidate was installed');
    }
}
export class CollidingBindings implements BindModule {
    configure(binder: Binder): void {
        binder.bind(SharedCounter).toConstantValue(new SharedCounter());
    }
}

@injectable(bindingScopeValues.Singleton)
export class SharedAdminState {
    readonly initializedAs = RequestContext.getTrusted(WebpiecesCoreHeaders.USER_ID);
    private count = 0;
    next(): number {
        return ++this.count;
    }
}
@injectable(bindingScopeValues.Singleton)
export class ApplicationAdminController extends DeferredAdminApi {
    constructor(private readonly state: SharedAdminState) {
        super();
    }
    override async read(request: AdminRequest): Promise<AdminResponse> {
        return new AdminResponse(
            request.value,
            RequestContext.getTrusted(WebpiecesCoreHeaders.USER_ID),
            this.state.initializedAs,
            this.state.next(),
        );
    }
    override async other(request: AdminRequest): Promise<AdminResponse> {
        return this.read(request);
    }
}
@injectable(bindingScopeValues.Singleton)
export class OtherApplicationAdminController extends OtherDeferredAdminApi {
    constructor(private readonly state: SharedAdminState) {
        super();
    }
    override async read(request: AdminRequest): Promise<AdminResponse> {
        return new AdminResponse(
            request.value,
            RequestContext.getTrusted(WebpiecesCoreHeaders.USER_ID),
            this.state.initializedAs,
            this.state.next(),
        );
    }
    override async other(request: AdminRequest): Promise<AdminResponse> {
        return this.read(request);
    }
}
