// Fails the build while any page still contains an unfilled legal placeholder,
// so a privacy policy or terms page with "[TODO-LEGAL: ...]" can never be deployed.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const pages = (await readdir(root)).filter((name) => name.endsWith('.html'));
const found = [];

for (const page of pages) {
  const lines = (await readFile(join(root, page), 'utf8')).split('\n');
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/\[TODO-LEGAL:[^\]]*\]/g)) {
      found.push(`${page}:${index + 1}  ${match[0]}`);
    }
  });
}

if (found.length > 0) {
  console.error(`Unfilled legal placeholders (${found.length}). Replace each with the real business detail before deploying:\n`);
  console.error(found.join('\n'));
  process.exit(1);
}

console.log(`No legal placeholders left in ${pages.length} pages.`);
