import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const srcClientDir = path.join(rootDir, 'src', 'client');
const distClientDir = path.join(rootDir, 'dist', 'client');

if (!fs.existsSync(distClientDir)) {
  fs.mkdirSync(distClientDir, { recursive: true });
}

// Copy index.html and any other client files
if (fs.existsSync(srcClientDir)) {
  const files = fs.readdirSync(srcClientDir);
  for (const file of files) {
    const srcFile = path.join(srcClientDir, file);
    const destFile = path.join(distClientDir, file);
    if (fs.statSync(srcFile).isFile()) {
      fs.copyFileSync(srcFile, destFile);
      console.log(`Copied ${file} -> dist/client/${file}`);
    }
  }
}

console.log('Client assets bundled successfully.');
