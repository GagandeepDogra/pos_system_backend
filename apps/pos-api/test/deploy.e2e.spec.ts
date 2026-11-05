import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { AddressInfo } from 'net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { loadConfig } from '../src/config';
import { restrictDataFolder } from '../src/deploy/data-folder';
import { RateLimiter, applyProfile, createHttpsRedirectServer } from '../src/deploy/hardening';
import { OffsiteCopyScheduler, msUntilIst } from '../src/deploy/offsite-copy';
import { DeployConfigError, DeployProfile, isLocalNetworkAddress, loadDeployProfile, pickLanAddress } from '../src/deploy/profile';
import { reviewDeployment } from '../src/deploy/review';
import { StorageService } from '../src/storage/storage.service';
import { FakeClock } from './support/fake-clock';
import { tempDir } from './fixtures';

const exists = () => true;
const cloudEnv = {
  DEPLOY_PROFILE: 'cloud',
  TLS_CERT_FILE: '/etc/letsencrypt/live/pos/fullchain.pem',
  TLS_KEY_FILE: '/etc/letsencrypt/live/pos/privkey.pem',
  CORS_ORIGIN: 'https://pos.example.in',
  OFFSITE_BACKUP_DIR: '/mnt/offsite',
};
const lanIfaces = {
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  eth0: [{ address: '203.0.113.9', family: 'IPv4', internal: false }],
  wlan0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
} as unknown as NodeJS.Dict<os.NetworkInterfaceInfo[]>;

describe('deployment profiles (REQ-014, REQ-015, REQ-121, REQ-122)', () => {
  it('REQ-121: the LAN profile binds to this PC\'s private LAN address by default, never to all interfaces', () => {
    expect(pickLanAddress(lanIfaces)).toBe('192.168.1.20');
    const p = loadDeployProfile({}, { interfaces: lanIfaces });
    expect(p).toMatchObject({ name: 'lan', host: '192.168.1.20', tls: null, corsOrigin: null, loginRateLimitPerMinute: null });
    expect(() => loadDeployProfile({ HOST: '0.0.0.0' })).toThrow(DeployConfigError);
    expect(() => loadDeployProfile({ HOST: '203.0.113.9' })).toThrow(/private LAN/);
    expect(loadDeployProfile({ HOST: '10.0.0.5' }).host).toBe('10.0.0.5');
  });

  it('REQ-121: classifies private, loopback and public addresses', () => {
    for (const a of ['10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.0.10', '127.0.0.1', 'localhost', '::1', 'fd12:3456::1', 'fe80::1'])
      expect(isLocalNetworkAddress(a)).toBe(true);
    for (const a of ['0.0.0.0', '8.8.8.8', '172.32.0.1', '192.169.0.1', '::', '2001:db8::1', '300.1.1.1'])
      expect(isLocalNetworkAddress(a)).toBe(false);
  });

  it('REQ-014: the LAN profile accepts an mkcert certificate for https://pos.local', () => {
    const p = loadDeployProfile({ HOST: '192.168.1.20', TLS_CERT_FILE: 'c.pem', TLS_KEY_FILE: 'k.pem', HTTP_REDIRECT_PORT: '80' }, { fileExists: exists });
    expect(p.tls).toEqual({ certFile: 'c.pem', keyFile: 'k.pem' });
    expect(p.httpRedirectPort).toBe(80);
    expect(() => loadDeployProfile({ HOST: '192.168.1.20', TLS_CERT_FILE: 'c.pem' })).toThrow(/together/);
  });

  it('REQ-122: the cloud profile requires HTTPS, an https CORS origin and an off-server copy', () => {
    const p = loadDeployProfile(cloudEnv, { fileExists: exists });
    expect(p).toMatchObject({ name: 'cloud', corsOrigin: 'https://pos.example.in', loginRateLimitPerMinute: 10, offsiteBackupTime: '02:30' });
    expect(() => loadDeployProfile({ ...cloudEnv, TLS_CERT_FILE: '', TLS_KEY_FILE: '' }, { fileExists: exists })).toThrow(/HTTPS only/);
    expect(() => loadDeployProfile({ ...cloudEnv, CORS_ORIGIN: '*' }, { fileExists: exists })).toThrow(/CORS_ORIGIN/);
    expect(() => loadDeployProfile({ ...cloudEnv, CORS_ORIGIN: 'http://pos.example.in' }, { fileExists: exists })).toThrow(/CORS_ORIGIN/);
    expect(() => loadDeployProfile({ DEPLOY_PROFILE: 'mars' })).toThrow(/lan or cloud/);
    expect(() => loadConfig({ ...cloudEnv, TLS_CERT_FILE: '/nope.pem' })).toThrow(/not found/);
  });

  it('REQ-015: a cloud deployment without a nightly off-server backup copy fails review', () => {
    const offsite = tempDir();
    const dataDir = tempDir();
    fs.chmodSync(dataDir, 0o700);
    const base = { ...cloudEnv, DATA_DIR: dataDir, OFFSITE_BACKUP_DIR: offsite };
    expect(reviewDeployment(base, { fileExists: exists, platform: 'linux' }).ok).toBe(true);
    const missing = reviewDeployment({ ...base, OFFSITE_BACKUP_DIR: '' }, { fileExists: exists, platform: 'linux' });
    expect(missing.ok).toBe(false);
    expect(missing.failures.join()).toMatch(/off-server backup/);
    const unmounted = reviewDeployment({ ...base, OFFSITE_BACKUP_DIR: path.join(offsite, 'gone') }, { fileExists: exists, platform: 'linux' });
    expect(unmounted.failures.join()).toMatch(/mounted/);
  });

  it('REQ-123: the data folder is readable only by the service account', () => {
    const dir = tempDir();
    fs.chmodSync(dir, 0o755);
    expect(reviewDeployment({ DATA_DIR: dir, HOST: '127.0.0.1' }, { platform: 'linux' }).failures.join()).toMatch(/readable by other/);
    expect(restrictDataFolder(dir, 'linux')).toMatchObject({ tightened: true, mode: '700' });
    expect(restrictDataFolder(dir, 'linux').tightened).toBe(false);
    expect(reviewDeployment({ DATA_DIR: dir, HOST: '127.0.0.1' }, { platform: 'linux' }).ok).toBe(true);
    expect(restrictDataFolder(dir, 'win32').mode).toBeNull();
  });
});

