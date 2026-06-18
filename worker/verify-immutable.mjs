#!/usr/bin/env node
// worker/verify-immutable.mjs
// Verifies that sealed_days rejects UPDATE and DELETE.
// Run from worker/: node verify-immutable.mjs

import pkg from 'pg'
const { Client } = pkg

const connectionString = process.env.SUPABASE_DB_URL
if (!connectionString) {
  console.error('SUPABASE_DB_URL is not set in the environment')
  process.exit(1)
}

const client = new Client({
  connectionString,
  ssl: { rejectUnauthorized: false },
})

await client.connect()
console.log('Connected.\n')

// Step 1: INSERT
try {
  await client.query("insert into sealed_days (seal_date_et) values ('2026-06-16')")
  console.log("INSERT into sealed_days (2026-06-16): OK")
} catch (e) {
  console.log("INSERT: UNEXPECTED ERROR:", e.message)
}

// Step 2: UPDATE (should fail)
try {
  await client.query("update sealed_days set seal_version = 2 where seal_date_et = '2026-06-16'")
  console.log("UPDATE: DID NOT ERROR — trigger NOT working!")
} catch (e) {
  console.log("UPDATE blocked (expected):", e.message)
}

// Step 3: DELETE (should fail)
try {
  await client.query("delete from sealed_days where seal_date_et = '2026-06-16'")
  console.log("DELETE: DID NOT ERROR — trigger NOT working!")
} catch (e) {
  console.log("DELETE blocked (expected):", e.message)
}

await client.end()
console.log('\nVerification complete. Test row (2026-06-16) cannot be cleaned up by design (DELETE is blocked).')
