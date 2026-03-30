import { createClient, type Client } from '@libsql/client'
import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import jwt from 'jsonwebtoken'

dotenv.config()

const PORT = Number(process.env.PORT ?? 4000)
const DATABASE_URL = (process.env.DATABASE_URL ?? '').trim()
const TURSO_AUTH_TOKEN = (process.env.TURSO_AUTH_TOKEN ?? '').trim()
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL ?? '').trim()
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD ?? '').trim()
const JWT_SECRET = (process.env.JWT_SECRET ?? '').trim()

type SiteContent = {
  portfolio: Record<string, unknown>
  projects: unknown[]
}

function isValidSiteContent(value: unknown): value is SiteContent {
  if (!value || typeof value !== 'object') return false
  const candidate = value as SiteContent
  return Boolean(candidate.portfolio) && Array.isArray(candidate.projects)
}

function loadSeedJson(): string {
  const path = join(process.cwd(), 'seed', 'siteContent.json')
  return readFileSync(path, 'utf8')
}

function requireEnv(name: string, value: string) {
  if (!value) {
    console.error(`Missing required env: ${name}`)
    process.exit(1)
  }
}

requireEnv('DATABASE_URL', DATABASE_URL)
requireEnv('ADMIN_EMAIL', ADMIN_EMAIL)
requireEnv('ADMIN_PASSWORD', ADMIN_PASSWORD)
requireEnv('JWT_SECRET', JWT_SECRET)

const client: Client = createClient({
  url: DATABASE_URL,
  ...(TURSO_AUTH_TOKEN ? { authToken: TURSO_AUTH_TOKEN } : {}),
})

async function migrate() {
  await client.execute(
    `CREATE TABLE IF NOT EXISTS site_content (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  )
  await client.execute(
    `CREATE TABLE IF NOT EXISTS resume_pdf (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  )
}

async function ensureSeed() {
  const row = await client.execute({
    sql: 'SELECT data FROM site_content WHERE id = 1',
    args: [],
  })
  if (row.rows.length > 0) return
  const seed = loadSeedJson()
  const now = Date.now()
  await client.execute({
    sql: `INSERT INTO site_content (id, data, updated_at) VALUES (1, ?, ?)`,
    args: [seed, now],
  })
}

async function readSiteContent(): Promise<SiteContent | null> {
  const row = await client.execute({
    sql: 'SELECT data FROM site_content WHERE id = 1',
    args: [],
  })
  if (row.rows.length === 0) return null
  const r = row.rows[0]
  const raw = typeof r.data === 'string' ? r.data : r[0]
  if (typeof raw !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isValidSiteContent(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function writeSiteContent(content: SiteContent) {
  const json = JSON.stringify(content)
  const now = Date.now()
  await client.execute({
    sql: `INSERT INTO site_content (id, data, updated_at) VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    args: [json, now],
  })
}

function blobValueToBuffer(value: unknown): Buffer | null {
  if (value == null) return null
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  return null
}

async function resumeExists(): Promise<boolean> {
  const row = await client.execute({
    sql: 'SELECT 1 FROM resume_pdf WHERE id = 1',
    args: [],
  })
  return row.rows.length > 0
}

async function readResumePdfBuffer(): Promise<Buffer | null> {
  const row = await client.execute({
    sql: 'SELECT data FROM resume_pdf WHERE id = 1',
    args: [],
  })
  if (row.rows.length === 0) return null
  const r = row.rows[0]
  const cell = typeof r.data !== 'undefined' ? r.data : r[0]
  return blobValueToBuffer(cell)
}

async function writeResumePdfBuffer(buf: Buffer) {
  const now = Date.now()
  const bytes = new Uint8Array(buf)
  await client.execute({
    sql: `INSERT INTO resume_pdf (id, data, updated_at) VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    args: [bytes, now],
  })
}

function authMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  const token = header.slice('Bearer '.length).trim()
  try {
    jwt.verify(token, JWT_SECRET)
    next()
  } catch {
    res.status(401).json({ error: 'Unauthorized' })
  }
}

async function main() {
  await migrate()
  await ensureSeed()

  const app = express()
  app.use(
    cors({
      // Allow any origin. Since the frontend uses a bearer token (no cookies),
      // we don't need to send CORS credentials.
      origin: true,
      credentials: false,
    }),
  )
  app.use(express.json({ limit: '2mb' }))

  const resumePdfBodyParser = express.raw({
    type: 'application/pdf',
    limit: '8mb',
  })

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true })
  })

  app.post('/api/auth/login', (req, res) => {
    const body = req.body as { email?: string; password?: string }
    const email = (body.email ?? '').trim()
    const password = (body.password ?? '').trim()
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password required' })
      return
    }
    if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
      res.status(401).json({ error: 'Invalid credentials' })
      return
    }
    const token = jwt.sign({ sub: 'admin' }, JWT_SECRET, { expiresIn: '7d' })
    res.json({ token })
  })

  app.get('/api/site-content', async (_req, res) => {
    const content = await readSiteContent()
    if (!content) {
      res.status(500).json({ error: 'Invalid stored content' })
      return
    }
    res.json(content)
  })

  app.put('/api/site-content', authMiddleware, async (req, res) => {
    const body = req.body
    if (!isValidSiteContent(body)) {
      res.status(400).json({ error: 'Invalid site content payload' })
      return
    }
    try {
      await writeSiteContent(body)
      res.json({ ok: true })
    } catch (e) {
      console.error(e)
      res.status(500).json({ error: 'Failed to save' })
    }
  })

  app.get('/api/resume/status', async (_req, res) => {
    try {
      const hasResume = await resumeExists()
      res.json({ hasResume })
    } catch (e) {
      console.error(e)
      res.status(500).json({ error: 'Failed to read resume status' })
    }
  })

  app.get('/api/resume', async (_req, res) => {
    try {
      const buf = await readResumePdfBuffer()
      if (!buf || buf.length === 0) {
        res.status(404).json({ error: 'No resume uploaded' })
        return
      }
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', 'attachment; filename="resume.pdf"')
      res.send(buf)
    } catch (e) {
      console.error(e)
      res.status(500).json({ error: 'Failed to read resume' })
    }
  })

  app.put(
    '/api/resume',
    authMiddleware,
    resumePdfBodyParser,
    async (req, res) => {
      const body = req.body
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: 'Send raw PDF body with Content-Type: application/pdf' })
        return
      }
      if (body.subarray(0, 4).toString('ascii') !== '%PDF') {
        res.status(400).json({ error: 'File must be a valid PDF' })
        return
      }
      try {
        await writeResumePdfBuffer(body)
        res.json({ ok: true })
      } catch (e) {
        console.error(e)
        res.status(500).json({ error: 'Failed to save resume' })
      }
    },
  )

  app.listen(PORT, () => {
    console.log(`API listening on http://localhost:${PORT}`)
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
