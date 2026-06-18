#!/usr/bin/env node
// worker/apply-migration.mjs
// Usage: node apply-migration.mjs <path-to-sql-file>  (run from worker/)
// Reads SUPABASE_DB_URL from process.env (never hardcoded).

import { readFileSync } from 'fs'
import pkg from 'pg'
const { Client } = pkg

const sqlFile = process.argv[2]
if (!sqlFile) {
  console.error('Usage: node apply-migration.mjs <path-to-sql-file>')
  process.exit(1)
}

const connectionString = process.env.SUPABASE_DB_URL
if (!connectionString) {
  console.error('SUPABASE_DB_URL is not set in the environment')
  process.exit(1)
}

const sql = readFileSync(sqlFile, 'utf8')

const client = new Client({
  connectionString,
  ssl: { rejectUnauthorized: false },
})

try {
  await client.connect()
  console.log('Connected to database.')
  await client.query(sql)
  console.log(`Migration applied: ${sqlFile}`)
} catch (err) {
  console.error('Migration failed:', err.message)
  process.exit(1)
} finally {
  await client.end()
}
