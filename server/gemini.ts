import { GoogleGenAI, ThinkingLevel, Type, type Content, type Part } from '@google/genai';
import type {
  ChatAttachment,
  ChatMessage,
  ConceptState,
  MemoryPack,
  ThinkingLevel as TalkThinkingLevel,
} from '../src/types/talk.ts';
import { getQuoteAllowance, getTargetSummaryTokens } from '../src/utils/memoryEngine.ts';

export const GEMINI_CHAT_MODEL = 'gemini-4-hydrogen';
export const GEMINI_STT_MODEL = 'gemini-3.5-transcribe';

const SUPPORTED_RASTER_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/heic',
  'image/heif',
]);

export function getGeminiKey(): string {
  return (process.env.GEMINI_API_KEY || '').trim();
}

function createGeminiClient(): GoogleGenAI {
  const apiKey = getGeminiKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured. Check Settings > Secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function toGeminiThinkingLevel(level: TalkThinkingLevel): ThinkingLevel {
  if (level === 'low') return ThinkingLevel.LOW;
  if (level === 'high') return ThinkingLevel.HIGH;
  if (level === 'xhigh') return ThinkingLevel.XHIGH;
  return ThinkingLevel.MEDIUM;
}

function parseDataUrl(dataUrl: string): { mimeType: string; base64: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (!match) return null;
  return { mimeType: match[1].toLowerCase(), base64: match[2] };
}

function attachmentToParts(att: ChatAttachment): Part[] {
  if (att.kind === 'text' && att.textContent) {
    return [{ text: `[Attached file: ${att.name}]\n${att.textContent}` }];
  }
  if (att.kind === 'image' && att.dataUrl) {
    const parsed = parseDataUrl(att.dataUrl);
    if (!parsed) return [];
    if (SUPPORTED_RASTER_MIMES.has(parsed.mimeType)) {
      const mime = parsed.mimeType === 'image/jpg' ? 'image/jpeg' : parsed.mimeType;
      return [{ inlineData: { mimeType: mime, data: parsed.base64 } }];
    }
    if (parsed.mimeType === 'image/svg+xml') {
      try {
        const svgText = Buffer.from(parsed.base64, 'base64').toString('utf8');
        return [{ text: `[Attached SVG diagram: ${att.name}]\n${svgText.slice(0, 4000)}` }];
      } catch {
        return [{ text: `[Attached diagram: ${att.name}]` }];
      }
    }
  }
  return [];
}

function buildGeminiContents(
  messages: ChatMessage[],
  textbookImages: ChatAttachment[]
): Content[] {
  let latestUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      latestUserIdx = i;
      break;
    }
  }

  const contents: Content[] = [];
  messages.forEach((msg, idx) => {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts: Part[] = [];
    let textBody = msg.content || '';

    const extraTextbook =
      idx === latestUserIdx && Array.isArray(textbookImages)
        ? textbookImages.filter((a) => a.dataUrl)
        : [];

    if (role === 'user' && extraTextbook.length > 0) {
      textBody = `${textBody}\n\n[Authoritative Textbook Pages attached below — treat these images as authoritative textbook reference material.]`.trim();
    }

    if (textBody) {
      parts.push({ text: textBody });
    }

    if (Array.isArray(msg.attachments)) {
      for (const att of msg.attachments) {
        parts.push(...attachmentToParts(att));
      }
    }

    if (role === 'user') {
      for (const tbImg of extraTextbook) {
        parts.push(...attachmentToParts(tbImg));
      }
    }

    if (parts.length > 0) {
      contents.push({ role, parts });
    }
  });

  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: 'Hello' }] });
  }

  return contents;
}

export function formatGeminiError(err: unknown): string {
  let msg = (err as Error)?.message || String(err);
  // Unwrap nested JSON error envelopes returned by @google/genai
  for (let i = 0; i < 2; i++) {
    try {
      const parsed = JSON.parse(msg);
      if (parsed?.error?.message) {
        msg = String(parsed.error.message);
        continue;
      }
      if (parsed?.message) {
        msg = String(parsed.message);
        continue;
      }
    } catch {
      break;
    }
  }
  if (/API_KEY_INVALID|PERMISSION_DENIED|403|401/i.test(msg)) {
    return 'Gemini API key error. Please verify GEMINI_API_KEY in Settings > Secrets.';
  }
  if (/RESOURCE_EXHAUSTED|429/i.test(msg)) {
    return 'Gemini rate limit reached (429). Please wait a moment and try again.';
  }
  if (/UNAVAILABLE|503|high demand/i.test(msg)) {
    return 'Gemini is temporarily experiencing high demand (503). Please try again in a few seconds.';
  }
  return msg || 'Gemini API request failed.';
}

function isTransientError(err: unknown): boolean {
  const msg = (err as Error)?.message || String(err);
  return /503|UNAVAILABLE|high demand|ECONNRESET|ETIMEDOUT/i.test(msg);
}

