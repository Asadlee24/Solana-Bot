import { db } from '../src/db/database.js';

function cleanup() {
  const d = (db as any).db;
  const r1 = d.prepare("DELETE FROM mirror_orders WHERE token_mint LIKE '%Toke%' OR token_mint LIKE '%TokenMint%'").run();
  const r2 = d.prepare("DELETE FROM mirror_intents WHERE token_mint LIKE '%Toke%' OR token_mint LIKE '%TokenMint%'").run();
  const r3 = d.prepare("DELETE FROM target_events WHERE token_mint LIKE '%Toke%' OR token_mint LIKE '%TokenMint%'").run();
  const r4 = d.prepare("DELETE FROM positions WHERE token_mint LIKE '%Toke%' OR token_mint LIKE '%TokenMint%'").run();

  console.log(`Cleaned up test dummy records successfully!`);
  console.log(`Orders removed: ${r1.changes}`);
  console.log(`Intents removed: ${r2.changes}`);
  console.log(`Events removed: ${r3.changes}`);
  console.log(`Positions removed: ${r4.changes}`);
  process.exit(0);
}

cleanup();