describe('cloud profile HTTP hardening (REQ-111, REQ-122)', () => {
  let app: INestApplication;
  let storage: StorageService;
  let t = 0;
  const profile: DeployProfile = { ...loadDeployProfile(cloudEnv, { fileExists: exists }), tls: null };

  beforeAll(async () => {
    storage = new StorageService({ dataDir: tempDir(), sheetPassword: 'x' });
    await storage.open();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(storage)] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    applyProfile(app, profile, { now: () => t });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    storage.close();
  });

  it('REQ-122: the 11th login attempt in a minute from one IP gets 429', async () => {
    const server = app.getHttpServer();
    for (let i = 0; i < 10; i++) {
      const res = await request(server).post('/api/v1/auth/login').send({});
      expect(res.status).not.toBe(429);
    }
    const res = await request(server).post('/api/v1/auth/login').send({}).expect(429);
    expect(res.body).toMatchObject({ code: 'TOO_MANY_ATTEMPTS', details: { limit_per_minute: 10 } });
    expect(res.headers['retry-after']).toBe('60');
    await request(server).get('/api/v1/health').expect(200);
    t += 60_001;
    expect((await request(server).post('/api/v1/auth/login').send({})).status).not.toBe(429);
  });

  it('REQ-122: the rate limiter counts per IP in a sliding minute', () => {
    let now = 0;
    const limiter = new RateLimiter(2, () => now);
    expect([limiter.hit('a'), limiter.hit('a'), limiter.hit('b')]).toEqual([0, 0, 0]);
    expect(limiter.hit('a')).toBe(60);
    now = 30_000;
    expect(limiter.hit('a')).toBe(30);
    now = 60_001;
    expect(limiter.hit('a')).toBe(0);
  });

  it('REQ-122: CORS answers only the app origin; another origin gets no CORS headers', async () => {
    const server = app.getHttpServer();
    const ok = await request(server).get('/api/v1/health').set('Origin', 'https://pos.example.in').expect(200);
    expect(ok.headers['access-control-allow-origin']).toBe('https://pos.example.in');
    const evil = await request(server).get('/api/v1/health').set('Origin', 'https://evil.example.com');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await request(server)
      .options('/api/v1/auth/login')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('REQ-111: the plain HTTP listener only redirects to HTTPS, never serves content', async () => {
    const redirect = createHttpsRedirectServer(443);
    const res = await request(redirect).get('/api/v1/health?x=1').set('Host', 'pos.example.in:80').expect(301);
    expect(res.headers.location).toBe('https://pos.example.in/api/v1/health?x=1');
    expect(res.text).toBe('');
    const other = await request(createHttpsRedirectServer(8443, 'pos.example.in')).post('/api/v1/auth/login').expect(301);
    expect(other.headers.location).toBe('https://pos.example.in:8443/api/v1/auth/login');
  });

  it('REQ-121: the LAN profile adds no CORS headers and no login limit', async () => {
    const lan = await Test.createTestingModule({ imports: [AppModule.register(storage)] }).compile();
    const lanApp = lan.createNestApplication();
    configureApp(lanApp);
    applyProfile(lanApp, loadDeployProfile({ HOST: '192.168.1.20' }));
    await lanApp.init();
    const res = await request(lanApp.getHttpServer()).get('/api/v1/health').set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    for (let i = 0; i < 11; i++) expect((await request(lanApp.getHttpServer()).post('/api/v1/auth/login')).status).not.toBe(429);
    await lanApp.close();
  });
});

describe('HTTPS serving (REQ-111)', () => {
  const opensslAvailable = (() => {
    try {
      execFileSync('openssl', ['version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  (opensslAvailable ? it : it.skip)('REQ-111: serves /api/v1/health over HTTPS with HSTS when TLS files are set', async () => {
    const dir = tempDir();
    const cert = path.join(dir, 'cert.pem');
    const key = path.join(dir, 'key.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=pos.local'], {
      stdio: 'ignore',
    });
    const storage = new StorageService({ dataDir: tempDir(), sheetPassword: 'x' });
    await storage.open();
    const profile = loadDeployProfile({ ...cloudEnv, TLS_CERT_FILE: cert, TLS_KEY_FILE: key });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(storage)] }).compile();
    const app = moduleRef.createNestApplication({ httpsOptions: { cert: fs.readFileSync(cert), key: fs.readFileSync(key) } });
    configureApp(app);
    applyProfile(app, profile);
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const res = await new Promise<{ status: number; hsts: unknown; body: string }>((resolve, reject) => {
      https
        .get({ host: '127.0.0.1', port, path: '/api/v1/health', rejectUnauthorized: false }, (r) => {
          let body = '';
          r.on('data', (c) => (body += c));
          r.on('end', () => resolve({ status: r.statusCode!, hsts: r.headers['strict-transport-security'], body }));
        })
        .on('error', reject);
    });
    expect(res.status).toBe(200);
    expect(res.hsts).toBe('max-age=31536000');
    expect(JSON.parse(res.body).status).toBe('green');
    await app.close();
    storage.close();
  });
});

