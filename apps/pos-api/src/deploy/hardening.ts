// Per-profile HTTP hardening (REQ-111, REQ-122): CORS restricted to the app
// origin, the login rate limit, HSTS on HTTPS, and the plain-HTTP listener that
// only redirects to HTTPS.
import http from 'http';
import { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { DeployProfile } from './profile';

export const LOGIN_PATH = '/api/v1/auth/login';
const WINDOW_MS = 60_000;

/** Sliding one-minute window of attempts per key (client IP). */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    private readonly now: () => number = Date.now,
    private readonly windowMs = WINDOW_MS,
  ) {}

  /** Records an attempt; returns 0 if allowed, else the seconds until one is allowed again. */
  hit(key: string): number {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return Math.max(1, Math.ceil((recent[0] + this.windowMs - t) / 1000));
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.sweep(t);
    return 0;
  }

  private sweep(t: number): void {
    for (const [k, list] of this.hits) if (!list.some((x) => x > t - this.windowMs)) this.hits.delete(k);
  }
}

export function loginRateLimitMiddleware(limiter: RateLimiter) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'POST' || req.path !== LOGIN_PATH) return next();
    const retryAfter = limiter.hit(req.ip ?? req.socket.remoteAddress ?? 'unknown');
    if (!retryAfter) return next();
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({
      code: 'TOO_MANY_ATTEMPTS',
      message_en: 'Too many login attempts. Wait a minute and try again.',
      message_hi: 'बहुत ज़्यादा लॉगिन कोशिशें। एक मिनट रुककर फिर कोशिश करें।',
      details: { retry_after_seconds: retryAfter, limit_per_minute: limiter.limit },
    });
  };
}

export interface HardeningOptions {
  now?: () => number;
}

/** Applies the profile's CORS, login rate limit and HSTS. Call after configureApp, before listen/init. */
export function applyProfile(app: INestApplication, profile: DeployProfile, options: HardeningOptions = {}): void {
  if (profile.corsOrigin) {
    const allowed = profile.corsOrigin;
    // Only the app origin is ever echoed back; any other origin gets no CORS headers, so the browser blocks it.
    app.enableCors({
      origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => cb(null, origin === allowed),
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'If-Match', 'X-Approval-Token'],
      maxAge: 600,
    });
  }
  if (profile.loginRateLimitPerMinute) {
    app.use(loginRateLimitMiddleware(new RateLimiter(profile.loginRateLimitPerMinute, options.now)));
  }
  if (profile.tls) {
    app.use((_req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000');
      next();
    });
  }
}

/**
 * A plain-HTTP server that never serves content: every request is answered
 * with a 301 to the same path on HTTPS.
 */
export function createHttpsRedirectServer(httpsPort: number, publicHost?: string): http.Server {
  return http.createServer((req, res) => {
    const host = publicHost ?? (req.headers.host ?? 'localhost').replace(/:\d+$/, '');
    const port = httpsPort === 443 ? '' : `:${httpsPort}`;
    res.writeHead(301, { Location: `https://${host}${port}${req.url ?? '/'}`, 'Content-Length': '0', Connection: 'close' });
    res.end();
  });
}
