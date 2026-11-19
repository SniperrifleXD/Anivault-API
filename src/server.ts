import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'path';
import routes from './routes';
import providerRoutes from './providers/routes';

const app = express();
const PORT = parseInt(process.env.PORT || '3000');

app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
  max: parseInt(process.env.RATE_LIMIT_MAX || '60'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
  // Signed HLS stream keys are validated by the proxy route itself. HLS
  // playlists and segments generate many requests during normal playback,
  // so do not apply the general API rate limit to this endpoint.
  skip: (req) => req.path.startsWith('/proxy/hls/'),
});
app.use('/api', limiter);

// API routes
app.use('/api', routes);
app.use('/api/providers', providerRoutes);

// Never let unknown API paths fall through to the documentation HTML.
// This also makes missing/un-deployed endpoints fail loudly as JSON instead
// of appearing to return a successful HTML page to API clients.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

// Serve static docs/tester
app.use(express.static(path.join(__dirname, '../public')));

// Catch-all → docs
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🟢 AniVault API running on http://localhost:${PORT}`);
  console.log(`📄 Docs + Tester: http://localhost:${PORT}/`);
  console.log(`🔗 API base:      http://localhost:${PORT}/api\n`);

});

export default app;
