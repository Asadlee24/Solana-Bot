import fs from 'fs';
import path from 'path';
import { db } from '../src/db/database.js';

async function run() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.resolve('backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const destFile = path.join(backupDir, `solana_copy_bot_${timestamp}.db`);
  console.info(`[Backup] Starting online SQLite backup to: ${destFile}...`);

  try {
    const backupPath = await db.backup(destFile);
    const stats = fs.statSync(backupPath);
    console.info(`✅ [Backup Succeeded] Destination: ${backupPath} (Size: ${(stats.size / 1024).toFixed(1)} KB)`);
    process.exit(0);
  } catch (err: any) {
    console.error(`❌ [Backup Failed]:`, err.message || err);
    process.exit(1);
  }
}

run();
