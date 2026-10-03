import fs from 'fs';
import path from 'path';
import { config } from '../src/config/index.js';

async function run() {
  const sourceBackup = process.argv[2];
  if (!sourceBackup) {
    console.error('Usage: npm run db:restore <path/to/backup.db>');
    process.exit(1);
  }

  const resolvedSource = path.resolve(sourceBackup);
  if (!fs.existsSync(resolvedSource)) {
    console.error(`❌ Source backup file does not exist: ${resolvedSource}`);
    process.exit(1);
  }

  const targetDb = path.resolve(config.DB_PATH);
  const targetDir = path.dirname(targetDb);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Create safety pre-restore backup of existing DB if present
  if (fs.existsSync(targetDb)) {
    const preRestoreBackup = `${targetDb}.pre-restore-${Date.now()}`;
    fs.copyFileSync(targetDb, preRestoreBackup);
    console.info(`[Restore] Preserved pre-restore backup at: ${preRestoreBackup}`);
  }

  try {
    fs.copyFileSync(resolvedSource, targetDb);
    // Also remove WAL / SHM files if they exist so the new database file takes clean effect
    if (fs.existsSync(`${targetDb}-wal`)) fs.unlinkSync(`${targetDb}-wal`);
    if (fs.existsSync(`${targetDb}-shm`)) fs.unlinkSync(`${targetDb}-shm`);

    console.info(`✅ [Restore Succeeded] Restored ${resolvedSource} -> ${targetDb}`);
    process.exit(0);
  } catch (err: any) {
    console.error(`❌ [Restore Failed]:`, err.message || err);
    process.exit(1);
  }
}

run();
