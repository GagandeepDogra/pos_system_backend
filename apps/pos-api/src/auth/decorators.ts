// Route metadata and parameters for the AuthGuard (REQ-018).
import { ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import { Role } from '@dhaba/shared';
import type { Request } from 'express';

export const PUBLIC_KEY = 'auth:public';
export const ROLES_KEY = 'auth:roles';

/** The caller of an authenticated request, set on `req.user` by the AuthGuard. */
export interface SessionUser {
  id: string;
  role: Role;
  display_name: string;
  /** Kitchen device session (exempt from shift end). */
  kitchen_device: boolean;
  /** X-Device-Id header, if the client sends one (goes to audit_log.device_id). */
  device_id: string | null;
}

export type AuthedRequest = Request & { user?: SessionUser };

/** No Bearer token needed (health, login tiles, login). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/**
 * Roles allowed to call the route (method or class level; method wins).
 * Without @Roles any signed-in role may call it, except under /api/v1/admin
 * where the default is ADMIN only.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** `@CurrentUser() user: SessionUser` */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthedRequest>().user);

/** `@ApprovalToken() token: string | null` — the optional X-Approval-Token header (REQ-023). */
export const ApprovalToken = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const raw = ctx.switchToHttp().getRequest<Request>().headers['x-approval-token'];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value || null;
});
