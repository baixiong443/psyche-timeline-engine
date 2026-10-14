import {
  compileAndAuditSourceWindow,
  mergeCompiledEventsIntoPlan,
  validateCachedSourceWindow,
  validateSourceWindowResponse,
} from '../src/ai/sourceCompiler';
import { createEmptyProjection } from '../src/model/defaults';
import type { StorySourceAnalysisUnit } from '../src/model/source';
import type { StoryEvent } from '../src/model/types';
import type { SillyTavernContext } from '../src/runtime/context';
import { DEFAULT_SETTINGS } from '../src/runtime/settings';
import type { ActiveStory } from '../src/runtime/story';
import { validateStoryPlan } from '../src/schema/validators';

function fixture() {
  const projection = createEmptyProjection('story-1');
  projection.canonCursor = { chapterId: 'chapter-1', sceneId: 'dock', eventOrder: 0 };
  const story: ActiveStory = {
    source: 'psychebook',
    card: {
      schema_version: '1.0', story_id: 'story-1', package_digest: `sha256:${'a'.repeat(64)}`,
      entry_point: { chapter_id: 'chapter-1', scene_id: 'dock' }, bindings: { character_id: 'hero' }
    },
    plan: { schemaVersion: 1, storyId: 'story-1', title: '雾港', initialState: projection, events: [] },
    packageStatus: 'verified',
    packageVersion: '1.0.0'
  };
  const unit: StorySourceAnalysisUnit = {
    schemaVersion: 1, id: 'A000002', chapterId: 'C0002', chapterOrder: 1, unitOrder: 1,
    title: '第二章 灯塔', startOffset: 100, endOffset: 200, text: '林砚抵达灯塔，但尚未打开顶层的门。',
    retrievalChunkIds: ['R000002', 'R000003']
  };
  const event: StoryEvent = {
    id: 'reach_lighthouse', chapterId: 'chapter-2', sceneId: 'lighthouse', canonicalOrder: 1,
    kind: 'soft_anchor', rigidity: 'soft', summary: '林砚抵达灯塔门外。', participants: [], effects: [],
    narrativePurposes: [], evidenceRefs: ['R000002'], revealPolicy: 'eligible_only',
    adaptation: { allowDelay: true, allowRelocation: true, allowSubstitution: false }
  };
  return { projection, story, unit, event };
}

