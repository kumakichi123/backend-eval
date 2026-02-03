import 'express-async-errors';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import Joi from 'joi';
import XLSX from 'xlsx';

dotenv.config();

const SUPABASE_JWT_SECRET: jwt.Secret = process.env.SUPABASE_JWT_SECRET ?? (() => { throw new Error('SUPABASE_JWT_SECRET is required'); })();
const {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  ADMIN_USER_ID = 'admin',
  ADMIN_TENANT_ID = process.env.DEFAULT_TENANT_ID || '11111111-1111-1111-1111-111111111111'
} = process.env;

if (!SUPABASE_JWT_SECRET) {
  throw new Error('SUPABASE_JWT_SECRET is required');
}

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function authMiddleware(req: any, res: any, next: any) {
  const h = req.headers['authorization'];
  if (!h) return res.status(401).json({ error: 'missing authorization' });
  const [scheme, token] = h.split(' ');
  if (scheme !== 'Bearer' || !token) return res.status(401).json({ error: 'bad auth header' });
  try {
    const payload = jwt.verify(token, SUPABASE_JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }
}

const templatePostSchema = Joi.object({
  role: Joi.string().required(),
  title: Joi.string().required(),
  max_score: Joi.number().integer().min(1).required(),
  items: Joi.array()
    .items(
      Joi.object({
        key: Joi.string().required(),
        label: Joi.string().allow('').required(),
        description: Joi.string().allow('').required(),
        weight: Joi.number().optional(),
        display_order: Joi.number().integer().optional()
      })
    )
    .min(1)
    .required()
});

const templatePutSchema = Joi.object({
  title: Joi.string(),
  max_score: Joi.number().integer().min(1),
  items: Joi.array().items(
    Joi.object({
      key: Joi.string().required(),
      label: Joi.string().allow('').required(),
      description: Joi.string().allow('').required(),
      weight: Joi.number().optional(),
      display_order: Joi.number().integer().optional()
    })
  )
});

const staffPostSchema = Joi.object({
  name: Joi.string().min(1).required(),
  role: Joi.string().allow('').optional(),
  staff_code: Joi.string().allow('').optional()
});

const staffPutSchema = Joi.object({
  name: Joi.string().min(1).optional(),
  role: Joi.string().allow('').optional(),
  staff_code: Joi.string().allow('').optional()
}).min(1);

const evalPostSchema = Joi.object({
  templateId: Joi.string().uuid().required(),
  period: Joi.string().required(),
  evaluations: Joi.array()
    .items(
      Joi.object({
        staffId: Joi.string().uuid().required(),
        scores: Joi.object().pattern(/.*/, Joi.number().integer().min(0)).required()
      })
    )
    .min(1)
    .required(),
  evaluatorRole: Joi.string().required()
});

function asUuid(value: string) {
  return Joi.string().uuid().validate(value).error == null;
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/auth/login', (req, res) => {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'admin credentials not configured' });
  }
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'invalid email or password' });
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresIn = 60 * 60 * 8;
  const exp = now + expiresIn;
  const payload = {
    aud: 'authenticated',
    exp,
    iat: now,
    sub: ADMIN_USER_ID,
    email: ADMIN_EMAIL,
    role: 'admin',
    tenant_id: ADMIN_TENANT_ID
  };
  const token = jwt.sign(payload, SUPABASE_JWT_SECRET, { algorithm: 'HS256' });
  res.json({ token, expiresIn, tenantId: ADMIN_TENANT_ID });
});
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!; // 必須
const APP_JWT_SECRET = process.env.APP_JWT_SECRET || SUPABASE_JWT_SECRET; // 既存名流用でも可
const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// これを authMiddleware の前に置く
app.post("/auth/supabase", async (req, res) => {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return res.status(401).json({ error: "missing token" });

  const { data, error } = await supa.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: "invalid token" });

  const now = Math.floor(Date.now() / 1000);
  const exp = now + 60 * 60 * 8;
  const payload = {
    aud: "authenticated",
    exp, iat: now,
    sub: data.user.id,
    email: data.user.email,
    role: "admin",
    tenant_id: ADMIN_TENANT_ID,
  };
  const appJwt = jwt.sign(payload, APP_JWT_SECRET!, { algorithm: "HS256" });
  return res.json({ token: appJwt, tenantId: ADMIN_TENANT_ID });
});

app.use(authMiddleware);

