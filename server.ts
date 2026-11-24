import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { TalkStore } from './server/store.ts';
import {
  formatGeminiError,
  GEMINI_CHAT_MODEL,
  GEMINI_STT_MODEL,
  getGeminiKey,
  streamGeminiChat,
  summarizeWithGemini,
  transcribeWithGemini,
  updateLearnerStateWithGemini,
} from './server/gemini.ts';
import type { ChatAttachment, ChatMessage, ConceptState, MemoryPack } from './src/types/talk.ts';
import { getQuoteAllowance, getTargetSummaryTokens } from './src/utils/memoryEngine.ts';

const PORT = 3000;
const HORMOUZ_BASE_URL = (process.env.HORMOUZ_BASE_URL || 'https://api.hormouz.net/v1').replace(/\/+$/, '');
const CHAT_MODEL = process.env.HORMOUZ_CHAT_MODEL || 'openai/gpt-6-luna';
const STT_MODEL = process.env.HORMOUZ_STT_MODEL || 'microsoft/mai-transcribe-2';

const store = new TalkStore();
const activeStreams = new Map<string, AbortController>();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const VALID_KV_KEY = /^(note:[a-zA-Z0-9_-]+|questions:[a-zA-Z0-9_-]+|memory:[a-zA-Z0-9_-]+|textbook|extraKnowledge)$/;

function writeSseEvent(res: Response, event: string, payload: unknown): void {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function getHormouzKey(): string {
  return (process.env.HORMOUZ_API_KEY || '').trim();
}

function buildOpenAiMessages(
  systemPrompt: string,
  messages: ChatMessage[],
  textbookImages: ChatAttachment[]
): Array<{ role: string; content: unknown }> {
  const result: Array<{ role: string; content: unknown }> = [];
  if (systemPrompt.trim()) {
    result.push({ role: 'system', content: systemPrompt });
  }

  let latestUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      latestUserIdx = i;
      break;
    }
  }

  messages.forEach((msg, idx) => {
    const role = msg.role === 'system' ? 'system' : msg.role === 'assistant' ? 'assistant' : 'user';
    const textParts: string[] = [];
    if (msg.content) textParts.push(msg.content);

    const imageAttachments: ChatAttachment[] = [];
    if (Array.isArray(msg.attachments)) {
      for (const att of msg.attachments) {
        if (att.kind === 'text' && att.textContent) {
          textParts.push(`\n[Attached file: ${att.name}]\n${att.textContent}`);
        } else if (att.kind === 'image' && att.dataUrl) {
          imageAttachments.push(att);
        }
      }
    }

    const extraTextbookImages =
      idx === latestUserIdx && Array.isArray(textbookImages) ? textbookImages.filter((a) => a.dataUrl) : [];

    if (role === 'user' && (imageAttachments.length > 0 || extraTextbookImages.length > 0)) {
      const contentArray: Array<Record<string, unknown>> = [];
      let combinedText = textParts.join('\n').trim();
      if (extraTextbookImages.length > 0) {
        combinedText = `${combinedText}\n\n[Authoritative Textbook Pages attached below — treat these images as authoritative textbook reference material.]`.trim();
      }
      if (combinedText) {
        contentArray.push({ type: 'text', text: combinedText });
      }
      for (const img of imageAttachments) {
        contentArray.push({ type: 'image_url', image_url: { url: img.dataUrl } });
      }
      for (const tbImg of extraTextbookImages) {
        contentArray.push({ type: 'image_url', image_url: { url: tbImg.dataUrl } });
      }
      result.push({ role, content: contentArray });
    } else {
      result.push({ role, content: textParts.join('\n') });
    }
  });

  return result;
}

