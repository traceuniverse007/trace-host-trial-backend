import crypto from 'node:crypto';
import express from 'express';
import pg from 'pg';

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 10000);
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || 'https://trace-host-trial-202610.vercel.app,http://127.0.0.1:4192').split(',').map(v => v.trim()).filter(Boolean));
const databaseUrl = process.env.DATABASE_URL;
const adminToken = process.env.ADMIN_TOKEN;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false } }) : null;
const attempts = new Map();

app.disable('x-powered-by');
app.use(express.json({ limit: '24kb' }));
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && allowedOrigins.has(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if (req.method === 'OPTIONS') return allowedOrigins.has(origin) ? res.sendStatus(204) : res.sendStatus(403);
  next();
});

const clean = (value, max) => String(value ?? '').trim().replace(/[<>]/g, '').slice(0, max);
const validPhone = value => /^01[016789]-?\d{3,4}-?\d{4}$/.test(value.replace(/\s/g, ''));
const clientKey = req => crypto.createHash('sha256').update(`${req.ip}|${req.get('user-agent') || ''}`).digest('hex').slice(0, 24);

async function initDb() {
  if (!pool) throw new Error('DATABASE_URL is required');
  await pool.query(`CREATE TABLE IF NOT EXISTS host_applications (
    id BIGSERIAL PRIMARY KEY,
    public_id UUID NOT NULL UNIQUE,
    name VARCHAR(60) NOT NULL,
    phone VARCHAR(30) NOT NULL,
    category VARCHAR(50) NOT NULL,
    content TEXT NOT NULL,
    schedule VARCHAR(160) NOT NULL,
    wants_followup BOOLEAN NOT NULL DEFAULT FALSE,
    consented_at TIMESTAMPTZ NOT NULL,
    source VARCHAR(80) NOT NULL DEFAULT 'host-landing',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS host_applications_created_idx ON host_applications(created_at DESC)');
}

app.get('/', (_req, res) => res.json({ service: 'TRACE host trial applications', status: 'ok' }));
app.get('/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, time: new Date().toISOString() }); }
  catch { res.status(503).json({ ok: false }); }
});

app.post('/api/applications', async (req, res) => {
  const origin = req.get('origin');
  if (origin && !allowedOrigins.has(origin)) return res.status(403).json({ message: '허용되지 않은 요청이에요.' });
  if (clean(req.body.website, 200)) return res.status(202).json({ ok: true });
  const key = clientKey(req);
  const now = Date.now();
  const recent = (attempts.get(key) || []).filter(t => now - t < 60 * 60 * 1000);
  if (recent.length >= 5) return res.status(429).json({ message: '잠시 후 다시 시도해주세요.' });
  recent.push(now); attempts.set(key, recent);

  const name = clean(req.body.name, 60);
  const phone = clean(req.body.phone, 30);
  const category = clean(req.body.category, 50);
  const content = clean(req.body.content, 2000);
  const schedule = clean(req.body.schedule, 160);
  const requiredConsents = req.body.directHost === true && req.body.reviewConsent === true && req.body.privacyConsent === true;
  if (name.length < 2 || !validPhone(phone) || !category || content.length < 5 || !schedule || !requiredConsents) {
    return res.status(400).json({ message: '필수 항목과 동의를 다시 확인해주세요.' });
  }
  try {
    const publicId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO host_applications (public_id,name,phone,category,content,schedule,wants_followup,consented_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
      [publicId, name, phone, category, content, schedule, req.body.wantsFollowup === true]
    );
    res.status(201).json({ ok: true, id: publicId, message: '신청이 접수됐어요. 확인 후 연락드릴게요!' });
  } catch (error) {
    console.error('application insert failed', error?.message);
    res.status(500).json({ message: '접수 중 문제가 생겼어요. 잠시 후 다시 시도해주세요.' });
  }
});

app.get('/api/admin/applications', async (req, res) => {
  const supplied = req.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!adminToken || supplied !== adminToken) return res.status(401).json({ message: '인증이 필요해요.' });
  const result = await pool.query(`SELECT public_id,name,phone,category,content,schedule,wants_followup,consented_at,created_at
    FROM host_applications ORDER BY created_at DESC LIMIT 500`);
  res.json({ applications: result.rows });
});

initDb().then(() => app.listen(port, '0.0.0.0', () => console.log(`TRACE applications API listening on ${port}`))).catch(error => {
  console.error(error); process.exit(1);
});
