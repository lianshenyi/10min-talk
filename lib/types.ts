export type Phase = 'draw' | 'research' | 'prepare' | 'speak' | 'transcript' | 'completed';

export type TermKind =
  | '定律'
  | '效应'
  | '悖论'
  | '理论'
  | '模型'
  | '原则'
  | '方法';

export interface TermCard {
  id: string;
  title: string;
  english?: string;
  domain: string;
  kind: TermKind;
  prompt: string;
  sources: { label: string; url: string }[];
  origin?: 'builtin' | 'wikipedia';
  reviewStatus?: 'reviewed' | 'candidate';
}

export interface LearningSession {
  id: string;
  termId: string;
  phase: Phase;
  outputSeconds: 180 | 300;
  deadlineAt?: number;
  pausedRemainingMs?: number;
  transcript: string;
  createdAt: number;
  updatedAt: number;
  audioId?: string;
  evaluation?: EvaluationResult;
}

export interface StoredAudio {
  id: string;
  blob: Blob;
  mimeType: string;
  createdAt: number;
}

export interface HistoryEntry extends LearningSession {
  savedAt: number;
}

export interface EvaluationResult {
  understanding: number;
  expression: number;
  application: number;
  summary: string;
  strengths: string[];
  corrections: string[];
  improvements: string[];
  nextQuestion: string;
}

export type AiProvider = 'openai' | 'anthropic';

export interface AiConfig {
  provider: AiProvider;
  endpoint: string;
  model: string;
  apiKey: string;
}

export interface EncryptedAiConfig {
  version: 1;
  provider: AiProvider;
  endpoint: string;
  model: string;
  salt: string;
  iv: string;
  ciphertext: string;
  iterations: number;
}
