import { strFromU8, unzipSync } from 'fflate';
import { deleteDB, openDB, type DBSchema } from 'idb';
import { PACKAGE_DB_NAME, PACKAGE_DB_VERSION } from '../constants';
import type { InstalledPsycheBook, PsycheBookManifest } from '../model/package';
import {
  validateStoryEvidenceClaim,
  validateStorySourceAnalysisUnit,
  validateStorySourceChunk,
  validateStorySourceCompilationRecord,
  validateStorySourceEmbedding,
  validateStorySourceIndex,
  type StoryEvidenceClaim,
  type StorySourceAnalysisUnit,
  type StorySourceCompilationRecord,
  type StorySourceCorpus,
  type StorySourceEmbeddingRecord,
  type StorySourceRetrievalChunk
} from '../model/source';
import type { CardTimelineExtension, StoryEvent, StoryPlan } from '../model/types';
import { validateCardExtension, validateStoryPlan } from '../schema/validators';
import { sha256Bytes } from '../utils/hash';
import { installStorySource } from './sourceDb';

const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_ENTRY_COUNT = 20_000;
const FORBIDDEN_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'html', 'htm', 'wasm', 'exe', 'dll', 'bat', 'cmd', 'ps1']);

interface PackageDatabase extends DBSchema {
  packages: {
    key: string;
    value: InstalledPsycheBook;
    indexes: { 'by-story': string };
  };
}

let packageDatabasePromise: ReturnType<typeof openDB<PackageDatabase>> | null = null;

function packageDb() {
  packageDatabasePromise ??= openDB<PackageDatabase>(PACKAGE_DB_NAME, PACKAGE_DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('packages')) {
        const store = db.createObjectStore('packages', { keyPath: 'digest' });
        store.createIndex('by-story', 'manifest.story_id');
      }
    }
  });
  return packageDatabasePromise;
}

function safeEntryPath(path: string): boolean {
  if (!path || path.length > 500 || path.includes('\\') || path.startsWith('/') || /^[a-z]:/i.test(path)) return false;
  const segments = path.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return false;
  const extension = segments.at(-1)?.split('.').at(-1)?.toLowerCase() ?? '';
  return !FORBIDDEN_EXTENSIONS.has(extension);
}

