const id = { type: 'string', minLength: 1, maxLength: 160 } as const;
const stringArray = { type: 'array', items: { type: 'string' }, maxItems: 40 } as const;
const evidence = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'source', 'quote', 'claim'],
  properties: {
    id,
    source: { enum: ['user', 'assistant', 'canon'] },
    quote: { type: 'string', maxLength: 1000 },
    claim: { type: 'string', maxLength: 1000 }
  }
} as const;
const violation = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'severity', 'message', 'evidenceIds'],
  properties: {
    code: id,
    severity: { enum: ['info', 'warning', 'error'] },
    message: { type: 'string', maxLength: 1000 },
    evidenceIds: stringArray
  }
} as const;

export const EXTRACTION_GENERATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'summary', 'confidence', 'evidence', 'operations', 'violations'],
  properties: {
    schemaVersion: { const: 1 },
    summary: { type: 'string', maxLength: 1200 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    evidence: { type: 'array', items: evidence, maxItems: 30 },
    operations: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'type', 'confidence', 'evidenceIds', 'args'],
        properties: {
          id,
          type: {
            enum: [
              'advance_time', 'set_time', 'move_location', 'set_character_presence',
              'set_character_state', 'add_fact', 'set_knowledge', 'set_relationship_stage',
              'set_relationship_attitude', 'change_relationship_axis', 'change_inventory', 'set_divergence', 'set_flag', 'open_thread',
              'resolve_thread', 'transition_canon_event', 'set_narrative_purpose'
            ]
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          evidenceIds: stringArray,
          args: {
            type: 'object',
            additionalProperties: true
          }
        }
      }
    },
    violations: { type: 'array', items: violation, maxItems: 20 }
  }
} as const;

export const STRICT_AUDIT_GENERATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'acceptedOperationIds', 'rejectedOperationIds', 'violations'],
  properties: {
    status: { enum: ['passed', 'warning', 'failed'] },
    acceptedOperationIds: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 160 }
    },
    rejectedOperationIds: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 160 }
    },
    violations: {
      type: 'array',
      items: violation
    }
  }
} as const;
