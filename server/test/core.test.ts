import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { app } from '../src/app.js';
import { BusinessRule } from '../src/lib/errors.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { notFound } from '../src/middleware/notFound.js';
import { requestContext } from '../src/middleware/requestContext.js';
import { validate } from '../src/middleware/validate.js';

/**
 * A throwaway app that exercises the error pipeline without adding test-only
 * routes to the real router. Note the total absence of try/catch: Express 5
 * forwards thrown and rejected errors on its own.
 */
function harness() {
  const a = express();
  a.use(express.json());
  a.use(requestContext);

  a.get('/boom', () => {
    throw BusinessRule('test.code', 'test');
  });

  a.get('/async-boom', async () => {
    throw BusinessRule('test.async', 'async test');
  });

  a.post(
    '/validated',
    validate({ body: z.object({ email: z.string().email(), age: z.number().int() }).strict() }),
    (_req, res) => {
      res.json({ success: true, data: null });
    },
  );

  a.get('/kaboom', () => {
    throw new Error('unexpected');
  });

  a.use(notFound);
  a.use(errorHandler);
  return a;
}

describe('health endpoints', () => {
  it('GET /api/v1/health returns the envelope and never touches the database', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
    expect(typeof res.body.data.uptime).toBe('number');
    expect(res.body.data.version).toBeTruthy();
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('does not expose x-powered-by', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('error envelope', () => {
  it('a BusinessRule thrown in a route is 422 with a stable code', async () => {
    const res = await request(harness()).get('/boom');

    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('test.code');
    expect(res.body.error.message).toBe('test');
    expect(res.body.requestId).toBeTruthy();
  });

  it('an async route rejection lands in the same handler', async () => {
    const res = await request(harness()).get('/async-boom');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('test.async');
  });

  it('an invalid body is 422 with a populated fields array', async () => {
    const res = await request(harness()).post('/validated').send({ email: 'nope', age: 1.5 });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.fields.map((f: { path: string }) => f.path).sort()).toEqual([
      'age',
      'email',
    ]);
  });

  it('rejects unknown keys because every schema is .strict()', async () => {
    const res = await request(harness())
      .post('/validated')
      .send({ email: 'a@b.com', age: 30, isAdmin: true });

    expect(res.status).toBe(422);
    expect(res.body.error.fields[0].message).toMatch(/unrecognized|Unrecognized/i);
  });

  it('an unexpected error is 500 with a generic message', async () => {
    const res = await request(harness()).get('/kaboom');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('internal_error');
    expect(res.body.error.message).toBe('Something went wrong');
  });

  it('an unmatched route is 404 in the same envelope', async () => {
    const res = await request(app).get('/api/v1/nope');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('route_not_found');
  });
});
