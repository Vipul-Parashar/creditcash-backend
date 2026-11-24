import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { createServer as createViteServer } from 'vite';
import { config } from './server/config.ts';
import { db } from './server/db/database.ts';
import { seedDatabase } from './server/db/seed.ts';
import { attachSession } from './server/middleware/auth.ts';
import { verifyCsrf } from './server/middleware/csrf.ts';
import { publicRoutes } from './server/routes/publicRoutes.ts';
import { authRoutes } from './server/routes/authRoutes.ts';
import { userRoutes } from './server/routes/userRoutes.ts';
import { withdrawalRoutes } from './server/routes/withdrawalRoutes.ts';
import { postbackRoutes, providerRoutes } from './server/routes/providerRoutes.ts';
import { advertiserRoutes } from './server/routes/advertiserRoutes.ts';
import { adminRoutes } from './server/routes/adminRoutes.ts';

async function startServer() {
  await db.init();
  await seedDatabase();

  const app = express();
  app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: false, // Allows Vite module scripts & official provider offerwall iframes
      crossOriginEmbedderPolicy: false,
      frameguard: false, // Allows preview inside AI Studio / Replit iframe
    })
  );

  app.use(cookieParser());

  // Preserve raw body buffer for AdGem v3 HMAC-SHA256 Signature verification
  app.use(
    express.json({
      limit: '4mb',
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      },
    })
  );

  // Serve advertiser-uploaded campaign images safely
  const uploadsDir = path.resolve(process.cwd(), 'data', 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  app.use('/uploads', express.static(uploadsDir, { maxAge: '1d' }));

  // Health probe
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, dbDriver: db.driver });
  });

  // Official Server-to-Server Provider Postbacks (authenticated via cryptographic signatures, not cookies/CSRF)
  app.use('/api/postbacks', postbackRoutes);
  app.use('/api/v1/postbacks', postbackRoutes);

  // Attach user session & enforce CSRF on state-changing authenticated API calls
  app.use('/api', attachSession, verifyCsrf);

  // Mount versioned & primary REST API routes (WordPress REST namespace ready)
  for (const prefix of ['/api', '/api/v1']) {
    app.use(`${prefix}/public`, publicRoutes);
    app.use(`${prefix}/auth`, authRoutes);
    app.use(`${prefix}/user`, userRoutes);
    app.use(`${prefix}/withdrawals`, withdrawalRoutes);
    app.use(`${prefix}/providers`, providerRoutes);
    app.use(`${prefix}/advertiser`, advertiserRoutes);
    app.use(`${prefix}/admin`, adminRoutes);
  }

  // Fallback 404 for unknown API paths
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  // Frontend serving: Vite dev middleware in development, dist/ bundle in production
  const distDir = path.resolve(process.cwd(), 'dist');
  if (!config.isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`Kredova server running on http://0.0.0.0:${config.port} (db: ${db.driver})`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
