import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import cardExtensionSchema from '../../schemas/card-extension.schema.json';
import commonSchema from '../../schemas/common.schema.json';
import extractionResponseSchema from '../../schemas/extraction-response.schema.json';
import projectionSchema from '../../schemas/projection.schema.json';
import storyPlanSchema from '../../schemas/story-plan.schema.json';
import turnRecordSchema from '../../schemas/turn-record.schema.json';
import type {
  CardTimelineExtension,
  DomainOperation,
  ExtractionResponse,
  StoryPlan,
  StoryProjection,
  TurnRecord
} from '../model/types';

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictTypes: false,
  allowUnionTypes: true
});
addFormats(ajv);
ajv.addSchema(commonSchema);

const validators = {
  cardExtension: ajv.compile<CardTimelineExtension>(cardExtensionSchema),
  domainOperations: ajv.compile<DomainOperation[]>({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'array',
    items: { $ref: 'https://psyche-timeline.local/schemas/common.schema.json#/$defs/domainOperation' }
  }),
  extractionResponse: ajv.compile<ExtractionResponse>(extractionResponseSchema),
  projection: ajv.compile<StoryProjection>(projectionSchema),
  storyPlan: ajv.compile<StoryPlan>(storyPlanSchema),
  turnRecord: ajv.compile<TurnRecord>(turnRecordSchema)
};

export interface ValidationResult<T> {
  valid: boolean;
  value?: T;
  errors: string[];
}

function formatError(error: ErrorObject): string {
  const path = error.instancePath || '/';
  return `${path} ${error.message ?? error.keyword}`;
}

function validate<T>(validator: ValidateFunction<T>, value: unknown): ValidationResult<T> {
  if (validator(value)) return { valid: true, value, errors: [] };
  return {
    valid: false,
    errors: (validator.errors ?? []).map(formatError)
  };
}

export const validateCardExtension = (value: unknown): ValidationResult<CardTimelineExtension> => (
  validate(validators.cardExtension, value)
);

export const validateDomainOperations = (value: unknown): ValidationResult<DomainOperation[]> => (
  validate(validators.domainOperations, value)
);

export const validateExtractionResponse = (value: unknown): ValidationResult<ExtractionResponse> => (
  validate(validators.extractionResponse, value)
);

export const validateProjection = (value: unknown): ValidationResult<StoryProjection> => (
  validate(validators.projection, value)
);

export const validateStoryPlan = (value: unknown): ValidationResult<StoryPlan> => {
  const result = validate(validators.storyPlan, value);
  if (!result.valid || !result.value) return result;
  const forbiddenEffects = result.value.events.flatMap((event, eventIndex) => (
    event.effects
      .map((effect, effectIndex) => ({ effect, eventIndex, effectIndex }))
      .filter(({ effect }) => effect.type === 'transition_canon_event')
      .map(({ eventIndex: index, effectIndex }) => (
        `/events/${index}/effects/${effectIndex} transition_canon_event is not allowed inside StoryEvent.effects`
      ))
  ));
  return forbiddenEffects.length > 0
    ? { valid: false, errors: forbiddenEffects }
    : result;
};

export const validateTurnRecord = (value: unknown): ValidationResult<TurnRecord> => (
  validate(validators.turnRecord, value)
);
