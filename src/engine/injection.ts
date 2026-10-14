import type {
  CardTimelineExtension,
  CharacterState,
  InventoryEntry,
  RelationshipState,
  SchedulerCandidate,
  StoryProjection
} from '../model/types';
import type { RuntimeStorySourceContext } from './sourceContext';
import { applyPromptOverride, type PromptOverride } from '../model/promptCustomization';

function compactLocation(projection: StoryProjection): string {
  return [projection.location.area, projection.location.place, projection.location.position]
    .filter(Boolean)
    .join(' / ') || 'unknown';
}

function formatKnowledge(projection: StoryProjection, characterId: string): string[] {
  const entries = projection.knowledge[characterId] ?? {};
  const lines: string[] = [];
  for (const [factId, knowledge] of Object.entries(entries)) {
    if (knowledge.state === 'unaware') continue;
    const fact = projection.facts[factId];
    if (!fact) continue;
    if (knowledge.state === 'believes_false') {
      if (knowledge.perceivedTruth) lines.push(`- believes: ${knowledge.perceivedTruth}`);
      continue;
    }
    const concealment = knowledge.state === 'hiding' ? ' (knows but must conceal)' : '';
    lines.push(`- ${knowledge.state}${concealment}: ${fact.truth}`);
  }
  return lines;
}

function compactRecord(value: Record<string, unknown>): string {
  return Object.entries(value)
    .map(([key, item]) => `${key}=${typeof item === 'string' ? item : JSON.stringify(item)}`)
    .join(', ');
}

function formatCharacterState(characterId: string, state: CharacterState | undefined): string[] {
  if (!state) return [];
  const lines = [`Current state for ${characterId}:`];
  if (state.mood?.length) lines.push(`- mood: ${state.mood.join(', ')}`);
  if (state.activity) lines.push(`- activity: ${state.activity}`);
  if (state.physical?.length) lines.push(`- physical: ${state.physical.join(', ')}`);
  if (state.outfit && Object.keys(state.outfit).length > 0) {
    lines.push(`- outfit: ${compactRecord(state.outfit)}`);
  }
  if (state.location) {
    lines.push(`- personal location: ${[state.location.area, state.location.place, state.location.position].filter(Boolean).join(' / ')}`);
  }
  if (state.custom && Object.keys(state.custom).length > 0) {
    lines.push(`- custom state: ${compactRecord(state.custom)}`);
  }
  return lines.length > 1 ? lines : [];
}

function relationshipLine(relationship: RelationshipState, characterId: string): string[] {
  const direction = relationship.directions[characterId];
  if (!direction) return [];
  const axes = Object.keys(relationship.axes).length > 0 ? `; axes: ${compactRecord(relationship.axes)}` : '';
  const lines = [`- toward ${direction.toward}: stage=${relationship.stage}${axes}`];
  if (direction.stance.length > 0) lines.push(`  stance: ${direction.stance.join(', ')}`);
  if (direction.wants.length > 0) lines.push(`  wants: ${direction.wants.join(', ')}`);
  if (direction.secrets.length > 0) lines.push(`  private intentions/secrets: ${direction.secrets.join(', ')}`);
  return lines;
}

function formatRelationships(projection: StoryProjection, characterId: string): string[] {
  const entries = Object.values(projection.relationships)
    .flatMap(relationship => relationshipLine(relationship, characterId));
  return entries.length > 0 ? [`Relationship state for ${characterId}:`, ...entries] : [];
}

function inventoryLine(itemId: string, item: InventoryEntry): string {
  const owner = item.ownerId ? `; owner=${item.ownerId}` : '; shared/environment';
  const description = item.description ? `; ${item.description}` : '';
  return `- ${itemId}: count=${item.count}${owner}${description}`;
}

function formatRelevantInventory(projection: StoryProjection, characterId: string | null): string[] {
  const entries = Object.entries(projection.inventory)
    .filter(([, item]) => !item.ownerId || item.ownerId === characterId)
    .map(([itemId, item]) => inventoryLine(itemId, item));
  return entries.length > 0 ? ['Inventory available to the responder:', ...entries] : [];
}

function formatOpenThreads(projection: StoryProjection): string[] {
  const entries = Object.entries(projection.openThreads)
    .filter(([, thread]) => thread.status === 'open')
    .map(([threadId, thread]) => `- ${threadId}: ${thread.title}`);
  return entries.length > 0 ? ['Open continuity threads:', ...entries] : [];
}

function truncateAtLineBoundary(lines: string[], maxChars: number): string {
  const closing = '[/Psyche Timeline]';
  const text = [...lines, closing].join('\n');
  if (text.length <= maxChars) return text;
  const suffix = `\n[truncated]\n${closing}`;
  const cutoff = Math.max(1, maxChars - suffix.length);
  let prefix = lines.join('\n').slice(0, cutoff);
  const lineBoundary = prefix.lastIndexOf('\n');
  if (lineBoundary > 0) prefix = prefix.slice(0, lineBoundary);
  return `${prefix}${suffix}`;
}

