import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { API_PREFIX } from './config/app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { globalRateLimit } from './middleware/rateLimit.js';
import { requestContext } from './middleware/requestContext.js';
import { router } from './routes.js';

/**
 * The Express app, with no listen(). supertest imports this directly, so
 * integration tests never open a port (plan 18 depends on it).
 *
 * Middleware order below is deliberate — do not shuffle it.
 */
export const app = express();

app.disable('x-powered-by');
// Render terminates TLS in front of the app; without this, rate limiting and
// req.ip see the proxy instead of the client.
app.set('trust proxy', 1);

app.use(helmet());
// Exact origin, never '*': credentials:true + a wildcard silently breaks the
// refresh-token cookie.
app.use(cors({ origin: env.APP_URL, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(requestContext);
app.use(pinoHttp({ logger, genReqId: (req) => req.id }));
app.use(globalRateLimit);

app.use(API_PREFIX, router);

app.use(notFound);
app.use(errorHandler); // must be last
