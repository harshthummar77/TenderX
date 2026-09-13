import jwt from 'jsonwebtoken';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { redactPaths } from '../src/lib/logger.js';
import { prisma } from '../src/lib/prisma.js';
import { disconnect, truncateAll } from './helpers/db.js';

const PASSWORD = 'Sup3rSecretPass';

const orgPayload = (email = 'admin@meridian.test') => ({
  organization: {
    name: 'Meridian Industries Pvt Ltd',
    email: 'procurement@meridian.test',
    addressLine1: '12 Ring Road',
    city: 'Ahmedabad',
    state: 'Gujarat',
    stateCode: '24',
    pincode: '380009',
  },
  admin: { fullName: 'Priya Nair', email, password: PASSWORD, phone: '9876543210' },
});

const vendorPayload = (email = 'sales@apex.test') => ({
  vendor: {
    companyName: 'Apex Components',
    email: 'contact@apex.test',
    phone: '9876500000',
    addressLine1: '9 Industrial Estate',
    city: 'Surat',
    state: 'Gujarat',
    stateCode: '24',
    pincode: '395001',
  },
  admin: { fullName: 'Ravi Shah', email, password: PASSWORD },
});

/** supertest gives set-cookie as an array; pull out the refresh cookie. */
const refreshCookie = (res: request.Response): string => {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = raw?.find((c) => c.startsWith('tb_rt='));
  if (!cookie) throw new Error('no refresh cookie on response');
  return cookie;
};

const cookieValue = (cookie: string) => cookie.split(';')[0]?.split('=')[1] ?? '';

async function registerOrg(email?: string) {
  const res = await request(app).post('/api/v1/auth/register/organization').send(orgPayload(email));
  expect(res.status).toBe(201);
  return { accessToken: res.body.data.accessToken as string, cookie: refreshCookie(res), body: res.body };
}

beforeAll(async () => {
  await truncateAll();
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await disconnect();
});

describe('registration', () => {
  it('creates the organization, the first ORG_ADMIN and an audit row', async () => {
    const res = await request(app).post('/api/v1/auth/register/organization').send(orgPayload());

    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('ORG_ADMIN');
    expect(res.body.data.user.organization.name).toBe('Meridian Industries Pvt Ltd');
    // The party starts under review; the user can still sign in (03 §3).
    expect(res.body.data.user.organization.status).toBe('PENDING_APPROVAL');
    expect(res.body.data.user.vendor).toBeNull();
    expect(res.body.data.accessToken).toBeTruthy();

    const audit = await prisma.activityLog.findFirst({ where: { action: 'user.registered' } });
    expect(audit?.hash).toBeTruthy();
  });

  it('creates a vendor with the VENDOR role', async () => {
    const res = await request(app).post('/api/v1/auth/register/vendor').send(vendorPayload());

    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('VENDOR');
    expect(res.body.data.user.vendor.companyName ?? res.body.data.user.vendor.name).toBe('Apex Components');
    expect(res.body.data.user.organization).toBeNull();
  });

  it('rejects a duplicate email', async () => {
    await registerOrg();
    const res = await request(app).post('/api/v1/auth/register/organization').send(orgPayload());

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('auth.email_taken');
  });

  it('rejects a password that breaks the policy', async () => {
    const payload = orgPayload();
    payload.admin.password = 'short1';
    const res = await request(app).post('/api/v1/auth/register/organization').send(payload);

    expect(res.status).toBe(422);
    expect(res.body.error.fields.some((f: { path: string }) => f.path === 'admin.password')).toBe(true);
  });

  it('never returns the refresh token in the body', async () => {
    const { body, cookie } = await registerOrg();
    expect(JSON.stringify(body)).not.toContain(cookieValue(cookie));
  });
});

