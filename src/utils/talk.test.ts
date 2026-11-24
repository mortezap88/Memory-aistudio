import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseQaSuggestions,
  parseChatIntent,
  parseMessageSegments,
} from './qaParser';
import {
  analyzeActiveWindow,
  assembleContextPrompt,
  createEmptyMemory,
  getStageMergeHint,
  needsStage1Compaction,
  sortLearnerState,
  TEXTBOOK_MAX_CHARS,
} from './memoryEngine';
import type { ChatMessage, ConceptState, MemoryPack } from '../types/talk';
import { computeComposerLayout } from './formatters';
import { toGeminiThinkingLevel } from '../../server/gemini';
import { ThinkingLevel as GenAiThinkingLevel } from '@google/genai';

test('parseQaSuggestions extracts English numbered Q&A pairs', () => {
  const reply = `Here are two practice questions:

1. Why does the Bohr curve shift right during exercise?
Answer: Increased CO2 and lower pH stabilize the T-state of hemoglobin, decreasing oxygen affinity so tissues receive more O2.

2. What is the Haldane effect?
Answer: Deoxygenated hemoglobin binds H+ and CO2 more readily in peripheral capillaries.`;

  const parsed = parseQaSuggestions(reply);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].question, 'Why does the Bohr curve shift right during exercise?');
  assert.match(parsed[0].answer, /T-state of hemoglobin/);
  assert.equal(parsed[1].question, 'What is the Haldane effect?');
});

test('parseQaSuggestions extracts Persian numbered Q&A pairs', () => {
  const reply = `چند سوال تمرینی:

۱. اثر بور چیست؟
پاسخ: کاهش pH و افزایش دی‌اکسید کربن تمایل هموگلوبین به اکسیژن را کاهش می‌دهد.

۲. چرا پیوند پپتیدی مسطح است؟
جواب: به دلیل رزونانس بین جفت الکترون نیتروژن و گروه کربونیل.`;

  const parsed = parseQaSuggestions(reply);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].question, 'اثر بور چیست؟');
  assert.match(parsed[0].answer, /هموگلوبین/);
  assert.equal(parsed[1].question, 'چرا پیوند پپتیدی مسطح است؟');
});

test('parseChatIntent recognizes add, delete, and change intents', () => {
  assert.deepEqual(parseChatIntent('add this question'), { type: 'add_last_question' });
  assert.deepEqual(parseChatIntent('Save this question!'), { type: 'add_last_question' });
  assert.deepEqual(parseChatIntent('delete question 2'), { type: 'delete_question', index: 2 });
  assert.deepEqual(parseChatIntent('delete question ۳'), { type: 'delete_question', index: 3 });
  assert.deepEqual(
    parseChatIntent('change question 1 to Explain Gibbs free energy'),
    { type: 'change_question', index: 1, newQuestion: 'Explain Gibbs free energy' }
  );
  assert.equal(parseChatIntent('Tell me more about thermodynamics'), null);
});

test('parseMessageSegments splits fenced code blocks safely', () => {
  const segments = parseMessageSegments('Intro\n```ts\nconst x = 1;\n```\nOutro');
  assert.equal(segments.length, 3);
  assert.equal(segments[0].type, 'text');
  assert.equal(segments[1].type, 'code');
  assert.equal(segments[1].language, 'ts');
  assert.equal(segments[1].content, 'const x = 1;');
  assert.equal(segments[2].type, 'text');
});

test('sortLearnerState enforces misunderstood -> unresolved -> shaky -> understood priority and max 24', () => {
  const now = 1000;
  const list: ConceptState[] = [
    { id: '1', concept: 'U1', status: 'understood', note: 'good', updatedAt: now },
    { id: '2', concept: 'S1', status: 'shaky', note: 'review', updatedAt: now },
    { id: '3', concept: 'M1', status: 'misunderstood', note: 'wrong sign', updatedAt: now },
    { id: '4', concept: 'R1', status: 'unresolved', note: 'open', updatedAt: now },
  ];
  const sorted = sortLearnerState(list);
  assert.deepEqual(
    sorted.map((c) => c.status),
    ['misunderstood', 'unresolved', 'shaky', 'understood']
  );
});

