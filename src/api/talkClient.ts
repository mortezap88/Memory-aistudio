import type {
  AppSettings,
  ChatAttachment,
  ChatItem,
  ChatMemory,
  ChatMessage,
  ConceptState,
  FlashcardItem,
  NoteData,
  StoredQuestion,
  TextbookData,
  ThinkingLevel,
} from '../types/talk';

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof data?.error === 'string' ? data.error : `Request failed (${res.status})`);
  }
  return data as T;
}

export const talkApi = {
  async listChats(): Promise<ChatItem[]> {
    const data = await jsonRequest<{ chats: ChatItem[] }>('/api/chats');
    return data.chats;
  },

  async createChat(title?: string): Promise<ChatItem> {
    const data = await jsonRequest<{ chat: ChatItem }>('/api/chats', {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
    return data.chat;
  },

  async updateChat(
    id: string,
    patch: Partial<Pick<ChatItem, 'title' | 'messages' | 'updatedAt'>>
  ): Promise<ChatItem> {
    const data = await jsonRequest<{ chat: ChatItem }>(`/api/chats/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
    return data.chat;
  },

  async deleteChat(id: string): Promise<void> {
    await jsonRequest(`/api/chats/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async kvGet<T>(key: string): Promise<T | null> {
    const data = await jsonRequest<{ value: T | null }>(`/api/kv/${encodeURIComponent(key)}`);
    return data.value;
  },

  async kvSet<T>(key: string, value: T): Promise<T> {
    const data = await jsonRequest<{ value: T }>(`/api/kv/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    });
    return data.value;
  },

  async listCards(chatId?: string): Promise<FlashcardItem[]> {
    const qs = chatId ? `?chatId=${encodeURIComponent(chatId)}` : '';
    const data = await jsonRequest<{ cards: FlashcardItem[] }>(`/api/cards${qs}`);
    return data.cards;
  },

  async createCard(input: {
    chatId: string;
    questionId: string;
    question: string;
    answer: string;
    subject: string;
  }): Promise<FlashcardItem> {
    const data = await jsonRequest<{ card: FlashcardItem }>('/api/cards', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return data.card;
  },

  async updateCard(
    id: string,
    patch: Partial<Pick<FlashcardItem, 'question' | 'answer' | 'status' | 'subject'>>
  ): Promise<FlashcardItem> {
    const data = await jsonRequest<{ card: FlashcardItem }>(`/api/cards/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
    return data.card;
  },

  async deleteCard(id: string): Promise<void> {
    await jsonRequest(`/api/cards/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async listSubjects(): Promise<string[]> {
    const data = await jsonRequest<{ subjects: string[] }>('/api/subjects');
    return data.subjects;
  },

  async getSettings(): Promise<AppSettings> {
    const data = await jsonRequest<{ settings: AppSettings }>('/api/settings');
    return data.settings;
  },

  async updateSettings(
    patch: Partial<Pick<AppSettings, 'provider' | 'thinkingLevel' | 'themeMode'>>
  ): Promise<AppSettings> {
    const data = await jsonRequest<{ settings: AppSettings }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
    return data.settings;
  },

  async windowAction(action: 'minimize' | 'maximize' | 'fullscreen' | 'close'): Promise<void> {
    await jsonRequest(`/api/window/${action}`, { method: 'POST' });
  },

  async streamChat(
    payload: {
      requestId: string;
      chatId: string;
      messages: ChatMessage[];
      systemPrompt: string;
      thinkingLevel: ThinkingLevel;
      textbookImages: ChatAttachment[];
    },
    handlers: {
      onChunk: (requestId: string, delta: string) => void;
      onDone: (requestId: string, fullText?: string, cancelled?: boolean) => void;
      onError: (requestId: string, error: string) => void;
    }
  ): Promise<void> {
    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok || !res.body) {
      const errData = await res.json().catch(() => ({}));
      handlers.onError(
        payload.requestId,
        typeof errData?.error === 'string' ? errData.error : `Chat request failed (${res.status})`
      );
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let receivedTerminal = false;

    const processBlock = (block: string) => {
      const lines = block.split('\n');
      let currentEvent = 'message';
      let dataLine = '';
      for (const line of lines) {
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLine += line.slice(5).trim();
        }
      }
      if (!dataLine) return;
      try {
        const parsed = JSON.parse(dataLine);
        if (currentEvent === 'ai:chunk') {
          handlers.onChunk(parsed.requestId, parsed.delta || '');
        } else if (currentEvent === 'ai:done') {
          receivedTerminal = true;
          handlers.onDone(parsed.requestId, parsed.fullText, parsed.cancelled);
        } else if (currentEvent === 'ai:error') {
          receivedTerminal = true;
          handlers.onError(parsed.requestId, parsed.error || 'Unknown streaming error');
        }
      } catch {
        // ignore unparseable event frame
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';

      for (const block of chunks) {
        if (block.trim()) processBlock(block);
      }
    }

    if (buffer.trim()) {
      processBlock(buffer);
    }

    if (!receivedTerminal) {
      handlers.onDone(payload.requestId, undefined, false);
    }
  },

  async cancelChat(requestId: string): Promise<void> {
    await jsonRequest('/api/ai/cancel', {
      method: 'POST',
      body: JSON.stringify({ requestId }),
    });
  },

  async summarizeMemory(payload: {
    stage: 1 | 2 | 3;
    inputTokens: number;
    messages?: ChatMessage[];
    packs?: Array<{ stage: number; summary: string; bullets: string[] }>;
  }): Promise<{ summary: string; bullets: string[] }> {
    return jsonRequest('/api/ai/summarize', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async updateLearnerState(payload: {
    currentState: ConceptState[];
    messages: ChatMessage[];
  }): Promise<{ concepts: ConceptState[] }> {
    return jsonRequest('/api/ai/update-learner-state', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async transcribeAudio(blob: Blob, filename = 'recording.webm'): Promise<{ text: string }> {
    const form = new FormData();
    form.append('file', blob, filename);
    const res = await fetch('/api/ai/transcribe', {
      method: 'POST',
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(typeof data?.error === 'string' ? data.error : `Transcription failed (${res.status})`);
    }
    return data as { text: string };
  },

  async webSearch(query: string): Promise<{
    answer: string;
    results: Array<{ title: string; url: string; content: string }>;
  }> {
    return jsonRequest('/api/web-search', {
      method: 'POST',
      body: JSON.stringify({ query }),
    });
  },
};

export type { NoteData, StoredQuestion, TextbookData, ChatMemory };
