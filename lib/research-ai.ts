export type ResearchAiState =
  | { kind: 'unavailable' }
  | { kind: 'loading' }
  | { kind: 'ready'; brief: string }
  | { kind: 'failed'; reason: string };

export const initialResearchAiState = (hasConfig: boolean): ResearchAiState => hasConfig ? { kind: 'loading' } : { kind: 'unavailable' };