function extractJsonBlock(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const objStart = raw.indexOf('{');
  const arrStart = raw.indexOf('[');
  if (arrStart !== -1 && (objStart === -1 || arrStart < objStart)) {
    const arrEnd = raw.lastIndexOf(']');
    if (arrEnd > arrStart) return raw.slice(arrStart, arrEnd + 1);
  }
  if (objStart !== -1) {
    const objEnd = raw.lastIndexOf('}');
    if (objEnd > objStart) return raw.slice(objStart, objEnd + 1);
  }
  return raw.trim();
}

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  // Chats REST
  app.get('/api/chats', (_req, res) => {
    res.json({ chats: store.listChats() });
  });

  app.post('/api/chats', (req, res) => {
    const title = typeof req.body?.title === 'string' ? req.body.title : undefined;
    const chat = store.createChat(title);
    res.status(201).json({ chat });
  });

  app.put('/api/chats/:id', (req, res) => {
    const id = req.params.id;
    if (!id || typeof id !== 'string') {
      res.status(400).json({ error: 'Invalid chat ID' });
      return;
    }
    const updated = store.updateChat(id, {
      title: typeof req.body?.title === 'string' ? req.body.title : undefined,
      messages: Array.isArray(req.body?.messages) ? req.body.messages : undefined,
      updatedAt: typeof req.body?.updatedAt === 'number' ? req.body.updatedAt : undefined,
    });
    if (!updated) {
      res.status(404).json({ error: 'Chat not found' });
      return;
    }
    res.json({ chat: updated });
  });

  app.delete('/api/chats/:id', (req, res) => {
    const ok = store.deleteChat(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Chat not found' });
      return;
    }
    res.json({ ok: true });
  });

  // KV Store
  app.get('/api/kv/:key', (req, res) => {
    const key = req.params.key;
    if (!VALID_KV_KEY.test(key)) {
      res.status(400).json({ error: 'Invalid KV key' });
      return;
    }
    res.json({ key, value: store.getKv(key) });
  });

  app.put('/api/kv/:key', (req, res) => {
    const key = req.params.key;
    if (!VALID_KV_KEY.test(key)) {
      res.status(400).json({ error: 'Invalid KV key' });
      return;
    }
    const value = req.body?.value;
    if (value === undefined) {
      res.status(400).json({ error: 'Missing value in request body' });
      return;
    }
    const saved = store.setKv(key, value);
    res.json({ key, value: saved });
  });

  // Flashcards Bridge
  app.get('/api/cards', (req, res) => {
    const chatId = typeof req.query.chatId === 'string' ? req.query.chatId : undefined;
    res.json({ cards: store.listCards(chatId) });
  });

  app.post('/api/cards', (req, res) => {
    const { chatId, questionId, question, answer, subject } = req.body ?? {};
    if (typeof chatId !== 'string' || typeof questionId !== 'string' || typeof question !== 'string') {
      res.status(400).json({ error: 'chatId, questionId, and question are required' });
      return;
    }
    const card = store.createCard({
      chatId,
      questionId,
      question,
      answer: typeof answer === 'string' ? answer : '',
      subject: typeof subject === 'string' ? subject : 'General Study',
    });
    res.status(201).json({ card });
  });

  app.put('/api/cards/:id', (req, res) => {
    const updated = store.updateCard(req.params.id, {
      question: typeof req.body?.question === 'string' ? req.body.question : undefined,
      answer: typeof req.body?.answer === 'string' ? req.body.answer : undefined,
      status: req.body?.status,
      subject: typeof req.body?.subject === 'string' ? req.body.subject : undefined,
    });
    if (!updated) {
      res.status(404).json({ error: 'Card not found' });
      return;
    }
    res.json({ card: updated });
  });

  app.delete('/api/cards/:id', (req, res) => {
    const ok = store.deleteCard(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Card not found' });
      return;
    }
    res.json({ ok: true });
  });

  app.get('/api/subjects', (_req, res) => {
    res.json({ subjects: store.listSubjects() });
  });

  // Settings
  app.get('/api/settings', (_req, res) => {
    const saved = store.getSettings();
    const isGemini = saved.provider === 'gemini';
    res.json({
      settings: {
        ...saved,
        chatModel: isGemini ? GEMINI_CHAT_MODEL : CHAT_MODEL,
        sttModel: isGemini ? GEMINI_STT_MODEL : STT_MODEL,
        hasGeminiKey: Boolean(getGeminiKey()),
        hasHormouzKey: Boolean(getHormouzKey()),
        hasTavilyKey: Boolean((process.env.TAVILY_API_KEY || '').trim()),
      },
    });
  });

  app.put('/api/settings', (req, res) => {
    const saved = store.updateSettings({
      provider: req.body?.provider,
      thinkingLevel: req.body?.thinkingLevel,
      themeMode: req.body?.themeMode,
    });
    const isGemini = saved.provider === 'gemini';
    res.json({
      settings: {
        ...saved,
        chatModel: isGemini ? GEMINI_CHAT_MODEL : CHAT_MODEL,
        sttModel: isGemini ? GEMINI_STT_MODEL : STT_MODEL,
        hasGeminiKey: Boolean(getGeminiKey()),
        hasHormouzKey: Boolean(getHormouzKey()),
        hasTavilyKey: Boolean((process.env.TAVILY_API_KEY || '').trim()),
      },
    });
  });

  // Frameless window IPC bridge
  app.post('/api/window/:action', (req, res) => {
    const action = req.params.action;
    if (!['minimize', 'maximize', 'fullscreen', 'close'].includes(action)) {
      res.status(400).json({ error: 'Unsupported window action' });
      return;
    }
    res.json({ ok: true, action });
  });

  // Streaming AI Chat (Gemini 4 Hydrogen or Hormouz OpenAI-compatible SSE proxy)
  app.post('/api/ai/chat', async (req: Request, res: Response) => {
    const {
      requestId,
      messages = [],
      systemPrompt = '',
      thinkingLevel = 'medium',
      textbookImages = [],
    } = req.body ?? {};

    if (typeof requestId !== 'string' || !requestId) {
      res.status(400).json({ error: 'requestId is required' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const provider = store.getSettings().provider;
    const controller = new AbortController();
    activeStreams.set(requestId, controller);

    res.on('close', () => {
      if (!res.writableEnded) {
        controller.abort();
      }
      activeStreams.delete(requestId);
    });

    if (provider === 'gemini') {
      try {
        const fullText = await streamGeminiChat({
          messages: Array.isArray(messages) ? messages : [],
          systemPrompt: typeof systemPrompt === 'string' ? systemPrompt : '',
          thinkingLevel: ['low', 'medium', 'high', 'xhigh'].includes(thinkingLevel)
            ? thinkingLevel
            : 'medium',
          textbookImages: Array.isArray(textbookImages) ? textbookImages : [],
          signal: controller.signal,
          onChunk: (delta) => {
            writeSseEvent(res, 'ai:chunk', { requestId, delta });
          },
        });
        if (controller.signal.aborted) {
          writeSseEvent(res, 'ai:done', { requestId, fullText, cancelled: true });
        } else {
          writeSseEvent(res, 'ai:done', { requestId, fullText });
        }
        res.end();
      } catch (err) {
        if ((err as Error).name === 'AbortError' || controller.signal.aborted) {
          writeSseEvent(res, 'ai:done', { requestId, cancelled: true });
        } else {
          writeSseEvent(res, 'ai:error', {
            requestId,
            error: formatGeminiError(err),
          });
        }
        res.end();
      } finally {
        activeStreams.delete(requestId);
      }
      return;
    }

    const apiKey = getHormouzKey();
    if (!apiKey) {
      activeStreams.delete(requestId);
      writeSseEvent(res, 'ai:error', {
        requestId,
        error: 'HORMOUZ_API_KEY is not configured on the server. Add HORMOUZ_API_KEY in Settings > Secrets or switch provider to Gemini.',
      });
      res.end();
      return;
    }

    try {
      const payloadMessages = buildOpenAiMessages(
        typeof systemPrompt === 'string' ? systemPrompt : '',
        Array.isArray(messages) ? messages : [],
        Array.isArray(textbookImages) ? textbookImages : []
      );

      const upstream = await fetch(`${HORMOUZ_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: CHAT_MODEL,
          messages: payloadMessages,
          stream: true,
          reasoning_effort:
            thinkingLevel === 'xhigh'
              ? 'high'
              : ['low', 'medium', 'high'].includes(thinkingLevel)
              ? thinkingLevel
              : 'medium',
        }),
        signal: controller.signal,
      });

      if (!upstream.ok || !upstream.body) {
        const errText = await upstream.text().catch(() => '');
        writeSseEvent(res, 'ai:error', {
          requestId,
          error: `Hormouz API error (${upstream.status}): ${errText.slice(0, 300) || upstream.statusText}`,
        });
        res.end();
        return;
      }

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line || !line.startsWith('data:')) continue;
          const dataStr = line.slice(5).trim();
          if (dataStr === '[DONE]') {
            writeSseEvent(res, 'ai:done', { requestId, fullText });
            res.end();
            return;
          }
          try {
            const parsed = JSON.parse(dataStr);
            const delta = parsed?.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta.length > 0) {
              fullText += delta;
              writeSseEvent(res, 'ai:chunk', { requestId, delta });
            }
          } catch {
            // Skip malformed partial JSON frames
          }
        }
      }

      writeSseEvent(res, 'ai:done', { requestId, fullText });
      res.end();
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        writeSseEvent(res, 'ai:done', { requestId, cancelled: true });
      } else {
        writeSseEvent(res, 'ai:error', {
          requestId,
          error: (err as Error).message || 'Failed to stream response from Hormouz.',
        });
      }
      res.end();
    } finally {
      activeStreams.delete(requestId);
    }
  });

  app.post('/api/ai/cancel', (req, res) => {
    const requestId = req.body?.requestId;
    if (typeof requestId === 'string' && activeStreams.has(requestId)) {
      activeStreams.get(requestId)?.abort();
      activeStreams.delete(requestId);
      res.json({ ok: true, cancelled: true });
      return;
    }
    res.json({ ok: true, cancelled: false });
  });

  // Memory Summarization (Stage 1 / 2 / 3)
  app.post('/api/ai/summarize', async (req, res) => {
    const { stage = 1, inputTokens = 1600, messages = [], packs = [] } = req.body ?? {};
    const validStage: 1 | 2 | 3 = stage === 2 ? 2 : stage === 3 ? 3 : 1;

    if (store.getSettings().provider === 'gemini') {
      try {
        const result = await summarizeWithGemini({
          stage: validStage,
          inputTokens: Number(inputTokens) || 1200,
          messages: Array.isArray(messages) ? messages : undefined,
          packs: Array.isArray(packs) ? packs : undefined,
        });
        res.json(result);
      } catch (err) {
        res.status(502).json({ error: formatGeminiError(err) });
      }
      return;
    }

    const apiKey = getHormouzKey();
    if (!apiKey) {
      res.status(400).json({ error: 'HORMOUZ_API_KEY is not configured for memory compaction.' });
      return;
    }

    const targetTokens = getTargetSummaryTokens(Number(inputTokens) || 1200, validStage);
    const quoteAllowance = Math.round(getQuoteAllowance(validStage) * 100);

    const sourceText =
      Array.isArray(packs) && packs.length > 0
        ? (packs as MemoryPack[])
            .map((p, idx) => `Pack ${idx + 1} (Stage ${p.stage}):\n${p.summary}\nBullets:\n${p.bullets.join('\n')}`)
            .join('\n\n')
        : (messages as ChatMessage[])
            .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
            .join('\n\n');

    try {
      const upstream = await fetch(`${HORMOUZ_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: CHAT_MODEL,
          stream: false,
          reasoning_effort: 'low',
          messages: [
            {
              role: 'system',
              content: `You are a study-memory compactor. Compress the following study material into a Stage ${validStage} episodic memory pack.
Target length: ~${targetTokens} tokens (strict max 400 tokens). Direct quote allowance: at most ${quoteAllowance}%.
Return valid JSON ONLY: {"summary": string, "bullets": string[]}. Keep 3-5 crisp factual study bullets.`,
            },
            { role: 'user', content: sourceText },
          ],
        }),
      });

      if (!upstream.ok) {
        const txt = await upstream.text().catch(() => '');
        res.status(upstream.status).json({ error: `Compaction API error: ${txt.slice(0, 200)}` });
        return;
      }

      const data = await upstream.json();
      const rawContent = String(data?.choices?.[0]?.message?.content || '');
      let summary = rawContent.trim();
      let bullets: string[] = [];
      try {
        const parsed = JSON.parse(extractJsonBlock(rawContent));
        if (typeof parsed.summary === 'string') summary = parsed.summary.trim();
        if (Array.isArray(parsed.bullets)) {
          bullets = parsed.bullets.map((b: unknown) => String(b)).filter(Boolean);
        }
      } catch {
        bullets = summary
          .split('\n')
          .map((l) => l.replace(/^[-*•\d.]+\s*/, '').trim())
          .filter(Boolean)
          .slice(0, 5);
      }
      res.json({ summary, bullets });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message || 'Memory compaction failed' });
    }
  });

  // Living Learner State update
  app.post('/api/ai/update-learner-state', async (req, res) => {
    const { currentState = [], messages = [] } = req.body ?? {};

    if (store.getSettings().provider === 'gemini') {
      try {
        const concepts = await updateLearnerStateWithGemini({
          currentState: Array.isArray(currentState) ? currentState : [],
          messages: Array.isArray(messages) ? messages : [],
        });
        res.json({ concepts });
      } catch (err) {
        res.status(502).json({ error: formatGeminiError(err) });
      }
      return;
    }

    const apiKey = getHormouzKey();
    if (!apiKey) {
      res.status(400).json({ error: 'HORMOUZ_API_KEY is not configured for learner state update.' });
      return;
    }

    const dialogue = (messages as ChatMessage[])
      .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
      .join('\n\n');

    try {
      const upstream = await fetch(`${HORMOUZ_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: CHAT_MODEL,
          stream: false,
          reasoning_effort: 'low',
          messages: [
            {
              role: 'system',
              content: `Maintain the Living Learner State (max 24 concepts).
Statuses allowed: "misunderstood", "unresolved", "shaky", "understood".
Update, promote, or add concepts based on the recent dialogue. Each note must be 1 concise line.
Return valid JSON ONLY: {"concepts": [{"concept": string, "status": "misunderstood"|"unresolved"|"shaky"|"understood", "note": string}]}`,
            },
            {
              role: 'user',
              content: `Current state:\n${JSON.stringify(currentState)}\n\nNew dialogue:\n${dialogue}`,
            },
          ],
        }),
      });

      if (!upstream.ok) {
        const txt = await upstream.text().catch(() => '');
        res.status(upstream.status).json({ error: `Learner state error: ${txt.slice(0, 200)}` });
        return;
      }

      const data = await upstream.json();
      const rawContent = String(data?.choices?.[0]?.message?.content || '');
      const parsed = JSON.parse(extractJsonBlock(rawContent));
      const list = Array.isArray(parsed?.concepts) ? parsed.concepts : Array.isArray(parsed) ? parsed : [];
      const now = Date.now();
      const concepts: ConceptState[] = list
        .filter((item: Record<string, unknown>) => typeof item?.concept === 'string')
        .slice(0, 24)
        .map((item: Record<string, unknown>, idx: number) => ({
          id: `cs_${now}_${idx}`,
          concept: String(item.concept),
          status: ['misunderstood', 'unresolved', 'shaky', 'understood'].includes(String(item.status))
            ? (item.status as ConceptState['status'])
            : 'unresolved',
          note: String(item.note || ''),
          updatedAt: now,
        }));
      res.json({ concepts });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message || 'Learner state update failed' });
    }
  });

  // Voice transcription (STT)
  app.post('/api/ai/transcribe', upload.single('file'), async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'Audio file is required' });
      return;
    }

    if (store.getSettings().provider === 'gemini') {
      try {
        const text = await transcribeWithGemini(
          req.file.buffer,
          req.file.mimetype || 'audio/webm'
        );
        res.json({ text });
      } catch (err) {
        res.status(502).json({ error: formatGeminiError(err) });
      }
      return;
    }

    const apiKey = getHormouzKey();
    if (!apiKey) {
      res.status(400).json({ error: 'HORMOUZ_API_KEY is not configured for voice transcription.' });
      return;
    }

    try {
      const form = new FormData();
      const blob = new Blob([new Uint8Array(req.file.buffer)], {
        type: req.file.mimetype || 'audio/webm',
      });
      form.append('file', blob, req.file.originalname || 'recording.webm');
      form.append('model', STT_MODEL);

      const upstream = await fetch(`${HORMOUZ_BASE_URL}/audio/transcriptions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: form,
      });

      if (!upstream.ok) {
        const txt = await upstream.text().catch(() => '');
        res.status(upstream.status).json({ error: `Transcription error: ${txt.slice(0, 200)}` });
        return;
      }

      const data = await upstream.json();
      res.json({ text: String(data?.text || '').trim() });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message || 'Transcription request failed' });
    }
  });

  // Web search (Tavily)
  app.post('/api/web-search', async (req, res) => {
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    if (!query) {
      res.status(400).json({ error: 'Search query is required' });
      return;
    }
    const tavilyKey = (process.env.TAVILY_API_KEY || '').trim();
    if (!tavilyKey) {
      res.status(400).json({
        error: 'TAVILY_API_KEY is not configured on the server. Add TAVILY_API_KEY in Secrets to enable live web search.',
      });
      return;
    }

    try {
      const upstream = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: tavilyKey,
          query,
          search_depth: 'basic',
          include_answer: true,
          max_results: 5,
        }),
      });
      if (!upstream.ok) {
        const txt = await upstream.text().catch(() => '');
        res.status(upstream.status).json({ error: `Tavily search error: ${txt.slice(0, 200)}` });
        return;
      }
      const data = await upstream.json();
      res.json({
        answer: data.answer || '',
        results: Array.isArray(data.results)
          ? data.results.map((r: Record<string, unknown>) => ({
              title: String(r.title || ''),
              url: String(r.url || ''),
              content: String(r.content || ''),
            }))
          : [],
      });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message || 'Web search failed' });
    }
  });

  // Frontend Vite / static middleware
  if (process.env.NODE_ENV !== 'production') {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexHtml = path.join(distDir, 'index.html');
      if (fs.existsSync(indexHtml)) {
        res.sendFile(indexHtml);
      } else {
        res.status(404).send('Build output not found.');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Talk study tutor server listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start Talk server:', err);
  process.exit(1);
});
