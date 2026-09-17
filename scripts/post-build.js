import fs from 'fs';
import path from 'path';

const rootDir = process.cwd();
const srcDir = path.resolve(rootDir, 'dashboard/dist');
const distDir = path.resolve(rootDir, 'dist');
const publicDir = path.resolve(rootDir, 'public');

if (fs.existsSync(srcDir)) {
  try {
    fs.mkdirSync(distDir, { recursive: true });
    fs.cpSync(srcDir, distDir, { recursive: true });

    fs.mkdirSync(publicDir, { recursive: true });
    fs.cpSync(srcDir, publicDir, { recursive: true });

    console.log('[Post-Build] Successfully synced dashboard/dist to dist/ and public/ for cloud hosting.');
  } catch (err) {
    console.warn('[Post-Build Warning]: Could not copy to dist/public:', err.message);
  }
} else {
  console.warn('[Post-Build Warning]: dashboard/dist does not exist.');
}
