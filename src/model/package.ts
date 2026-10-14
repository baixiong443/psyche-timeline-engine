import type { StorySourceCorpus } from './source';
import type { CardTimelineExtension, StoryPlan } from './types';

export interface PsycheBookSourceDescriptor {
  schema_version: 1;
  index: 'source/index.json';
  chunks: 'source/chunks.jsonl';
  analysis?: 'source/analysis.jsonl';
  embeddings?: 'source/embeddings.jsonl';
  claims?: 'source/claims.jsonl';
  compilation?: 'source/compilation.jsonl';
}

export interface PsycheBookManifest {
  schema_version: '1.0';
  format: 'psychebook';
  story_id: string;
  title: string;
  version: string;
  entry_point?: {
    chapter_id: string;
    scene_id: string;
    event_id?: string;
  };
  bindings?: {
    character_id: string;
    user_role_id?: string;
  };
  source?: PsycheBookSourceDescriptor;
}

export interface InstalledPsycheBook {
  digest: string;
  installedAt: number;
  manifest: PsycheBookManifest;
  card: CardTimelineExtension;
  plan: StoryPlan;
  source?: StorySourceCorpus;
  files: Record<string, string>;
}