describe('nightly off-server backup copy (REQ-015)', () => {
  it('computes the wait until the next IST time', () => {
    // 2026-11-05 02:00 IST = 2026-11-04T20:30Z
    expect(msUntilIst('02:30', new Date('2026-11-04T20:30:00Z'))).toBe(30 * 60_000);
    expect(msUntilIst('02:30', new Date('2026-11-04T21:00:00Z'))).toBe(24 * 60 * 60_000);
    expect(msUntilIst('02:30', new Date('2026-11-04T21:00:30Z'))).toBe(24 * 60 * 60_000 - 30_000);
  });

  it('REQ-015: copies a fresh verified snapshot off-server every night', async () => {
    const storage = new StorageService({ dataDir: tempDir(), sheetPassword: 'x' });
    await storage.open();
    const offsite = tempDir();
    const clock = new FakeClock('2026-11-04T20:00:00Z'); // 01:30 IST
    const sched = new OffsiteCopyScheduler(storage.backups, { dir: offsite, time: '02:30', clock });
    sched.start();
    await clock.advance(59 * 60_000, () => sched.whenIdle());
    expect(fs.readdirSync(offsite)).toEqual([]);
    await clock.advance(60_000, () => sched.whenIdle());
    expect(fs.readdirSync(offsite)).toEqual(['snapshot-20261105-023000-auto.xlsx']);
    await clock.advance(24 * 60 * 60_000, () => sched.whenIdle());
    expect(fs.readdirSync(offsite).sort()).toEqual(['snapshot-20261105-023000-auto.xlsx', 'snapshot-20261106-023000-auto.xlsx']);
    expect(sched.lastError).toBeNull();
    sched.stop();
    storage.close();
  });

  it('REQ-015: an unmounted off-server folder is reported, not silently skipped', async () => {
    const storage = new StorageService({ dataDir: tempDir(), sheetPassword: 'x' });
    await storage.open();
    const errors: string[] = [];
    const sched = new OffsiteCopyScheduler(storage.backups, { dir: path.join(tempDir(), 'missing'), time: '02:30', onError: (e) => errors.push(e.message) });
    await expect(sched.copyNow()).rejects.toThrow(/not mounted/);
    expect(errors).toHaveLength(1);
    expect(sched.lastError).toMatch(/not mounted/);
    storage.close();
  });
});
