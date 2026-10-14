export type PtePromptTarget = 'injection' | 'extraction' | 'audit';
export type PromptCustomizationMode = 'builtin' | 'append' | 'replace';

export interface PromptOverride {
  mode: PromptCustomizationMode;
  text: string;
}

export type PtePromptOverrides = Record<PtePromptTarget, PromptOverride>;

export const DEFAULT_PROMPT_OVERRIDES: PtePromptOverrides = {
  injection: { mode: 'builtin', text: '' },
  extraction: { mode: 'builtin', text: '' },
  audit: { mode: 'builtin', text: '' }
};

export const PTE_PROMPT_TEMPLATES: Record<PtePromptTarget, string> = {
  injection: [
    '继续遵守当前真实分支状态与角色知识边界。',
    '在仍然因果可达时自然靠近原作锚点，不要为了回到原作而覆盖已经发生的变化。',
    '在这里补充希望主叙事模型长期遵循的规则。'
  ].join('\n'),
  extraction: [
    '只记录本轮文本明确证明已经发生的状态变化。',
    '在这里补充项目专用的状态字段、术语解释或证据要求。'
  ].join('\n'),
  audit: [
    '逐项复核操作证据，不因候选结果写得流畅而放宽标准。',
    '在这里补充项目专用的审计重点或必须拒绝的问题。'
  ].join('\n')
};

export const MATURE_CONTENT_ANALYSIS_RULES = [
  '输入可能包含成熟题材、成人关系、暴力、身体或亲密场景；当前任务是状态提取或证据审计，不是续写、强化或评价这些内容。',
  '不要仅因题材存在而省略影响时间、地点、人物、关系、物品、知识边界或原作事件状态的事实；能用中立状态描述时，不重复不必要的敏感细节。',
  '年龄、成年状态、合意状态与关系性质只能按本轮文本和既有状态记录；没有证据时保持未知，不得自行补全。',
  '单个字段无法处理时只忽略该字段并报告 violation，不得把其他可验证变化一并伪装成没有发生。'
];

export function normalizePromptOverrides(value: unknown): PtePromptOverrides {
  const source = value && typeof value === 'object' ? value as Partial<PtePromptOverrides> : {};
  const result = structuredClone(DEFAULT_PROMPT_OVERRIDES);
  for (const target of ['injection', 'extraction', 'audit'] as const) {
    const candidate = source[target];
    if (!candidate || typeof candidate !== 'object') continue;
    const mode = ['builtin', 'append', 'replace'].includes(String(candidate.mode))
      ? candidate.mode as PromptCustomizationMode
      : 'builtin';
    result[target] = {
      mode,
      text: typeof candidate.text === 'string' ? candidate.text.slice(0, 20_000) : ''
    };
  }
  return result;
}

export function applyPromptOverride(defaultInstructions: string[], override: PromptOverride): string[] {
  const custom = override.text.trim();
  if (override.mode === 'replace' && custom) {
    return ['[使用者自定义控制指令]', custom];
  }
  if (override.mode === 'append' && custom) {
    return [...defaultInstructions, '[使用者追加控制指令]', custom];
  }
  return defaultInstructions;
}
