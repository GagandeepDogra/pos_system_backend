// Global guard (REQ-018, REQ-111, REQ-120): every route needs a valid Bearer
// JWT unless it is @Public(); then the @Roles matrix applies. A role denial
// answers 403 and writes an ACCESS_DENIED Audit Log row.
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@dhaba/shared';
import { API_PREFIX } from '../app.setup';
import { writeAudit } from '../audit/audit';
import { ApiError } from '../common/errors';
import { HealthController } from '../health/health.controller';
import { StorageService } from '../storage/storage.service';
import { AuthService } from './auth.service';
import { AuthedRequest, PUBLIC_KEY, ROLES_KEY, SessionUser } from './decorators';

const ADMIN_PATH = new RegExp(`^/${API_PREFIX}/admin(/|$)`);

export class AccessDeniedError extends ApiError {
  constructor(role: Role) {
    super(403, 'ACCESS_DENIED', 'You are not allowed to do this.', 'आपको यह करने की अनुमति नहीं है।', { role });
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly auth: AuthService, private readonly storage: StorageService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (context.getClass() === HealthController || this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    const bearer = header && /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    const rawDevice = req.headers['x-device-id'];
    const user = this.auth.authenticate(bearer || null, (Array.isArray(rawDevice) ? rawDevice[0] : rawDevice) || null);
    req.user = user;
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets) ?? (ADMIN_PATH.test(req.path) ? ['ADMIN'] : undefined);
    if (roles && !roles.includes(user.role)) {
      await this.auditDenial(user, req);
      throw new AccessDeniedError(user.role);
    }
    return true;
  }

  private async auditDenial(user: SessionUser, req: AuthedRequest): Promise<void> {
    const route = req.path.replace(new RegExp(`^/${API_PREFIX}`), '');
    const params = (req.params ?? {}) as Record<string, string>;
    try {
      await this.storage.queue.run((tx) =>
        writeAudit(tx, {
          action: 'ACCESS_DENIED',
          entity_type: route.split('/')[1] || 'route',
          entity_id: params.id ?? (route.split('/').slice(1).join('/') || '/'),
          user_id: user.id,
          device_id: user.device_id,
          before_json: { method: req.method, path: route, role: user.role },
          after_json: null,
        }),
      );
    } catch {
      // The 403 stands even if the audit row cannot be written (writes blocked, journal failure).
    }
  }
}
