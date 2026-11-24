export type ModeTab = 'chat' | 'notes' | 'textbook' | 'questions';

export type ThinkingLevel = 'low' | 'medium' | 'high' | 'xhigh';

export type ThemeMode = 'system' | 'light' | 'dark';

export type AiProvider = 'gemini' | 'hormouz';

export type ConceptStatus = 'misunderstood' | 'unresolved' | 'shaky' | 'understood';

export interface ChatAttachment {
  id: string;
  kind: 'image' | 'text';
  name: string;
  mimeType: string;
  dataUrl?: string;
  textContent?: string;
}

export interface CandidateQuestion {
  id: string;
  question: string;
  answer: string;
  status: 'pending' | 'accepted' | 'dismissed';
  savedQuestionId?: string;
  flashcardId?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
  attachments?: ChatAttachment[];
  candidate?: CandidateQuestion[];
  candidateState?: 'active' | 'resolved';
  memoryStage?: 1 | 2 | 3;
}

export interface ChatItem {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
}

export interface NoteData {
  title: string;
  body: string;
  tags: string[];
  images?: ChatAttachment[];
  updatedAt: number;
}

export interface TextbookData {
  title: string;
  body: string;
  images: ChatAttachment[];
  updatedAt: number;
}

export interface StoredQuestion {
  id: string;
  question: string;
  answer: string;
  flashcardId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface FlashcardItem {
  id: string;
  chatId: string;
  questionId: string;
  question: string;
  answer: string;
  type: 'EXAM';
  status: 'NEW' | 'LEARNING' | 'MASTERED';
  subject: string;
  createdAt: number;
  updatedAt: number;
}

export interface ConceptState {
  id: string;
  concept: string;
  status: ConceptStatus;
  note: string;
  updatedAt: number;
}

export interface MemoryPack {
  id: string;
  stage: 1 | 2 | 3;
  summary: string;
  bullets: string[];
  tokenCount: number;
  sourceRange?: [number, number];
  createdAt: number;
}

export interface ChatMemory {
  version: 2;
  compactedCount: number;
  compactedTokens: number;
  epoch: number;
  learnerState: ConceptState[];
  packs: MemoryPack[];
  condensedArchive?: string;
  updatedAt: number;
  lastError?: string;
}

export interface AppSettings {
  provider: AiProvider;
  thinkingLevel: ThinkingLevel;
  themeMode: ThemeMode;
  chatModel: string;
  sttModel: string;
  hasGeminiKey?: boolean;
  hasHormouzKey?: boolean;
  hasTavilyKey?: boolean;
}
