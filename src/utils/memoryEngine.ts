import type {
  ChatAttachment,
  ChatMemory,
  ChatMessage,
  ConceptState,
  ConceptStatus,
  MemoryPack,
  NoteData,
  TextbookData,
} from '../types/talk';

export const ACTIVE_WINDOW_MAX_MESSAGES = 10;
export const ACTIVE_WINDOW_MAX_TOKENS = 5000;
export const COMPACTION_TRIGGER_TOKENS = 1600;
export const COMPACTION_BACKSTOP_MESSAGES = 24;
export const STAGE_SLOTS = 4;
export const MEMORY_PROMPT_BUDGET_TOKENS = 2800;
export const TEXTBOOK_MAX_CHARS = 6000;
export const MAX_LEARNER_CONCEPTS = 24;
export const MIN_RECENT_TURNS = 4;

const STATUS_PRIORITY: Record<ConceptStatus, number> = {
  misunderstood: 0,
  unresolved: 1,
  shaky: 2,
  understood: 3,
};

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateMessageTokens(message: ChatMessage): number {
  let tokens = estimateTokens(message.content);
  if (message.attachments) {
    for (const att of message.attachments) {
      if (att.kind === 'image') {
        tokens += 250;
      } else if (att.textContent) {
        tokens += estimateTokens(att.textContent);
      }
    }
  }
  return tokens;
}

export function createEmptyMemory(now = Date.now()): ChatMemory {
  return {
    version: 2,
    compactedCount: 0,
    compactedTokens: 0,
    epoch: 0,
    learnerState: [],
    packs: [],
    updatedAt: now,
  };
}

export function sortLearnerState(concepts: ConceptState[]): ConceptState[] {
  return [...concepts]
    .sort((a, b) => {
      const pDiff = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
      if (pDiff !== 0) return pDiff;
      return b.updatedAt - a.updatedAt;
    })
    .slice(0, MAX_LEARNER_CONCEPTS);
}

export interface ActiveWindowAnalysis {
  activeWindow: ChatMessage[];
  activeTokens: number;
  uncompactedOutsideWindow: ChatMessage[];
  uncompactedOutsideTokens: number;
  uncompactedTotalCount: number;
}

export function analyzeActiveWindow(
  messages: ChatMessage[],
  compactedCount: number,
  maxMessages = ACTIVE_WINDOW_MAX_MESSAGES,
  maxTokens = ACTIVE_WINDOW_MAX_TOKENS
): ActiveWindowAnalysis {
  const safeCompacted = Math.max(0, Math.min(compactedCount, messages.length));
  const uncompactedTail = messages.slice(safeCompacted);

  const activeWindow: ChatMessage[] = [];
  let activeTokens = 0;

  // Fill newest-first up to maxMessages and maxTokens, always keeping at least 1 message if present
  for (let i = uncompactedTail.length - 1; i >= 0; i--) {
    const msg = uncompactedTail[i];
    const msgTok = estimateMessageTokens(msg);
    if (
      activeWindow.length > 0 &&
      (activeWindow.length >= maxMessages || activeTokens + msgTok > maxTokens)
    ) {
      break;
    }
    activeWindow.unshift(msg);
    activeTokens += msgTok;
  }

  const outsideCount = uncompactedTail.length - activeWindow.length;
  const uncompactedOutsideWindow = uncompactedTail.slice(0, Math.max(0, outsideCount));
  const uncompactedOutsideTokens = uncompactedOutsideWindow.reduce(
    (sum, m) => sum + estimateMessageTokens(m),
    0
  );

  return {
    activeWindow,
    activeTokens,
    uncompactedOutsideWindow,
    uncompactedOutsideTokens,
    uncompactedTotalCount: uncompactedTail.length,
  };
}

export function needsStage1Compaction(
  messages: ChatMessage[],
  memory: ChatMemory
): boolean {
  const analysis = analyzeActiveWindow(messages, memory.compactedCount);
  if (analysis.uncompactedOutsideWindow.length === 0) return false;
  return (
    analysis.uncompactedOutsideTokens >= COMPACTION_TRIGGER_TOKENS ||
    analysis.uncompactedOutsideWindow.length >= COMPACTION_BACKSTOP_MESSAGES
  );
}

export function getTargetSummaryTokens(inputTokens: number, stage: 1 | 2 | 3): number {
  if (stage === 1) {
    return Math.min(400, Math.max(90, Math.round(inputTokens * 0.25)));
  }
  return Math.min(400, Math.max(80, Math.round(inputTokens * 0.5)));
}

export function getQuoteAllowance(stage: 1 | 2 | 3): number {
  if (stage === 1) return 0.25;
  if (stage === 2) return 0.1;
  return 0;
}

