import { createEmptyProjection } from '../src/model/defaults';
import type { DomainOperation } from '../src/model/types';
import {
  validateCardExtension,
  validateDomainOperations,
  validateExtractionResponse,
  validateProjection,
  validateStoryPlan,
  validateTurnRecord
} from '../src/schema/validators';
import { operation, storyEvent, storyPlan, turnRecord } from './fixtures';
import groupStory from '../examples/group-isolation/story.json';
import linGroupCard from '../examples/group-isolation/林砚-知识隔离测试-v3.json';
import zhouGroupCard from '../examples/group-isolation/周栖-知识隔离测试-v3.json';

describe('machine-readable protocol schemas', () => {
  it('accepts canonical fixtures', () => {
    const projection = createEmptyProjection('story-1');
    const plan = storyPlan([]);
    const card = {
      schema_version: '1.0',
      story_id: 'story-1',
      entry_point: { chapter_id: 'chapter-1', scene_id: 'scene-1' },
      bindings: { character_id: 'hero' },
      inline_plan: plan
    };

    expect(validateProjection(projection).errors).toEqual([]);
    expect(validateStoryPlan(plan).errors).toEqual([]);
    expect(validateCardExtension(card).errors).toEqual([]);
    expect(validateTurnRecord(turnRecord()).errors).toEqual([]);
  });

  it('rejects arbitrary extraction operations and out-of-range confidence', () => {
    const response = {
      schemaVersion: 1,
      summary: 'bad response',
      confidence: 2,
      evidence: [],
      operations: [{ id: 'op', type: 'replace_everything', confidence: 1, evidenceIds: [] }],
      violations: []
    };
    const result = validateExtractionResponse(response);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('validates standalone operation edits with the domain schema', () => {
    expect(validateDomainOperations([{
      id: 'op-1',
      type: 'advance_time',
      minutes: 5,
      confidence: 0.9,
      evidenceIds: ['ev-1']
    }]).valid).toBe(true);
    expect(validateDomainOperations([{
      id: 'op-1',
      type: 'advance_time',
      minutes: 'five',
      confidence: 0.9,
      evidenceIds: ['ev-1']
    }]).valid).toBe(false);
    expect(validateDomainOperations([{
      id: 'op-axis',
      type: 'change_relationship_axis',
      pairId: 'hero_user',
      axis: 'affinity',
      delta: 2.5,
      confidence: 0.95,
      evidenceIds: ['ev-2']
    }]).valid).toBe(true);
    expect(validateDomainOperations([{
      id: 'op-divergence',
      type: 'set_divergence',
      structuralLevel: 0.5,
      summary: '主角提前摧毁了原作中的唯一通道。',
      confidence: 0.9,
      evidenceIds: ['ev-3']
    }]).valid).toBe(true);
  });

  it('allows local lock operations only inside manual turn records', () => {
    const lockOperation = {
      id: 'manual-lock',
      type: 'set_locked_paths' as const,
      paths: ['time.absolute'],
      confidence: 1,
      evidenceIds: []
    };
    const manual = turnRecord({ kind: 'manual', operations: [lockOperation] });

    expect(validateTurnRecord(manual).valid).toBe(true);
    expect(validateDomainOperations([lockOperation]).valid).toBe(false);
  });

  it('keeps the browser group-isolation fixtures schema-valid and independently bound', () => {
    const linExtension = linGroupCard.data.extensions.psyche_timeline;
    const zhouExtension = zhouGroupCard.data.extensions.psyche_timeline;

    expect(validateStoryPlan(groupStory).errors).toEqual([]);
    expect(validateCardExtension(linExtension).errors).toEqual([]);
    expect(validateCardExtension(zhouExtension).errors).toEqual([]);
    expect(linExtension.story_id).toBe(zhouExtension.story_id);
    expect(linExtension.bindings.character_id).toBe('lin_yan');
    expect(zhouExtension.bindings.character_id).toBe('zhou_qi');
    expect(groupStory.initialState.knowledge.lin_yan.zhou_private_signal.state).toBe('unaware');
    expect(groupStory.initialState.knowledge.zhou_qi.lin_private_key.state).toBe('unaware');
  });

  it('rejects canon-event transitions embedded recursively inside event effects', () => {
    const event = storyEvent({
      id: 'event-1',
      effects: [operation<DomainOperation>({
        id: 'recursive',
        type: 'transition_canon_event',
        eventId: 'event-1',
        status: 'active'
      })]
    });
    const invalidPlan = storyPlan([event]);

    expect(validateStoryPlan(invalidPlan).valid).toBe(false);
    expect(validateStoryPlan(invalidPlan).errors.join('\n')).toContain('transition_canon_event is not allowed');
  });
});