describe('login and /auth/me', () => {
  it('signs in and reports the right role and organization', async () => {
    await registerOrg();

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@meridian.test', password: PASSWORD });
    expect(login.status).toBe(200);

    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${login.body.data.accessToken}`);

    expect(me.status).toBe(200);
    expect(me.body.data.role).toBe('ORG_ADMIN');
    expect(me.body.data.organization.name).toBe('Meridian Industries Pvt Ltd');
    expect(me.body.data).not.toHaveProperty('passwordHash');
  });

  it('answers identically for an unknown email and a wrong password', async () => {
    await registerOrg();

    const wrongEmail = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@meridian.test', password: PASSWORD });
    const wrongPassword = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@meridian.test', password: 'WrongPassword1' });

    expect(wrongEmail.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    expect(wrongEmail.body.error).toEqual(wrongPassword.body.error);
  });

  it('rejects an expired access token', async () => {
    await registerOrg();
    const expired = jwt.sign({ role: 'ORG_ADMIN' }, env.JWT_ACCESS_SECRET, {
      subject: '01a09a49-0000-7000-8000-000000000000',
      expiresIn: '-1s',
    });

    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${expired}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('auth.unauthorized');
  });

  it('locks the account after five failures, then rejects even the correct password', async () => {
    await registerOrg();

    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'admin@meridian.test', password: 'WrongPassword1' });
      expect(res.status).toBe(401);
    }

    // Correct password + locked account is the one case that reveals the lock
    // (03 §4) — a wrong password keeps answering 401, or the endpoint becomes
    // an account-existence oracle.
    const locked = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@meridian.test', password: PASSWORD });

    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe('auth.account_locked');

    const stillHidden = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@meridian.test', password: 'WrongPassword1' });
    expect(stillHidden.status).toBe(401);

    const audit = await prisma.activityLog.findFirst({ where: { action: 'auth.account_locked' } });
    expect(audit?.severity).toBe('SECURITY');
  });
});

describe('refresh rotation', () => {
  it('sets a different cookie and returns a new access token', async () => {
    const { cookie } = await registerOrg();

    const res = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(cookieValue(refreshCookie(res))).not.toBe(cookieValue(cookie));
  });

  it('detects reuse: the old token kills the whole family', async () => {
    const { cookie: original } = await registerOrg();

    const first = await request(app).post('/api/v1/auth/refresh').set('Cookie', original);
    expect(first.status).toBe(200);
    const successor = refreshCookie(first);

    // Replay the spent token.
    const replay = await request(app).post('/api/v1/auth/refresh').set('Cookie', original);
    expect(replay.status).toBe(401);

    // The successor is now dead too — the entire family was revoked.
    const afterReuse = await request(app).post('/api/v1/auth/refresh').set('Cookie', successor);
    expect(afterReuse.status).toBe(401);

    const audit = await prisma.activityLog.findFirst({
      where: { action: 'auth.refresh_reuse_detected' },
    });
    expect(audit?.severity).toBe('SECURITY');

    const live = await prisma.refreshToken.count({ where: { revokedAt: null } });
    expect(live).toBe(0);
  });

  it('scopes the refresh cookie to /api/v1/auth and marks it HttpOnly', async () => {
    const { cookie } = await registerOrg();

    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/i);
  });

  it('rejects a refresh with no cookie at all', async () => {
    const res = await request(app).post('/api/v1/auth/refresh');
    expect(res.status).toBe(401);
  });
});

describe('logout', () => {
  it('revokes only the current session', async () => {
    const { cookie, accessToken } = await registerOrg();
    const second = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@meridian.test', password: PASSWORD });

    await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Cookie', cookie)
      .expect(200);

    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie)).status).toBe(401);
    expect(
      (await request(app).post('/api/v1/auth/refresh').set('Cookie', refreshCookie(second))).status,
    ).toBe(200);
  });

  it('logout-all revokes every session', async () => {
    const { cookie, accessToken } = await registerOrg();
    const second = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@meridian.test', password: PASSWORD });

    await request(app)
      .post('/api/v1/auth/logout-all')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie)).status).toBe(401);
    expect(
      (await request(app).post('/api/v1/auth/refresh').set('Cookie', refreshCookie(second))).status,
    ).toBe(401);
  });
});

describe('passwords', () => {
  it('change-password keeps this session and kills the others', async () => {
    const { cookie, accessToken } = await registerOrg();
    const other = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@meridian.test', password: PASSWORD });

    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Cookie', cookie)
      .send({ currentPassword: PASSWORD, newPassword: 'BrandNewPass99' });

    expect(res.status).toBe(200);
    expect(res.body.data.revokedSessions).toBeGreaterThan(0);

    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie)).status).toBe(200);
    expect(
      (await request(app).post('/api/v1/auth/refresh').set('Cookie', refreshCookie(other))).status,
    ).toBe(401);
  });

  it('rejects a wrong current password', async () => {
    const { accessToken, cookie } = await registerOrg();

    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Cookie', cookie)
      .send({ currentPassword: 'NotThePass1', newPassword: 'BrandNewPass99' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('auth.wrong_password');
  });

  it('forgot-password answers identically for known and unknown emails', async () => {
    await registerOrg();

    const known = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'admin@meridian.test' });
    const unknown = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'ghost@meridian.test' });

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);

    const user = await prisma.user.findUnique({ where: { email: 'admin@meridian.test' } });
    expect(user?.resetTokenHash).toBeTruthy();
    // Only the hash is stored, never the token itself.
    expect(user?.resetTokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('reset-password is single use and revokes every session', async () => {
    const { cookie } = await registerOrg();
    await request(app).post('/api/v1/auth/forgot-password').send({ email: 'admin@meridian.test' });

    // The raw token only exists in the mail; recreate it the way the service did.
    const { randomToken, sha256 } = await import('../src/lib/crypto.js');
    const token = randomToken(32);
    await prisma.user.update({
      where: { email: 'admin@meridian.test' },
      data: { resetTokenHash: sha256(token), resetTokenExpiresAt: new Date(Date.now() + 60_000) },
    });

    const first = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: 'ResetPass1234' });
    expect(first.status).toBe(200);

    const replay = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: 'ResetPass1234' });
    expect(replay.status).toBe(410);

    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie)).status).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/v1/auth/login')
          .send({ email: 'admin@meridian.test', password: 'ResetPass1234' })
      ).status,
    ).toBe(200);
  });
});

describe('invitations', () => {
  async function invite(accessToken: string, email: string, role = 'ORG_OFFICER') {
    return request(app)
      .post('/api/v1/invitations')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ email, role });
  }

  /** The raw token never leaves the mailer, so tests mint their own. */
  async function inviteWithToken(accessToken: string, email: string, role = 'ORG_OFFICER') {
    const res = await invite(accessToken, email, role);
    expect(res.status).toBe(201);
    const { randomToken, sha256 } = await import('../src/lib/crypto.js');
    const token = randomToken(32);
    await prisma.invitation.update({
      where: { id: res.body.data.id },
      data: { tokenHash: sha256(token) },
    });
    return token;
  }

  it('previews and accepts, creating an ACTIVE user in the same organization', async () => {
    const { accessToken } = await registerOrg();
    const token = await inviteWithToken(accessToken, 'officer@meridian.test');

    const preview = await request(app).get(`/api/v1/invitations/${token}`);
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({
      email: 'officer@meridian.test',
      role: 'ORG_OFFICER',
      partyName: 'Meridian Industries Pvt Ltd',
    });

    const accepted = await request(app)
      .post(`/api/v1/invitations/${token}/accept`)
      .send({ fullName: 'Arun Mehta', password: PASSWORD });

    expect(accepted.status).toBe(201);
    expect(accepted.body.data.user.role).toBe('ORG_OFFICER');
    expect(accepted.body.data.user.organization.name).toBe('Meridian Industries Pvt Ltd');

    const user = await prisma.user.findUnique({ where: { email: 'officer@meridian.test' } });
    expect(user?.status).toBe('ACTIVE');
  });

  it('409s when the email already has an account', async () => {
    const { accessToken } = await registerOrg();
    const token = await inviteWithToken(accessToken, 'officer@meridian.test');

    await request(app)
      .post(`/api/v1/invitations/${token}/accept`)
      .send({ fullName: 'Arun Mehta', password: PASSWORD })
      .expect(201);

    // Same invitation, now that the account exists.
    const second = await request(app)
      .post(`/api/v1/invitations/${token}/accept`)
      .send({ fullName: 'Arun Mehta', password: PASSWORD });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('invitation.already_accepted');

    const direct = await invite(accessToken, 'officer@meridian.test');
    expect(direct.status).toBe(409);
    expect(direct.body.error.code).toBe('invitation.user_exists');
  });

  it('410s an expired invitation', async () => {
    const { accessToken } = await registerOrg();
    const token = await inviteWithToken(accessToken, 'officer@meridian.test');
    await prisma.invitation.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await request(app).get(`/api/v1/invitations/${token}`);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('invitation.expired');
  });

  it('a second invitation for the same email revokes the first', async () => {
    const { accessToken } = await registerOrg();
    await invite(accessToken, 'officer@meridian.test');
    await invite(accessToken, 'officer@meridian.test');

    const live = await prisma.invitation.count({
      where: { email: 'officer@meridian.test', revokedAt: null, acceptedAt: null },
    });
    expect(live).toBe(1);
  });

  it('an ORG_OFFICER cannot invite anyone', async () => {
    const { accessToken } = await registerOrg();
    const token = await inviteWithToken(accessToken, 'officer@meridian.test');
    const accepted = await request(app)
      .post(`/api/v1/invitations/${token}/accept`)
      .send({ fullName: 'Arun Mehta', password: PASSWORD });

    const res = await invite(accepted.body.data.accessToken, 'another@meridian.test');
    expect(res.status).toBe(403);
  });

  it('a vendor cannot mint an ORG_ADMIN', async () => {
    const vendor = await request(app).post('/api/v1/auth/register/vendor').send(vendorPayload());

    const res = await invite(vendor.body.data.accessToken, 'sneaky@apex.test', 'ORG_ADMIN');
    expect(res.status).toBe(403);
  });

  it('requires authentication to create one', async () => {
    const res = await request(app).post('/api/v1/invitations').send({ email: 'x@y.test', role: 'ORG_OFFICER' });
    expect(res.status).toBe(401);
  });
});

describe('log redaction', () => {
  it('never writes a password or a token to the log', async () => {
    const lines: string[] = [];
    const probe = pino(
      { redact: { paths: redactPaths, censor: '[redacted]' } },
      { write: (line: string) => lines.push(line) },
    );

    probe.info({
      req: { headers: { authorization: 'Bearer secret-access-token', cookie: 'tb_rt=secret-refresh' } },
      body: { password: 'Sup3rSecretPass', newPassword: 'BrandNewPass99' },
      user: { passwordHash: '$2a$12$hash', refreshToken: 'raw-refresh-token' },
    });

    const output = lines.join('\n');
    expect(output).not.toContain('Sup3rSecretPass');
    expect(output).not.toContain('BrandNewPass99');
    expect(output).not.toContain('secret-access-token');
    expect(output).not.toContain('secret-refresh');
    expect(output).not.toContain('raw-refresh-token');
    expect(output).toContain('[redacted]');
  });
});