function parseJson<T>(text: string, fileName: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`${fileName} 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateManifest(value: unknown): PsycheBookManifest {
  if (!value || typeof value !== 'object') throw new Error('manifest.json 必须是对象。');
  const manifest = value as Partial<PsycheBookManifest>;
  if (manifest.schema_version !== '1.0' || manifest.format !== 'psychebook') {
    throw new Error('故事包格式或 schema_version 不受支持。');
  }
  if (!manifest.story_id || !manifest.title || !manifest.version) {
    throw new Error('manifest.json 缺少 story_id、title 或 version。');
  }
  if (manifest.source) {
    const source = manifest.source;
    if (source.schema_version !== 1
      || source.index !== 'source/index.json'
      || source.chunks !== 'source/chunks.jsonl') {
      throw new Error('manifest.json 的 source 描述符无效。');
    }
    const optionalPaths = {
      analysis: 'source/analysis.jsonl',
      embeddings: 'source/embeddings.jsonl',
      claims: 'source/claims.jsonl',
      compilation: 'source/compilation.jsonl'
    } as const;
    for (const [field, expected] of Object.entries(optionalPaths)) {
      const actual = source[field as keyof typeof optionalPaths];
      if (actual !== undefined && actual !== expected) throw new Error(`manifest.json 的 source.${field} 路径无效。`);
    }
  }
  return manifest as PsycheBookManifest;
}

function parseJsonLines<T>(text: string, fileName: string): T[] {
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map((line, index) => (
    parseJson<T>(line, `${fileName}:${index + 1}`)
  ));
}

function createCard(manifest: PsycheBookManifest, plan: StoryPlan): CardTimelineExtension {
  const characterId = manifest.bindings?.character_id
    ?? Object.keys(plan.initialState.characters)[0]
    ?? 'character';
  return {
    schema_version: '1.0',
    story_id: manifest.story_id,
    entry_point: manifest.entry_point ?? {
      chapter_id: plan.initialState.canonCursor.chapterId || 'start',
      scene_id: plan.initialState.canonCursor.sceneId || 'start'
    },
    bindings: {
      character_id: characterId,
      user_role_id: manifest.bindings?.user_role_id
    }
  };
}

function validatedJsonLines<T>(
  files: Record<string, string>,
  fileName: string | undefined,
  label: string,
  validate: (value: unknown) => { valid: boolean; errors: string[]; value?: T }
): T[] {
  if (!fileName) return [];
  const text = files[fileName];
  if (text === undefined) throw new Error(`故事包缺少 source 描述符引用的 ${fileName}。`);
  return parseJsonLines<unknown>(text, fileName).map((item, index) => {
    const result = validate(item);
    if (!result.valid || !result.value) {
      throw new Error(`${label} ${fileName}:${index + 1} 无效：${result.errors.join('; ')}`);
    }
    return result.value;
  });
}

function assertUnique<T>(values: T[], key: (value: T) => string | number, label: string): void {
  const seen = new Set<string | number>();
  for (const value of values) {
    const id = key(value);
    if (seen.has(id)) throw new Error(`${label} 包含重复值：${id}`);
    seen.add(id);
  }
}

function parseProgressiveSource(files: Record<string, string>, manifest: PsycheBookManifest): StorySourceCorpus | undefined {
  const descriptor = manifest.source;
  if (!descriptor) return undefined;
  const indexText = files[descriptor.index];
  if (indexText === undefined) throw new Error(`故事包缺少 source 描述符引用的 ${descriptor.index}。`);
  const indexResult = validateStorySourceIndex(parseJson(indexText, descriptor.index));
  if (!indexResult.valid || !indexResult.value) {
    throw new Error(`${descriptor.index} 无效：${indexResult.errors.join('; ')}`);
  }
  const index = indexResult.value;
  if (index.storyId !== manifest.story_id) throw new Error('source/index.json 与 manifest.json 的 story_id 不一致。');

  const retrievalChunks = validatedJsonLines<StorySourceRetrievalChunk>(
    files, descriptor.chunks, '检索片段', validateStorySourceChunk
  ).sort((left, right) => left.chunkOrder - right.chunkOrder);
  if (retrievalChunks.length !== index.retrievalChunkCount) {
    throw new Error(`source/chunks.jsonl 数量 ${retrievalChunks.length} 与索引声明 ${index.retrievalChunkCount} 不一致。`);
  }
  assertUnique(retrievalChunks, item => item.id, '检索片段 ID');
  assertUnique(retrievalChunks, item => item.chunkOrder, '检索片段顺序');
  const chunkIds = new Set(retrievalChunks.map(item => item.id));

  const analysisUnits = validatedJsonLines<StorySourceAnalysisUnit>(
    files, descriptor.analysis, '分析单元', validateStorySourceAnalysisUnit
  ).sort((left, right) => left.unitOrder - right.unitOrder);
  if (descriptor.analysis && analysisUnits.length !== index.analysisUnitCount) {
    throw new Error(`source/analysis.jsonl 数量 ${analysisUnits.length} 与索引声明 ${index.analysisUnitCount} 不一致。`);
  }
  assertUnique(analysisUnits, item => item.id, '分析单元 ID');
  assertUnique(analysisUnits, item => item.unitOrder, '分析单元顺序');
  for (const unit of analysisUnits) {
    if (unit.retrievalChunkIds.some(id => !chunkIds.has(id))) {
      throw new Error(`分析单元 ${unit.id} 引用了未知检索片段。`);
    }
  }

  let embeddings: StorySourceEmbeddingRecord[] = [];
  if (descriptor.embeddings) {
    if (!index.embedding) throw new Error('source/embeddings.jsonl 存在，但 source/index.json 没有 embedding 配置。');
    embeddings = validatedJsonLines<StorySourceEmbeddingRecord>(
      files,
      descriptor.embeddings,
      '嵌入记录',
      value => validateStorySourceEmbedding(value, index.embedding!, chunkIds)
    );
    assertUnique(embeddings, item => item.chunkId, '嵌入片段 ID');
  }

  const claims = validatedJsonLines<StoryEvidenceClaim>(
    files, descriptor.claims, '证据声明', validateStoryEvidenceClaim
  );
  assertUnique(claims, item => item.id, '证据声明 ID');
  for (const claim of claims) {
    if (claim.sourceChunkIds.some(id => !chunkIds.has(id))) throw new Error(`证据声明 ${claim.id} 引用了未知检索片段。`);
  }

  const compilation = validatedJsonLines<StorySourceCompilationRecord>(
    files, descriptor.compilation, '编译记录', validateStorySourceCompilationRecord
  );
  assertUnique(compilation, item => item.sourceUnitId, '编译记录 sourceUnitId');
  const analysisIds = new Set(analysisUnits.map(item => item.id));
  for (const record of compilation) {
    if (!analysisIds.has(record.sourceUnitId)) throw new Error(`编译记录引用了未知分析单元：${record.sourceUnitId}`);
  }

  return { index, retrievalChunks, analysisUnits, embeddings, claims, compilation };
}

function assemblePackage(files: Record<string, string>, digest: string): InstalledPsycheBook {
  const manifestText = files['manifest.json'];
  const storyText = files['story.json'];
  if (!manifestText || !storyText) throw new Error('故事包必须包含 manifest.json 和 story.json。');
  const manifest = validateManifest(parseJson(manifestText, 'manifest.json'));
  const storyValue = parseJson<Record<string, unknown>>(storyText, 'story.json');

  if (!Array.isArray(storyValue.events) && files['events.jsonl']) {
    storyValue.events = parseJsonLines<StoryEvent>(files['events.jsonl'], 'events.jsonl');
  }
  const planResult = validateStoryPlan(storyValue);
  if (!planResult.valid || !planResult.value) {
    throw new Error(`story.json 不符合 StoryPlan 协议：${planResult.errors.join('; ')}`);
  }
  if (planResult.value.storyId !== manifest.story_id) {
    throw new Error('manifest.json 与 story.json 的 story_id 不一致。');
  }

  let card = createCard(manifest, planResult.value);
  if (files['card.json']) {
    const cardResult = validateCardExtension(parseJson(files['card.json'], 'card.json'));
    if (!cardResult.valid || !cardResult.value) {
      throw new Error(`card.json 不符合角色卡扩展协议：${cardResult.errors.join('; ')}`);
    }
    card = cardResult.value;
  }
  if (card.story_id !== manifest.story_id) throw new Error('card.json 绑定了不同的 story_id。');
  card.package_digest = digest;
  delete card.inline_plan;
  const source = parseProgressiveSource(files, manifest);

  return {
    digest,
    installedAt: Date.now(),
    manifest,
    card,
    plan: planResult.value,
    source,
    files
  };
}

export async function parsePsycheBookBytes(bytes: Uint8Array): Promise<InstalledPsycheBook> {
  if (bytes.byteLength > MAX_COMPRESSED_BYTES) throw new Error('故事包超过 64 MiB 压缩大小上限。');
  const digest = await sha256Bytes(bytes);
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (error) {
    throw new Error(`无法解压 .psychebook：${error instanceof Error ? error.message : String(error)}`);
  }
  const names = Object.keys(entries);
  if (names.length === 0 || names.length > MAX_ENTRY_COUNT) throw new Error('故事包文件数量无效。');

  let totalSize = 0;
  const files: Record<string, string> = {};
  for (const [name, data] of Object.entries(entries)) {
    if (!safeEntryPath(name)) throw new Error(`故事包包含不安全路径或文件类型：${name}`);
    totalSize += data.byteLength;
    if (totalSize > MAX_UNCOMPRESSED_BYTES) throw new Error('故事包解压后超过 256 MiB 上限。');
    files[name] = strFromU8(data);
  }
  return assemblePackage(files, digest);
}

export async function parseStoryFile(file: File): Promise<InstalledPsycheBook> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (file.name.toLowerCase().endsWith('.json')) {
    const digest = await sha256Bytes(bytes);
    const value = parseJson<Record<string, unknown>>(strFromU8(bytes), file.name);
    const directPlan = validateStoryPlan(value);
    let plan: StoryPlan;
    let manifest: PsycheBookManifest;
    let card: CardTimelineExtension | undefined;
    if (directPlan.valid && directPlan.value) {
      plan = directPlan.value;
      manifest = {
        schema_version: '1.0',
        format: 'psychebook',
        story_id: plan.storyId,
        title: plan.title,
        version: '1.0.0'
      };
    } else {
      manifest = validateManifest(value.manifest);
      const planResult = validateStoryPlan(value.story);
      if (!planResult.valid || !planResult.value) throw new Error(`JSON 中的 story 无效：${planResult.errors.join('; ')}`);
      plan = planResult.value;
      const cardResult = value.card ? validateCardExtension(value.card) : null;
      if (value.card && (!cardResult?.valid || !cardResult.value)) throw new Error(`JSON 中的 card 无效：${cardResult?.errors.join('; ')}`);
      card = cardResult?.value;
    }
    card ??= createCard(manifest, plan);
    card.package_digest = digest;
    delete card.inline_plan;
    return { digest, installedAt: Date.now(), manifest, card, plan, files: { 'story.json': JSON.stringify(plan) } };
  }
  return parsePsycheBookBytes(bytes);
}

export async function installPsycheBook(book: InstalledPsycheBook): Promise<void> {
  if (book.source) await installStorySource(book.digest, book.source);
  const db = await packageDb();
  const files = Object.fromEntries(Object.entries(book.files).filter(([name]) => !name.startsWith('source/')));
  await db.put('packages', { ...book, source: undefined, files });
}

export async function getInstalledPsycheBook(digest: string): Promise<InstalledPsycheBook | undefined> {
  const db = await packageDb();
  return db.get('packages', digest);
}

export async function resetPackageDatabaseForTests(): Promise<void> {
  const db = await packageDatabasePromise;
  db?.close();
  packageDatabasePromise = null;
  await deleteDB(PACKAGE_DB_NAME);
}