test('active window analysis and Stage 1 compaction trigger at 1600 tokens or 24 messages', () => {
  const msgs: ChatMessage[] = Array.from({ length: 36 }, (_, idx) => ({
    id: `m_${idx}`,
    role: idx % 2 === 0 ? 'user' : 'assistant',
    content: 'a'.repeat(400), // 100 tokens each
    createdAt: idx * 1000,
  }));
  const mem = createEmptyMemory(0);
  const analysis = analyzeActiveWindow(msgs, mem.compactedCount);
  assert.equal(analysis.activeWindow.length, 10);
  assert.equal(analysis.uncompactedOutsideWindow.length, 26);
  assert.equal(needsStage1Compaction(msgs, mem), true);
});

test('getStageMergeHint reports merge explanation when 4 slots fill', () => {
  const stage1Packs: MemoryPack[] = [1, 2, 3, 4].map((n) => ({
    id: `p${n}`,
    stage: 1,
    summary: `S${n}`,
    bullets: [`b${n}`],
    tokenCount: 100,
    createdAt: n * 1000,
  }));
  assert.equal(getStageMergeHint(stage1Packs, 1), 'Next pack merges P3 + P4 → Stage 2');
  assert.equal(getStageMergeHint(stage1Packs.slice(0, 3), 1), null);
});

test('assembleContextPrompt clips textbook at 6000 chars, puts learner state first, and orders packs chronologically', () => {
  const mem = createEmptyMemory(100);
  mem.learnerState = [
    { id: 'c1', concept: 'Keq', status: 'misunderstood', note: 'confused with Q', updatedAt: 500 },
  ];
  mem.packs = [
    { id: 'p_new', stage: 1, summary: 'NEWER PACK', bullets: [], tokenCount: 120, createdAt: 2000 },
    { id: 'p_old', stage: 2, summary: 'OLDER PACK', bullets: [], tokenCount: 120, createdAt: 1000 },
  ];
  const longTextbook = 'X'.repeat(TEXTBOOK_MAX_CHARS + 500);
  const assembled = assembleContextPrompt({
    memory: mem,
    note: { title: 'Bio', body: 'Check chapter 4', tags: ['exam'], updatedAt: 100 },
    textbook: {
      title: 'Campbell',
      body: longTextbook,
      images: [{ id: 'img1', kind: 'image', name: 'fig1.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA==' }],
      updatedAt: 100,
    },
    messages: [{ id: 'm1', role: 'user', content: 'Hi', createdAt: 100 }],
  });

  const learnerIdx = assembled.systemPrompt.indexOf('Living Learner State');
  const episodicIdx = assembled.systemPrompt.indexOf('Episodic Memory');
  const olderIdx = assembled.systemPrompt.indexOf('OLDER PACK');
  const newerIdx = assembled.systemPrompt.indexOf('NEWER PACK');
  assert.ok(learnerIdx !== -1 && episodicIdx > learnerIdx);
  assert.ok(olderIdx !== -1 && newerIdx > olderIdx);
  assert.ok(assembled.systemPrompt.includes('[...truncated at 6,000 characters]'));
  assert.equal(assembled.textbookImagesForLatestUser.length, 1);
});

test('toGeminiThinkingLevel maps all 4 gemini-4-hydrogen options without MINIMAL', () => {
  assert.equal(toGeminiThinkingLevel('low'), GenAiThinkingLevel.LOW);
  assert.equal(toGeminiThinkingLevel('medium'), GenAiThinkingLevel.MEDIUM);
  assert.equal(toGeminiThinkingLevel('high'), GenAiThinkingLevel.HIGH);
  assert.equal(toGeminiThinkingLevel('xhigh'), GenAiThinkingLevel.XHIGH);
});

test('computeComposerLayout grows vertically without scrollbars until maxHeight', () => {
  assert.deepEqual(computeComposerLayout(34, 2, 36, 180), {
    heightPx: 36,
    overflowY: 'hidden',
  });
  assert.deepEqual(computeComposerLayout(78, 2, 36, 180), {
    heightPx: 80,
    overflowY: 'hidden',
  });
  assert.deepEqual(computeComposerLayout(220, 2, 36, 180), {
    heightPx: 180,
    overflowY: 'auto',
  });
});