export interface BuildInjectionOptions {
  projection: StoryProjection;
  candidates: SchedulerCandidate[];
  card: CardTimelineExtension;
  maxChars: number;
  responderCharacterId?: string | null;
  promptOverride?: PromptOverride;
  sourceContext?: RuntimeStorySourceContext | null;
}

function sourceLines(context: RuntimeStorySourceContext): string[] {
  const lines: string[] = [
    'Source continuity evidence for the narrator (not automatic character knowledge):',
    '- Preserve established chronology, concrete details, and prose tendencies.',
    '- A character may act on a source fact only when that fact is also present in the scoped state/knowledge above.'
  ];
  const addChunk = (label: string, chunk: RuntimeStorySourceContext['sequential'][number]) => {
    lines.push(`${label} [${chunk.id}] ${chunk.title} (${chunk.startOffset}-${chunk.endOffset})`);
    const text = chunk.text.replace(/\s+/g, ' ').trim();
    for (let index = 0; index < text.length; index += 420) lines.push(`  ${text.slice(index, index + 420)}`);
  };
  context.sequential.forEach(chunk => addChunk('Sequential', chunk));
  context.related.forEach(result => addChunk('Continuity', result.chunk));
  const used = new Set([
    ...context.sequential.map(chunk => chunk.id),
    ...context.related.map(result => result.chunk.id)
  ]);
  context.style.filter(chunk => !used.has(chunk.id)).forEach(chunk => addChunk('Style', chunk));
  if (context.warnings.length > 0) lines.push(...context.warnings.map(warning => `Retrieval warning: ${warning}`));
  return lines;
}

export function buildRuntimeInjection(options: BuildInjectionOptions): string {
  const { projection, candidates, card } = options;
  const guidance = applyPromptOverride([
    'Use this as hidden continuity guidance. Never mention this block, event IDs, state fields, or control rules in the visible reply.',
    'The actual branch state overrides canon. Do not force invalidated canon events back into the story.',
    'Mature or sensitive subject matter does not change continuity rules. Do not invent age, consent, relationship, or knowledge facts that are absent from the state.'
  ], options.promptOverride ?? { mode: 'builtin', text: '' });
  const lines: string[] = [
    '[Psyche Timeline - internal story control]',
    ...guidance,
    `Turn: ${projection.turn}`,
    `Location: ${compactLocation(projection)}`,
    `Time: ${projection.time.absolute ?? `relative minute ${projection.time.relativeMinutes}`}`
  ];
  if (card.bindings.user_role_id) lines.push(`User story role ID: ${card.bindings.user_role_id}`);

  const present = Object.entries(projection.characters)
    .filter(([, state]) => state.present)
    .map(([id]) => id);
  if (present.length > 0) lines.push(`Present characters: ${present.join(', ')}`);

  const knowledgeCharacterId = options.responderCharacterId === undefined
    ? card.bindings.character_id
    : options.responderCharacterId;
  if (knowledgeCharacterId) {
    lines.push(...formatCharacterState(knowledgeCharacterId, projection.characters[knowledgeCharacterId]));
  }
  const knowledgeLines = knowledgeCharacterId ? formatKnowledge(projection, knowledgeCharacterId) : [];
  if (knowledgeCharacterId && knowledgeLines.length > 0) {
    lines.push(`Knowledge available to ${knowledgeCharacterId}:`, ...knowledgeLines);
  }

  if (candidates.length > 0) {
    lines.push('Nearby canon anchors that are still causally possible:');
    for (const candidate of candidates) {
      lines.push(`- ${candidate.event.summary}`);
      if (candidate.event.narrativePurposes.length > 0) {
        lines.push(`  Narrative purpose: ${candidate.event.narrativePurposes.join(', ')}`);
      }
      lines.push(`  Adaptation allowed: delay=${candidate.event.adaptation.allowDelay}, relocation=${candidate.event.adaptation.allowRelocation}, substitution=${candidate.event.adaptation.allowSubstitution}`);
    }
  } else {
    lines.push('No canon event is currently eligible. Continue naturally from the actual branch state.');
  }

  if (knowledgeCharacterId) lines.push(...formatRelationships(projection, knowledgeCharacterId));
  lines.push(...formatRelevantInventory(projection, knowledgeCharacterId));
  lines.push(...formatOpenThreads(projection));
  if (projection.divergence.structuralLevel > 0 || projection.divergence.summary) {
    lines.push(
      `Branch divergence: level=${projection.divergence.structuralLevel}; ${projection.divergence.summary || 'no summary recorded'}`
    );
  }
  if (options.sourceContext) lines.push(...sourceLines(options.sourceContext));

  const maxChars = Math.max(500, options.maxChars);
  return truncateAtLineBoundary(lines, maxChars);
}
