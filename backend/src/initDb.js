import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schema.sql');

// Applies schema.sql on boot. Idempotent (CREATE ... IF NOT EXISTS), so safe on
// every restart. Retries because Postgres may not accept connections yet.
export async function initDb(retries = 10, delayMs = 1500) {
  const sql = fs.readFileSync(schemaPath, 'utf8');
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query(sql);
      console.log('schema ready');
      return;
    } catch (err) {
      if (attempt === retries) throw err;
      console.log(`db not ready (${err.code || err.message}), retry ${attempt}/${retries}...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