async function waitWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function streamGeminiChat(params: {
  messages: ChatMessage[];
  systemPrompt: string;
  thinkingLevel: TalkThinkingLevel;
  textbookImages: ChatAttachment[];
  signal: AbortSignal;
  onChunk: (delta: string) => void;
}): Promise<string> {
  const ai = createGeminiClient();
  const contents = buildGeminiContents(params.messages, params.textbookImages);

  const delays = [600, 1400];
  let lastError: unknown;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    let fullText = '';
    try {
      const streamResponse = await ai.models.generateContentStream({
        model: GEMINI_CHAT_MODEL,
        contents,
        config: {
          systemInstruction: params.systemPrompt || undefined,
          thinkingConfig: {
            thinkingLevel: toGeminiThinkingLevel(params.thinkingLevel),
          },
          abortSignal: params.signal,
        },
      });

      for await (const chunk of streamResponse) {
        if (params.signal.aborted) break;
        const text = chunk.text;
        if (typeof text === 'string' && text.length > 0) {
          fullText += text;
          params.onChunk(text);
        }
      }
      return fullText;
    } catch (err) {
      lastError = err;
      if (params.signal.aborted || (err as Error).name === 'AbortError') {
        throw err;
      }
      if (fullText.length === 0 && attempt < delays.length && isTransientError(err)) {
        await waitWithAbort(delays[attempt], params.signal);
        continue;
      }
      throw err;
    }
  }

  throw lastError;
}

export async function summarizeWithGemini(params: {
  stage: 1 | 2 | 3;
  inputTokens: number;
  messages?: ChatMessage[];
  packs?: MemoryPack[];
}): Promise<{ summary: string; bullets: string[] }> {
  const ai = createGeminiClient();
  const targetTokens = getTargetSummaryTokens(params.inputTokens, params.stage);
  const quoteAllowance = Math.round(getQuoteAllowance(params.stage) * 100);

  const sourceText =
    Array.isArray(params.packs) && params.packs.length > 0
      ? params.packs
          .map(
            (p, idx) =>
              `Pack ${idx + 1} (Stage ${p.stage}):\n${p.summary}\nBullets:\n${p.bullets.join('\n')}`
          )
          .join('\n\n')
      : (params.messages || [])
          .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
          .join('\n\n');

  const response = await ai.models.generateContent({
    model: GEMINI_CHAT_MODEL,
    contents: sourceText,
    config: {
      systemInstruction: `You are a study-memory compactor. Compress the study material into a Stage ${params.stage} episodic memory pack. Target length: ~${targetTokens} tokens (strict max 400 tokens). Direct quote allowance: at most ${quoteAllowance}%. Return 3-5 crisp factual study bullets.`,
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          summary: { type: Type.STRING },
          bullets: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: ['summary', 'bullets'],
      },
    },
  });

  const parsed = JSON.parse((response.text ?? '{}').trim());
  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
    bullets: Array.isArray(parsed.bullets)
      ? parsed.bullets.map((b: unknown) => String(b)).filter(Boolean)
      : [],
  };
}

export async function updateLearnerStateWithGemini(params: {
  currentState: ConceptState[];
  messages: ChatMessage[];
}): Promise<ConceptState[]> {
  const ai = createGeminiClient();
  const dialogue = params.messages
    .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
    .join('\n\n');

  const response = await ai.models.generateContent({
    model: GEMINI_CHAT_MODEL,
    contents: `Current state:\n${JSON.stringify(params.currentState)}\n\nNew dialogue:\n${dialogue}`,
    config: {
      systemInstruction:
        'Maintain the Living Learner State (max 24 concepts). Statuses allowed: "misunderstood", "unresolved", "shaky", "understood". Update, promote, or add concepts based on the recent dialogue. Each note must be 1 concise line.',
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          concepts: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                concept: { type: Type.STRING },
                status: { type: Type.STRING },
                note: { type: Type.STRING },
              },
              required: ['concept', 'status', 'note'],
            },
          },
        },
        required: ['concepts'],
      },
    },
  });

  const parsed = JSON.parse((response.text ?? '{}').trim());
  const list = Array.isArray(parsed?.concepts) ? parsed.concepts : [];
  const now = Date.now();
  return list
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
}

export async function transcribeWithGemini(
  audioBuffer: Buffer,
  mimeType: string
): Promise<string> {
  const ai = createGeminiClient();
  const normalizedMime = (mimeType || 'audio/webm').split(';')[0].trim();
  const response = await ai.models.generateContent({
    model: GEMINI_STT_MODEL,
    contents: {
      parts: [
        {
          inlineData: {
            mimeType: normalizedMime,
            data: audioBuffer.toString('base64'),
          },
        },
        { text: 'Transcribe this audio accurately. Return only the spoken transcript text.' },
      ],
    },
  });
  return (response.text ?? '').trim();
}
