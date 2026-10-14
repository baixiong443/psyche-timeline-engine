import {
  applyPromptOverride,
  DEFAULT_PROMPT_OVERRIDES,
  MATURE_CONTENT_ANALYSIS_RULES,
  normalizePromptOverrides
} from '../src/model/promptCustomization';

describe('prompt customization', () => {
  it('normalizes incomplete persisted settings and limits custom prompt size', () => {
    const normalized = normalizePromptOverrides({
      extraction: { mode: 'append', text: 'x'.repeat(25_000) },
      audit: { mode: 'unsupported', text: 'ignored mode' }
    });

    expect(normalized.extraction.mode).toBe('append');
    expect(normalized.extraction.text).toHaveLength(20_000);
    expect(normalized.audit.mode).toBe('builtin');
    expect(normalized.injection).toEqual(DEFAULT_PROMPT_OVERRIDES.injection);
  });

  it('supports built-in, appended and replaced control instructions', () => {
    const defaults = ['default one', ...MATURE_CONTENT_ANALYSIS_RULES];
    expect(applyPromptOverride(defaults, { mode: 'builtin', text: 'unused' })).toEqual(defaults);
    expect(applyPromptOverride(defaults, { mode: 'append', text: 'custom' })).toEqual([
      ...defaults,
      '[使用者追加控制指令]',
      'custom'
    ]);
    expect(applyPromptOverride(defaults, { mode: 'replace', text: 'custom only' })).toEqual([
      '[使用者自定义控制指令]',
      'custom only'
    ]);
  });
});