app.get('/api/templates/:tenantId/:role', async (req, res) => {
  const { tenantId, role } = req.params;
  if (!asUuid(tenantId)) return res.status(400).json({ error: 'bad tenantId' });

  const client = await pool.connect();
  try {
    const templateRes = await client.query(
      'SELECT * FROM templates WHERE tenant_id=$1 AND role=$2 ORDER BY created_at DESC LIMIT 1',
      [tenantId, role]
    );
    if (templateRes.rowCount === 0) return res.json({ template: null, items: [], staff: [] });
    const template = templateRes.rows[0];
    const items = (
      await client.query(
        'SELECT item_key, label, description, weight, display_order FROM template_items WHERE tenant_id=$1 AND template_id=$2 ORDER BY display_order, item_key',
        [tenantId, template.id]
      )
    ).rows;
    const staff = (
      await client.query(
        'SELECT id, name, role, staff_code FROM staff WHERE tenant_id=$1 ORDER BY name',
        [tenantId]
      )
    ).rows;
    res.json({ template, items, staff });
  } finally {
    client.release();
  }
});

app.post('/api/templates/:tenantId', async (req, res) => {
  const { error, value } = templatePostSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.message });
  const { tenantId } = req.params;
  const { role, title, max_score, items } = value;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      'INSERT INTO templates(tenant_id, role, title, max_score) VALUES($1,$2,$3,$4) RETURNING *',
      [tenantId, role, title, max_score]
    );
    const template = inserted.rows[0];
    for (const [i, item] of items.entries()) {
      await client.query(
        'INSERT INTO template_items(tenant_id, template_id, item_key, label, description, weight, display_order) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [tenantId, template.id, item.key, item.label, item.description, item.weight ?? 1, item.display_order ?? i]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ templateId: template.id });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put('/api/templates/:tenantId/:templateId', async (req, res) => {
  const { error, value } = templatePutSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.message });
  const { tenantId, templateId } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (value.title || value.max_score) {
      await client.query(
        'UPDATE templates SET title=COALESCE($1,title), max_score=COALESCE($2,max_score), version=version+1 WHERE id=$3 AND tenant_id=$4',
        [value.title ?? null, value.max_score ?? null, templateId, tenantId]
      );
    }
    if (value.items) {
      await client.query('DELETE FROM template_items WHERE tenant_id=$1 AND template_id=$2', [tenantId, templateId]);
      for (const [i, item] of value.items.entries()) {
        await client.query(
          'INSERT INTO template_items(tenant_id, template_id, item_key, label, description, weight, display_order) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [tenantId, templateId, item.key, item.label, item.description, item.weight ?? 1, item.display_order ?? i]
        );
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/staff/:tenantId', async (req, res) => {
  const { error, value } = staffPostSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.message });
  const { tenantId } = req.params;
  if (!asUuid(tenantId)) return res.status(400).json({ error: 'bad tenantId' });

  const trimmedName = value.name.trim();
  if (!trimmedName) return res.status(400).json({ error: '名前は必須です' });
  const rawRole = value.role ?? '';
  const roleValue = typeof rawRole === 'string' && rawRole.trim() ? rawRole.trim() : '職員';
  const rawCode = value.staff_code ?? '';
  const staffCode = typeof rawCode === 'string' && rawCode.trim() ? rawCode.trim() : null;

  const client = await pool.connect();
  try {
    const inserted = await client.query(
      'INSERT INTO staff(tenant_id, name, role, staff_code) VALUES($1,$2,$3,$4) RETURNING id, name, role, staff_code',
      [tenantId, trimmedName, roleValue, staffCode]
    );
    res.status(201).json({ staff: inserted.rows[0] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put('/api/staff/:tenantId/:staffId', async (req, res) => {
  const { error, value } = staffPutSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.message });
  const { tenantId, staffId } = req.params;
  if (!asUuid(tenantId) || !asUuid(staffId)) return res.status(400).json({ error: 'bad id' });

  const sets: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (value.name !== undefined) {
    const trimmed = String(value.name).trim();
    if (!trimmed) return res.status(400).json({ error: '名前は必須です' });
    sets.push(`name=$${idx++}`);
    values.push(trimmed);
  }
  if (value.role !== undefined) {
    const trimmedRole = String(value.role).trim();
    const resolvedRole = trimmedRole || '職員';
    sets.push(`role=$${idx++}`);
    values.push(resolvedRole);
  }
  if (value.staff_code !== undefined) {
    const trimmedCode = String(value.staff_code).trim();
    sets.push(`staff_code=$${idx++}`);
    values.push(trimmedCode || null);
  }

  if (sets.length === 0) {
    return res.status(400).json({ error: '更新項目がありません' });
  }

  const tenantIndex = idx++;
  const staffIndex = idx++;
  values.push(tenantId, staffId);

  const query = `UPDATE staff SET ${sets.join(', ')} WHERE tenant_id=$${tenantIndex} AND id=$${staffIndex} RETURNING id, name, role, staff_code`;

  const client = await pool.connect();
  try {
    const result = await client.query(query, values);
    if (result.rowCount === 0) return res.status(404).json({ error: 'staff not found' });
    res.json({ staff: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/evaluations/:tenantId/:role', async (req, res) => {
  const { tenantId, role } = req.params;
  const { period } = req.query as { period?: string };
  const client = await pool.connect();
  try {
    const templateRes = await client.query(
      'SELECT id, max_score FROM templates WHERE tenant_id=$1 AND role=$2 ORDER BY created_at DESC LIMIT 1',
      [tenantId, role]
    );
    if (templateRes.rowCount === 0) return res.json({ evaluations: [] });
    const templateId = templateRes.rows[0].id;
    const params: any[] = [tenantId, templateId];
    const periodClause = period ? 'AND e.period=$3' : '';
    if (period) params.push(period);
    const rows = (
      await client.query(
        `SELECT e.id as evaluation_id, e.period, e.evaluator_role, ei.staff_id, ei.item_key, ei.score
         FROM evaluations e
         JOIN evaluation_items ei ON ei.evaluation_id=e.id
         WHERE e.tenant_id=$1 AND e.template_id=$2 ${periodClause}`,
        params
      )
    ).rows;
    res.json({ templateId, max_score: templateRes.rows[0].max_score, rows });
  } finally {
    client.release();
  }
});

app.post('/api/evaluations/:tenantId', async (req, res) => {
  const { error, value } = evalPostSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.message });
  const { tenantId } = req.params;
  const { templateId, period, evaluations, evaluatorRole } = value;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      'INSERT INTO evaluations(tenant_id, template_id, period, evaluator_role) VALUES($1,$2,$3,$4) RETURNING id',
      [tenantId, templateId, period, evaluatorRole]
    );
    const evaluationId = inserted.rows[0].id;
    for (const ev of evaluations) {
      for (const [itemKey, score] of Object.entries(ev.scores)) {
        await client.query(
          'INSERT INTO evaluation_items(tenant_id, evaluation_id, staff_id, item_key, score) VALUES($1,$2,$3,$4,$5) ON CONFLICT (evaluation_id, staff_id, item_key) DO UPDATE SET score=EXCLUDED.score',
          [tenantId, evaluationId, ev.staffId, itemKey, score]
        );
      }
    }
    await client.query('COMMIT');
    res.status(201).json({ evaluationId });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/export/:tenantId/:role', async (req, res) => {
  const { tenantId, role } = req.params;
  const format = (req.query.format as string) || 'csv';
  const client = await pool.connect();
  try {
    const templateRes = await client.query(
      'SELECT id, title, max_score FROM templates WHERE tenant_id=$1 AND role=$2 ORDER BY created_at DESC LIMIT 1',
      [tenantId, role]
    );
    if (templateRes.rowCount === 0) return res.status(404).json({ error: 'template not found' });
    const templateId = templateRes.rows[0].id;
    const items = (
      await client.query(
        'SELECT item_key, label, description FROM template_items WHERE tenant_id=$1 AND template_id=$2 ORDER BY display_order, item_key',
        [tenantId, templateId]
      )
    ).rows;
    const staff = (
      await client.query('SELECT id, name FROM staff WHERE tenant_id=$1 ORDER BY name', [tenantId])
    ).rows;
    const rows = (
      await client.query(
        `
        SELECT e.period, e.evaluator_role, st.name AS staff_name, ei.item_key, ei.score
        FROM evaluations e
        JOIN evaluation_items ei ON ei.evaluation_id = e.id
        JOIN staff st ON st.id = ei.staff_id
        WHERE e.tenant_id = $1 AND e.template_id = $2
        ORDER BY e.created_at DESC, st.name, ei.item_key
      `,
        [tenantId, templateId]
      )
    ).rows;

    const header = ['period', 'evaluator_role', 'item_key', ...staff.map((s) => s.name)];
    const byKey: Record<string, any> = {};
    for (const row of rows) {
      const key = `${row.period}|${row.evaluator_role}|${row.item_key}`;
      if (!byKey[key]) {
        byKey[key] = { period: row.period, evaluator_role: row.evaluator_role, item_key: row.item_key };
      }
      byKey[key][row.staff_name] = row.score;
    }
    const lines = Object.values(byKey);

    if (format === 'xlsx') {
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(lines, { header });
      XLSX.utils.book_append_sheet(wb, ws, 'export');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=export_${role}.xlsx`);
      res.send(buf);
    } else {
      const csv = [header.join(',')]
        .concat(lines.map((obj) => header.map((h) => obj[h] ?? '').join(',')))
        .join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename=export_${role}.csv`);
      res.send(csv);
    }
  } finally {
    client.release();
  }
});

