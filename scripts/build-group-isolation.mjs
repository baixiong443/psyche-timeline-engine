import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'examples', 'group-isolation');
const output = resolve(source, '双角色知识隔离验收.psychebook');
const files = {};

for (const name of ['manifest.json', 'story.json', 'card.json']) {
  files[name] = strToU8(await readFile(resolve(source, name), 'utf8'));
}

const archive = zipSync(files, { level: 9, mtime: new Date('1980-01-01T00:00:00Z') });
await writeFile(output, archive);

const digest = `sha256:${createHash('sha256').update(archive).digest('hex')}`;
for (const name of ['林砚-知识隔离测试-v3.json', '周栖-知识隔离测试-v3.json']) {
  const path = resolve(source, name);
  const card = JSON.parse(await readFile(path, 'utf8'));
  card.data.extensions.psyche_timeline.package_digest = digest;
  await writeFile(path, `${JSON.stringify(card, null, 2)}\n`, 'utf8');
}

console.log(`${output}\n${digest}`);
