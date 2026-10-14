export const EXTENSION_KEY = 'psyche_timeline';
export const MESSAGE_FIELD = 'psyche_timeline';
export const CARD_EXTENSION_KEY = 'psyche_timeline';
export const PROMPT_KEY = 'psyche_timeline_state';
export const PACKAGE_DB_NAME = 'psyche-timeline-engine';
export const PACKAGE_DB_VERSION = 1;
export const SOURCE_DB_NAME = 'psyche-timeline-source';
export const SOURCE_DB_VERSION = 2;
export const DEFAULT_INJECTION_TOKEN_BUDGET = 1200;
export const DEFAULT_MAX_CANDIDATE_EVENTS = 3;
/**
 * How far ahead of the canon cursor an event may be and still be offered as an
 * injection candidate, measured in `canonicalOrder` units.
 *
 * Injection is meant to hint at what is imminent, not to narrate the far
 * future. Ranking alone cannot express this: a `follow`-mode hard anchor earns
 * 90 base points while the whole proximity term spans 80, so a distant anchor
 * outranks the next beat no matter how the weights are tuned. This window is
 * therefore a hard eligibility gate, not a preference.
 *
 * Events beyond the window stay in the plan and become candidates as the
 * cursor advances. `scope: 'world'` is exempt from divergence but NOT from
 * this window: a calamity 200 orders away is still a spoiler.
 */
export const DEFAULT_CANON_LOOKAHEAD = 25;
export const CHECKPOINT_INTERVAL = 25;
export const SOURCE_COMPILATION_MAX_ATTEMPTS = 3;
export const SOURCE_COMPILATION_STALE_MS = 10 * 60 * 1000;