app.post('/api/dify/generate', async (req, res) => {
  const { tenantId, role, seedText, style } = req.body || {};
  if (!tenantId || !role || !seedText) {
    return res.status(400).json({ error: 'tenantId, role, seedText required' });
  }

  const prompt = buildDifyPrompt(role, seedText);
  const fallback = buildFallbackResponse(role, seedText);
  const apiKey = process.env.DIFY_API_KEY;
  if (!apiKey) {
    return res.json({ ...fallback, promptUsed: prompt, from: 'mock' });
  }

  try {
    const response = await fetch('https://api.dify.ai/v1/workflows/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        response_mode: 'blocking',
        user: `tenant:${tenantId}`,
        inputs: {
          tenantId,
          role,
          seedText,
          style: style ?? ''
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Dify status ${response.status}`);
    }

    const data = await response.json();
    console.log('dify.generate response', JSON.stringify(data));
    const status = (data?.status || data?.data?.status || '').toString().toLowerCase();
    if (status && status !== 'succeeded') {
      const errorMessage =
        data?.error ||
        data?.message ||
        data?.data?.error ||
        data?.data?.message ||
        'Dify workflow returned a failed status';
      throw new Error(errorMessage);
    }

    const rawText =
      data?.data?.output_text ||
      data?.data?.outputs?.output_text ||
      data?.data?.outputs?.text ||
      data?.data?.outputs?.[0]?.output_text ||
      data?.data?.outputs?.[0]?.text ||
      data?.output_text ||
      data?.outputs?.output_text ||
      data?.outputs?.text ||
      data?.outputs?.[0]?.output_text ||
      data?.outputs?.[0]?.text ||
      '';
    if (!rawText) {
      throw new Error('Dify response missing output_text');
    }

    const parsed = parseDifyOutput(rawText);
    return res.json({ ...parsed, promptUsed: prompt, from: 'dify' });
  } catch (err: any) {
    console.error('dify.generate failed', err);
    return res.json({ ...fallback, promptUsed: prompt, from: 'mock', error: err?.message || 'dify error' });
  }
});

app.use((err: any, _req: any, res: any, _next: any) => {
  console.error(err);
  res.status(500).json({ error: 'internal' });
});

const port = Number(process.env.PORT || 3001);
app.listen(port, () => {
  console.log('listening', port);
});

function buildDifyPrompt(role: string, seedText: string) {
  const trimmed = seedText.trim().replace(/\s+/g, ' ');
  return [
    `You are assisting a kindergarten in defining competency rubrics.`,
    `Base your response on this observation: "${trimmed}".`,
    `Return valid JSON: {"definition": "...", "rubric": ["5: ...","4: ...","3: ...","2: ...","1: ..."], "example": "..."}.`,
    `The definition must mention the role "${role}" and be within 80 Japanese characters.`,
    `Each rubric entry must describe the proficiency level in concise Japanese (<=40 chars).`,
    `The example should be a single sentence showing level 5 behaviour.`
  ].join('\n');
}

function buildFallbackResponse(role: string, seedText: string) {
  const base = seedText.trim().replace(/\s+/g, ' ');
  const core = base.slice(0, 40) || '観察メモ';
  const itemName = `${role}:${core}`;
  const itemDescription = `${core} に関する簡易コンピテンシー項目（フォールバック生成）`;
  return { itemName, itemDescription };
}


function parseDifyOutput(text: string) {
  const cleaned = text.trim().replace(/^```json/i, '').replace(/```$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    const itemName = typeof parsed.itemName === 'string' ? parsed.itemName.trim() : '';
    const itemDescription = typeof parsed.itemDescription === 'string' ? parsed.itemDescription.trim().replace(/\\\n/g, '\n') : '';
    if (itemName || itemDescription) {
      return { itemName, itemDescription };
    }
  } catch {
    // ignore parse errors and fall through
  }
  const lines = cleaned.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return {
    itemName: lines[0] || 'AI???????',
    itemDescription: lines.slice(1).join('\n') || lines[0] || ''
  };
}


