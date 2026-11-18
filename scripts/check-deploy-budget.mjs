import fs from 'node:fs';
import path from 'node:path';

// Sites validates both the uploaded archive and its expanded contents.
// Leave room for the generated hosting manifest and tar metadata.
const limit = 252 * 1024 * 1024;
let bytes = 0;
let files = 0;
for (const directory of ['dist', 'drizzle']) {
  if (!fs.existsSync(directory)) throw new Error(`Build output is missing: ${directory}`);
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const name = path.join(current, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) { bytes += fs.statSync(name).size; files++; }
    }
  };
  visit(directory);
}
console.log(JSON.stringify({ files, expandedMiB: Number((bytes / 1024 / 1024).toFixed(2)), budgetMiB: 252 }));
if (bytes > limit) throw new Error('Expanded deployment exceeds the 252 MiB local budget. Run scripts/prepare-media-delivery.py and inspect the media budget before publishing.');
