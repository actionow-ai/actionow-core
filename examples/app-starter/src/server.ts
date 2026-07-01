import express from 'express';

import { config } from './config.js';
import { ConsoleSession } from './core-kit/index.js';
import { asyncHandler, errorMiddleware } from './http.js';
import { chatRoute } from './routes/chat.js';
import { filesRoute } from './routes/files.js';
import { mediaRoute } from './routes/media.js';
import { onboardRoute } from './routes/onboard.js';
import { topupRoute } from './routes/topup.js';
import { webhookRoute } from './routes/webhook.js';

const session = new ConsoleSession(
  config.baseUrl(),
  config.consoleEmail(),
  config.consolePassword(),
);
const app = express();

// The webhook needs RAW bytes for signature verification — mount BEFORE express.json().
app.post(
  '/webhooks/actionow',
  express.raw({ type: 'application/json' }),
  asyncHandler(webhookRoute()),
);

app.use(express.json());
app.post('/api/users', asyncHandler(onboardRoute(session)));
app.post('/api/chat', asyncHandler(chatRoute()));
app.post('/api/topup', asyncHandler(topupRoute(session)));
app.post('/api/media', asyncHandler(mediaRoute()));
app.post('/api/files', asyncHandler(filesRoute()));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Terminal error middleware — turns a thrown gateway 402/404/timeout into a clean
// response instead of a hung request. MUST be registered last.
app.use(errorMiddleware);

// Backstop: never let a stray rejection take the process down silently.
process.on('unhandledRejection', (r) => console.error('unhandledRejection', r));

app.listen(config.port(), () => console.log(`app-starter on :${config.port()}`));
