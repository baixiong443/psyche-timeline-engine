import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'examples', 'rain-ferry');
const output = resolve(root, 'examples', '潮痕驿站-demo.psychebook');
const names = ['manifest.json', 'story.json', 'card.json'];
const files = {};

for (const name of names) {
  files[name] = strToU8(await readFile(resolve(source, name), 'utf8'));
}

await writeFile(output, zipSync(files, { level: 9 }));
console.log(output);