describe('lazy source window compiler', () => {
  it('rejects evidence outside the active source unit', () => {
    const { projection, story, unit, event } = fixture();
    expect(() => validateSourceWindowResponse({
      schemaVersion: 1,
      sourceUnitId: unit.id,
      events: [{ ...event, evidenceRefs: ['R999999'] }]
    }, story, projection, unit)).toThrow('evidenceRefs 越界');
  });

  it('rejects participant names that are not registered character IDs', () => {
    const { projection, story, unit, event } = fixture();
    expect(() => validateSourceWindowResponse({
      schemaVersion: 1,
      sourceUnitId: unit.id,
      events: [{ ...event, participants: ['顾遥'] }]
    }, story, projection, unit)).toThrow('participants 包含未知角色：顾遥');
  });

  it('revalidates a cached event against the plan without conflicting with itself', () => {
    const { projection, story, unit, event } = fixture();
    story.plan.events = [event];
    story.plan.initialState.canonEvents[event.id] = 'locked';
    expect(validateCachedSourceWindow([event], story, projection, unit)).toEqual([event]);
  });

  it('runs compilation and independent audit before returning executable events', async () => {
    const { projection, story, unit, event } = fixture();
    const response = `<<<PTE_SOURCE_WINDOW_JSON>>>\n${JSON.stringify({ schemaVersion: 1, sourceUnitId: unit.id, events: [event] })}\n<<<END_PTE_SOURCE_WINDOW_JSON>>>`;
    const generateRaw = vi.fn().mockResolvedValue(response);
    const context = {
      generateRaw,
      eventTypes: {},
      eventSource: { on: vi.fn() }
    } as unknown as SillyTavernContext;
    const events = await compileAndAuditSourceWindow(context, story, projection, unit, DEFAULT_SETTINGS);
    expect(generateRaw).toHaveBeenCalledTimes(2);
    expect(generateRaw.mock.calls[0]?.[0]?.jsonSchema).toMatchObject({
      name: 'psyche_timeline_source_window',
      strict: true,
      returnInvalid: true
    });
    expect(generateRaw.mock.calls[0]?.[0]).toMatchObject({
      instructOverride: false,
      quietToLoud: false
    });
    expect(generateRaw.mock.calls[1]?.[0]?.jsonSchema).toMatchObject({
      name: 'psyche_timeline_source_window',
      strict: true,
      returnInvalid: true
    });
    expect(generateRaw.mock.calls[1]?.[0]).toMatchObject({
      instructOverride: false,
      quietToLoud: false
    });
    expect(events).toEqual([event]);
  });

  it('accepts bare structured JSON when the provider omits boundary markers', async () => {
    const { projection, story, unit, event } = fixture();
    const response = JSON.stringify({ schemaVersion: 1, sourceUnitId: unit.id, events: [event] });
    const generateRaw = vi.fn().mockResolvedValue(response);
    const context = {
      generateRaw,
      eventTypes: {},
      eventSource: { on: vi.fn() }
    } as unknown as SillyTavernContext;

    await expect(compileAndAuditSourceWindow(context, story, projection, unit, DEFAULT_SETTINGS))
      .resolves.toEqual([event]);
    expect(generateRaw).toHaveBeenCalledTimes(2);
  });

  it('rebuilds compiler-owned envelope metadata around valid events', () => {
    const { projection, story, unit, event } = fixture();
    expect(validateSourceWindowResponse({
      schemaVersion: 99,
      sourceUnitId: 'model-invented-unit',
      events: [event]
    }, story, projection, unit)).toEqual({
      schemaVersion: 1,
      sourceUnitId: unit.id,
      events: [event]
    });
  });

  it('accepts a bare event array and rebuilds the compiler-owned envelope', () => {
    const { projection, story, unit, event } = fixture();
    expect(validateSourceWindowResponse([event], story, projection, unit)).toEqual({
      schemaVersion: 1,
      sourceUnitId: unit.id,
      events: [event]
    });
  });

  it('normalizes a singular compiled event nested under a common output wrapper', () => {
    const { projection, story, unit, event } = fixture();
    expect(validateSourceWindowResponse({
      output: { compiled_event: event }
    }, story, projection, unit)).toEqual({
      schemaVersion: 1,
      sourceUnitId: unit.id,
      events: [event]
    });
  });

  it('normalizes common snake-case fields and args-wrapped effects before validation', () => {
    const { projection, story, unit, event } = fixture();
    const result = validateSourceWindowResponse({
      schema_version: 1,
      source_unit_id: unit.id,
      events: [{
        event_id: event.id,
        chapter_id: event.chapterId,
        scene_id: event.sceneId,
        canonical_order: event.canonicalOrder,
        event_kind: event.kind,
        rigidity: event.rigidity,
        summary: event.summary,
        participant_ids: [],
        effects: [{
          operation_id: 'mark-arrival',
          operation_type: 'set_flag',
          confidence: 0.95,
          evidence_ids: ['R000002'],
          args: { flag: 'arrived', value: true }
        }],
        narrative_purposes: [],
        evidence_refs: ['R000002'],
        reveal_policy: 'eligible_only',
        adaptation_policy: {
          allow_delay: true,
          allow_relocation: true,
          allow_substitution: false
        }
      }]
    }, story, projection, unit);

    expect(result.events[0]).toMatchObject({
      id: event.id,
      chapterId: event.chapterId,
      sceneId: event.sceneId,
      effects: [{
        id: 'mark-arrival',
        type: 'set_flag',
        confidence: 0.95,
        evidenceIds: ['R000002'],
        flag: 'arrived',
        value: true
      }],
      adaptation: { allowDelay: true, allowRelocation: true, allowSubstitution: false }
    });
  });

  it('merges cached events into the immutable package plan with locked initial state', () => {
    const { story, event } = fixture();
    const merged = mergeCompiledEventsIntoPlan(story.plan, [event]);
    expect(merged.initialState.canonEvents[event.id]).toBe('locked');
    expect(merged.events.map(item => item.id)).toEqual([event.id]);
    expect(validateStoryPlan(merged).valid).toBe(true);
    expect(story.plan.events).toEqual([]);
  });

  it('rejects conflicting cached IDs instead of silently replacing package events', () => {
    const { story, event } = fixture();
    story.plan.events = [event];
    story.plan.initialState.canonEvents[event.id] = 'locked';

    expect(() => mergeCompiledEventsIntoPlan(story.plan, [{
      ...event,
      summary: '与故事包中同 ID 事件不一致。'
    }])).toThrow('事件 ID 与故事计划冲突');
  });

  it('rejects duplicate canonical orders across cached windows', () => {
    const { story, event } = fixture();
    expect(() => mergeCompiledEventsIntoPlan(story.plan, [
      event,
      { ...event, id: 'open_lighthouse', canonicalOrder: event.canonicalOrder }
    ])).toThrow('事件顺序冲突');
  });
});