export function getPacksByStage(packs: MemoryPack[], stage: 1 | 2 | 3): MemoryPack[] {
  // Ordered newest first: P1 (newest) .. P4 (oldest)
  return packs
    .filter((p) => p.stage === stage)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function getStageMergeHint(packs: MemoryPack[], stage: 1 | 2 | 3): string | null {
  const stagePacks = getPacksByStage(packs, stage);
  if (stagePacks.length < STAGE_SLOTS) return null;
  if (stage === 1) return 'Next pack merges P3 + P4 → Stage 2';
  if (stage === 2) return 'Next pack merges P3 + P4 → Stage 3';
  return 'Next pack rolls P3 + P4 → Condensed archive';
}

export interface AssembledPromptContext {
  systemPrompt: string;
  selectedMessages: ChatMessage[];
  textbookImagesForLatestUser: ChatAttachment[];
  includedPackIds: string[];
}

export function assembleContextPrompt(params: {
  memory: ChatMemory;
  note?: NoteData | null;
  textbook?: TextbookData | null;
  messages: ChatMessage[];
  extraSystemNotices?: string[];
}): AssembledPromptContext {
  const { memory, note, textbook, messages, extraSystemNotices = [] } = params;
  const sections: string[] = [
    'You are Talk, a rigorous, encouraging study tutor. Help the student understand deeply, catch misconceptions, and build exam-ready mastery.',
  ];

  // 1. Living Learner State (always first & authoritative)
  const sortedConcepts = sortLearnerState(memory.learnerState);
  if (sortedConcepts.length > 0) {
    const lines = sortedConcepts.map(
      (c) => `- [${c.status.toUpperCase()}] ${c.concept}: ${c.note}`
    );
    sections.push(
      `## Living Learner State (AUTHORITATIVE — overrides older episodic memory packs)\n${lines.join('\n')}`
    );
  }

  // 2. Episodic memory packs: select newest-first under 2,800-token budget, present chronologically
  let packBudgetLeft = MEMORY_PROMPT_BUDGET_TOKENS;
  const sortedNewestFirst = [...memory.packs].sort((a, b) => b.createdAt - a.createdAt);
  const chosenPacks: MemoryPack[] = [];
  for (const pack of sortedNewestFirst) {
    const tok = pack.tokenCount || estimateTokens(pack.summary);
    if (chosenPacks.length > 0 && packBudgetLeft - tok < 0) continue;
    chosenPacks.push(pack);
    packBudgetLeft -= tok;
  }
  const chronologicalPacks = chosenPacks.sort((a, b) => a.createdAt - b.createdAt);
  if (memory.condensedArchive?.trim() || chronologicalPacks.length > 0) {
    const packLines: string[] = [];
    if (memory.condensedArchive?.trim()) {
      packLines.push(`[Condensed Archive]\n${memory.condensedArchive.trim()}`);
    }
    for (const p of chronologicalPacks) {
      packLines.push(`[Stage ${p.stage} Pack]\n${p.summary}`);
    }
    sections.push(`## Episodic Memory (Chronological)\n${packLines.join('\n\n')}`);
  }

  // 3. Per-chat Notes
  if (note && (note.title.trim() || note.body.trim() || note.tags.length > 0)) {
    const tagLine = note.tags.length > 0 ? `Tags: ${note.tags.join(', ')}\n` : '';
    sections.push(
      `## Notes for this conversation\nTitle: ${note.title || 'Untitled'}\n${tagLine}${note.body}`
    );
  }

  // 4. Global Textbook (authoritative reference, clipped at 6,000 chars)
  const textbookImages: ChatAttachment[] = [];
  if (textbook && (textbook.title.trim() || textbook.body.trim() || textbook.images.length > 0)) {
    const clippedBody = textbook.body.slice(0, TEXTBOOK_MAX_CHARS);
    const wasClipped = textbook.body.length > TEXTBOOK_MAX_CHARS;
    sections.push(
      `## Global Textbook (AUTHORITATIVE REFERENCE)\nTitle: ${textbook.title || 'Reference Document'}\n${clippedBody}${wasClipped ? '\n[...truncated at 6,000 characters]' : ''}`
    );
    textbookImages.push(...textbook.images.slice(0, 8));
  }

  // 5. Extra system notices (e.g., Tavily search results)
  for (const notice of extraSystemNotices) {
    if (notice.trim()) {
      sections.push(notice.trim());
    }
  }

  // 6. Raw messages: uncompacted tail, bounded by 5,000 tokens + image budget, minimum 4 recent turns
  const safeCompacted = Math.max(0, Math.min(memory.compactedCount, messages.length));
  const tail = messages.slice(safeCompacted);
  const selectedMessages: ChatMessage[] = [];
  let tokenBudget = ACTIVE_WINDOW_MAX_TOKENS;

  for (let i = tail.length - 1; i >= 0; i--) {
    const m = tail[i];
    const tok = estimateMessageTokens(m);
    const belowMinTurns = selectedMessages.length < MIN_RECENT_TURNS;
    if (!belowMinTurns && tokenBudget - tok < 0) {
      break;
    }
    selectedMessages.unshift(m);
    tokenBudget -= tok;
  }

  return {
    systemPrompt: sections.join('\n\n'),
    selectedMessages,
    textbookImagesForLatestUser: textbookImages,
    includedPackIds: chronologicalPacks.map((p) => p.id),
  };
}
