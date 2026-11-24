import { useCallback, useEffect, useRef, useState } from 'react';
import { talkApi } from './api/talkClient';
import { ChatManagerDrawer } from './components/ChatManagerDrawer';
import { ChatTab } from './components/ChatTab';
import { MemoryDialog } from './components/MemoryDialog';
import { NotesTab } from './components/NotesTab';
import { QuestionsTab } from './components/QuestionsTab';
import { SettingsModal } from './components/SettingsModal';
import { TextbookTab } from './components/TextbookTab';
import { WorkspaceRail } from './components/WorkspaceRail';
import type {
  AiProvider,
  AppSettings,
  ChatAttachment,
  ChatItem,
  ChatMemory,
  ChatMessage,
  FlashcardItem,
  MemoryPack,
  ModeTab,
  NoteData,
  StoredQuestion,
  TextbookData,
  ThemeMode,
  ThinkingLevel,
} from './types/talk';
import { createId } from './utils/formatters';
import { processSelectedFiles } from './utils/fileAttachments';
import {
  analyzeActiveWindow,
  assembleContextPrompt,
  createEmptyMemory,
  estimateMessageTokens,
  estimateTokens,
  getPacksByStage,
  needsStage1Compaction,
  sortLearnerState,
} from './utils/memoryEngine';
import { parseChatIntent, parseQaSuggestions, type ParsedQaSuggestion } from './utils/qaParser';

const EMPTY_NOTE: NoteData = { title: '', body: '', tags: [], updatedAt: 0 };
const EMPTY_TEXTBOOK: TextbookData = { title: '', body: '', images: [], updatedAt: 0 };

function applyThemeClass(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === 'dark') {
    root.classList.add('dark');
  } else if (mode === 'light') {
    root.classList.remove('dark');
  } else {
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    root.classList.toggle('dark', Boolean(prefersDark));
  }
}

export default function App() {
  const [chats, setChats] = useState<ChatItem[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ModeTab>('chat');

  const [notesByChat, setNotesByChat] = useState<Record<string, NoteData>>({});
  const [questionsByChat, setQuestionsByChat] = useState<Record<string, StoredQuestion[]>>({});
  const [memoryByChat, setMemoryByChat] = useState<Record<string, ChatMemory>>({});
  const [cardsByChat, setCardsByChat] = useState<Record<string, FlashcardItem[]>>({});
  const [textbook, setTextbook] = useState<TextbookData>(EMPTY_TEXTBOOK);

  const [settings, setSettings] = useState<AppSettings>({
    provider: 'gemini',
    thinkingLevel: 'medium',
    themeMode: 'system',
    chatModel: 'gemini-4-hydrogen',
    sttModel: 'gemini-3.5-transcribe',
  });

  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isDrawerPinned, setIsDrawerPinned] = useState(false);
  const [isMemoryOpen, setIsMemoryOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const [isLoading, setIsLoading] = useState(true);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [isSearchingWeb, setIsSearchingWeb] = useState(false);

  const [chatInput, setChatInput] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [webSearchArmed, setWebSearchArmed] = useState(false);
  const attachInputRef = useRef<HTMLInputElement | null>(null);

  // Streaming state keyed by requestId
  const [streamingState, setStreamingState] = useState<{
    requestId: string;
    chatId: string;
    text: string;
  } | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);

  const [compactingChatId, setCompactingChatId] = useState<string | null>(null);
  const memoryRef = useRef(memoryByChat);
  memoryRef.current = memoryByChat;

  // Apply theme mode & listen to OS preference when 'system'
  useEffect(() => {
    applyThemeClass(settings.themeMode);
    if (settings.themeMode !== 'system' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyThemeClass('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [settings.themeMode]);

  const loadChatContextData = useCallback(async (chatId: string) => {
    const [note, questions, memory, cards] = await Promise.all([
      talkApi.kvGet<NoteData>(`note:${chatId}`),
      talkApi.kvGet<StoredQuestion[]>(`questions:${chatId}`),
      talkApi.kvGet<ChatMemory>(`memory:${chatId}`),
      talkApi.listCards(chatId),
    ]);

    setNotesByChat((prev) => ({ ...prev, [chatId]: note ?? { ...EMPTY_NOTE, updatedAt: Date.now() } }));
    setQuestionsByChat((prev) => ({ ...prev, [chatId]: Array.isArray(questions) ? questions : [] }));
    setMemoryByChat((prev) => ({
      ...prev,
      [chatId]: memory && memory.version === 2 ? memory : createEmptyMemory(),
    }));
    setCardsByChat((prev) => ({ ...prev, [chatId]: cards }));
  }, []);

  // Initial load
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [loadedChats, loadedSettings, loadedTextbook] = await Promise.all([
          talkApi.listChats(),
          talkApi.getSettings(),
          talkApi.kvGet<TextbookData>('textbook'),
        ]);
        if (!mounted) return;
        setSettings(loadedSettings);
        if (loadedTextbook) {
          setTextbook(loadedTextbook);
        }
        if (loadedChats.length > 0) {
          setChats(loadedChats);
          setActiveChatId(loadedChats[0].id);
          await loadChatContextData(loadedChats[0].id);
        } else {
          const fresh = await talkApi.createChat('New study chat');
          if (!mounted) return;
          setChats([fresh]);
          setActiveChatId(fresh.id);
          await loadChatContextData(fresh.id);
        }
      } catch (err) {
        if (mounted) {
          setErrorBanner((err as Error).message || 'Failed to load workspace from server.');
        }
      } finally {
        if (mounted) setIsLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [loadChatContextData]);

  const activeChat = chats.find((c) => c.id === activeChatId) ?? null;
  const activeNote = (activeChatId && notesByChat[activeChatId]) || EMPTY_NOTE;
  const activeQuestions = (activeChatId && questionsByChat[activeChatId]) || [];
  const activeMemory = (activeChatId && memoryByChat[activeChatId]) || createEmptyMemory();
  const activeCards = (activeChatId && cardsByChat[activeChatId]) || [];

  const handleSelectChat = async (chatId: string) => {
    setActiveChatId(chatId);
    setErrorBanner(null);
    if (!isDrawerPinned) {
      setIsDrawerOpen(false);
    }
    if (!notesByChat[chatId] || !memoryByChat[chatId] || !questionsByChat[chatId]) {
      await loadChatContextData(chatId);
    }
  };

  const handleCreateChat = async () => {
    try {
      const created = await talkApi.createChat(`Study Session ${chats.length + 1}`);
      setChats((prev) => [created, ...prev]);
      setActiveChatId(created.id);
      setActiveTab('chat');
      await loadChatContextData(created.id);
      if (!isDrawerPinned) setIsDrawerOpen(false);
    } catch (err) {
      setErrorBanner((err as Error).message);
    }
  };

  const handleRenameChat = async (chatId: string, newTitle: string) => {
    try {
      const updated = await talkApi.updateChat(chatId, { title: newTitle });
      setChats((prev) => prev.map((c) => (c.id === chatId ? updated : c)));
    } catch (err) {
      setErrorBanner((err as Error).message);
    }
  };

  const handleDeleteChat = async (chatId: string) => {
    try {
      await talkApi.deleteChat(chatId);
      const remaining = chats.filter((c) => c.id !== chatId);
      if (remaining.length === 0) {
        const fresh = await talkApi.createChat('New study chat');
        setChats([fresh]);
        setActiveChatId(fresh.id);
        await loadChatContextData(fresh.id);
      } else {
        setChats(remaining);
        if (activeChatId === chatId) {
          setActiveChatId(remaining[0].id);
          await loadChatContextData(remaining[0].id);
        }
      }
    } catch (err) {
      setErrorBanner((err as Error).message);
    }
  };

  const handleSaveNote = async (chatId: string, nextNote: NoteData) => {
    setNotesByChat((prev) => ({ ...prev, [chatId]: nextNote }));
    await talkApi.kvSet(`note:${chatId}`, nextNote);
  };

  const handleSaveTextbook = async (next: TextbookData) => {
    setTextbook(next);
    await talkApi.kvSet('textbook', next);
  };

  // Question + Flashcards synchronization helpers
  const addQuestionAndCard = async (chatId: string, question: string, answer: string) => {
    const chatTitle = chats.find((c) => c.id === chatId)?.title || 'General Study';
    const existing = questionsByChat[chatId] || [];
    const duplicate = existing.find(
      (q) => q.question.trim().toLowerCase() === question.trim().toLowerCase()
    );
    if (duplicate) return;

    const now = Date.now();
    const qId = createId('q');
    const optimisticQ: StoredQuestion = {
      id: qId,
      question,
      answer,
      createdAt: now,
      updatedAt: now,
    };
    const nextList = [...existing, optimisticQ];
    setQuestionsByChat((prev) => ({ ...prev, [chatId]: nextList }));

    try {
      const card = await talkApi.createCard({
        chatId,
        questionId: qId,
        question,
        answer,
        subject: chatTitle,
      });
      const syncedList = nextList.map((q) => (q.id === qId ? { ...q, flashcardId: card.id } : q));
      setQuestionsByChat((prev) => ({
        ...prev,
        [chatId]: (prev[chatId] || syncedList).map((q) =>
          q.id === qId ? { ...q, flashcardId: card.id } : q
        ),
      }));
      setCardsByChat((prev) => ({ ...prev, [chatId]: [...(prev[chatId] || []), card] }));
      await talkApi.kvSet(`questions:${chatId}`, syncedList);
    } catch (err) {
      setQuestionsByChat((prev) => ({
        ...prev,
        [chatId]: (prev[chatId] || []).filter((q) => q.id !== qId),
      }));
      throw err;
    }
  };

  const updateQuestionAndCard = async (
    chatId: string,
    questionId: string,
    question: string,
    answer: string
  ) => {
    const existing = questionsByChat[chatId] || [];
    const target = existing.find((q) => q.id === questionId);
    if (!target) return;

    const nextList = existing.map((q) =>
      q.id === questionId ? { ...q, question, answer, updatedAt: Date.now() } : q
    );
    setQuestionsByChat((prev) => ({ ...prev, [chatId]: nextList }));
    await talkApi.kvSet(`questions:${chatId}`, nextList);

    if (target.flashcardId) {
      const updatedCard = await talkApi.updateCard(target.flashcardId, { question, answer });
      setCardsByChat((prev) => ({
        ...prev,
        [chatId]: (prev[chatId] || []).map((c) => (c.id === updatedCard.id ? updatedCard : c)),
      }));
    }
  };

  const deleteQuestionAndCard = async (chatId: string, questionId: string) => {
    const existing = questionsByChat[chatId] || [];
    const target = existing.find((q) => q.id === questionId);
    if (!target) return;

    const nextList = existing.filter((q) => q.id !== questionId);
    setQuestionsByChat((prev) => ({ ...prev, [chatId]: nextList }));
    await talkApi.kvSet(`questions:${chatId}`, nextList);

    if (target.flashcardId) {
      await talkApi.deleteCard(target.flashcardId).catch(() => {});
      setCardsByChat((prev) => ({
        ...prev,
        [chatId]: (prev[chatId] || []).filter((c) => c.id !== target.flashcardId),
      }));
    }
  };

  const handleToggleSuggestedQa = async (suggestion: ParsedQaSuggestion, checked: boolean) => {
    if (!activeChatId) return;
    const normalized = suggestion.question.trim().toLowerCase();
    const existing = questionsByChat[activeChatId] || [];
    const match = existing.find((q) => q.question.trim().toLowerCase() === normalized);
    try {
      if (checked && !match) {
        await addQuestionAndCard(activeChatId, suggestion.question, suggestion.answer);
      } else if (!checked && match) {
        await deleteQuestionAndCard(activeChatId, match.id);
      }
    } catch (err) {
      setErrorBanner((err as Error).message);
    }
  };

  // Memory compaction runner (background + forced)
  const runMemoryCompaction = async (chatId: string, chatMessages: ChatMessage[], force = false) => {
    const mem = memoryRef.current[chatId] || createEmptyMemory();
    const analysis = analyzeActiveWindow(chatMessages, mem.compactedCount);

    let toCompact = analysis.uncompactedOutsideWindow;
    if (toCompact.length === 0 && force && analysis.uncompactedTotalCount > 2) {
      // Forced compaction when user presses "Compact now" compacts older half of active window
      const sliceCount = Math.max(2, Math.floor(analysis.activeWindow.length / 2));
      toCompact = analysis.activeWindow.slice(0, sliceCount);
    }
    if (toCompact.length === 0) return;

    if (!force && !needsStage1Compaction(chatMessages, mem)) return;

    const startEpoch = mem.epoch;
    setCompactingChatId(chatId);

    try {
      const inputTokens = toCompact.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

      // Run Stage-1 summary + Living Learner State update in parallel
      const [summaryRes, learnerRes] = await Promise.all([
        talkApi.summarizeMemory({
          stage: 1,
          inputTokens,
          messages: toCompact,
        }),
        talkApi.updateLearnerState({
          currentState: mem.learnerState,
          messages: toCompact,
        }),
      ]);

      // Check epoch counter to protect manual deletions during in-flight compaction
      const latestMem = memoryRef.current[chatId] || mem;
      if (latestMem.epoch !== startEpoch) {
        return;
      }

      const now = Date.now();
      let packs: MemoryPack[] = [
        ...latestMem.packs,
        {
          id: createId('pack_s1'),
          stage: 1,
          summary: summaryRes.summary,
          bullets: summaryRes.bullets,
          tokenCount: estimateTokens(summaryRes.summary),
          sourceRange: [latestMem.compactedCount, latestMem.compactedCount + toCompact.length],
          createdAt: now,
        },
      ];

      let condensedArchive = latestMem.condensedArchive || '';

      // Cascade merges: Stage 1 -> Stage 2 -> Stage 3 -> Condensed archive
      for (const stage of [1, 2, 3] as const) {
        const stagePacks = getPacksByStage(packs, stage);
        if (stagePacks.length > 4) {
          // Two oldest packs are at the end (P4 & P5 after inserting new)
          const oldestTwo = stagePacks.slice(-2);
          const mergedTok = oldestTwo.reduce((s, p) => s + p.tokenCount, 0);
          if (stage < 3) {
            const nextStage = (stage + 1) as 2 | 3;
            const merged = await talkApi.summarizeMemory({
              stage: nextStage,
              inputTokens: mergedTok,
              packs: oldestTwo,
            });
            const removeIds = new Set(oldestTwo.map((p) => p.id));
            packs = packs.filter((p) => !removeIds.has(p.id));
            packs.push({
              id: createId(`pack_s${nextStage}`),
              stage: nextStage,
              summary: merged.summary,
              bullets: merged.bullets,
              tokenCount: estimateTokens(merged.summary),
              createdAt: oldestTwo[0].createdAt,
            });
          } else {
            const merged = await talkApi.summarizeMemory({
              stage: 3,
              inputTokens: mergedTok,
              packs: oldestTwo,
            });
            const removeIds = new Set(oldestTwo.map((p) => p.id));
            packs = packs.filter((p) => !removeIds.has(p.id));
            condensedArchive = condensedArchive
              ? `${condensedArchive}\n\n${merged.summary}`.slice(-1800)
              : merged.summary;
          }
        }
      }

      // Final epoch guard before saving
      if ((memoryRef.current[chatId]?.epoch ?? startEpoch) !== startEpoch) {
        return;
      }

      const updatedMemory: ChatMemory = {
        version: 2,
        compactedCount: latestMem.compactedCount + toCompact.length,
        compactedTokens: latestMem.compactedTokens + inputTokens,
        epoch: latestMem.epoch,
        learnerState: sortLearnerState(learnerRes.concepts),
        packs,
        condensedArchive: condensedArchive || undefined,
        updatedAt: Date.now(),
        lastError: undefined,
      };

      setMemoryByChat((prev) => ({ ...prev, [chatId]: updatedMemory }));
      await talkApi.kvSet(`memory:${chatId}`, updatedMemory);
    } catch (err) {
      const currentMem = memoryRef.current[chatId] || mem;
      const erroredMemory: ChatMemory = {
        ...currentMem,
        lastError: (err as Error).message || 'Memory compaction failed',
        updatedAt: Date.now(),
      };
      setMemoryByChat((prev) => ({ ...prev, [chatId]: erroredMemory }));
      await talkApi.kvSet(`memory:${chatId}`, erroredMemory).catch(() => {});
    } finally {
      setCompactingChatId((prev) => (prev === chatId ? null : prev));
    }
  };

  const handleRemoveConcept = async (conceptId: string) => {
    if (!activeChatId) return;
    const current = memoryByChat[activeChatId] || createEmptyMemory();
    const updated: ChatMemory = {
      ...current,
      epoch: current.epoch + 1,
      learnerState: current.learnerState.filter((c) => c.id !== conceptId),
      updatedAt: Date.now(),
    };
    setMemoryByChat((prev) => ({ ...prev, [activeChatId]: updated }));
    await talkApi.kvSet(`memory:${activeChatId}`, updated);
  };

  const handleDeletePack = async (packId: string) => {
    if (!activeChatId) return;
    const current = memoryByChat[activeChatId] || createEmptyMemory();
    const updated: ChatMemory = {
      ...current,
      epoch: current.epoch + 1,
      packs: current.packs.filter((p) => p.id !== packId),
      updatedAt: Date.now(),
    };
    setMemoryByChat((prev) => ({ ...prev, [activeChatId]: updated }));
    await talkApi.kvSet(`memory:${activeChatId}`, updated);
  };

  const handleSelectThinkingLevel = async (next: ThinkingLevel) => {
    setSettings((prev) => ({ ...prev, thinkingLevel: next }));
    try {
      const saved = await talkApi.updateSettings({ thinkingLevel: next });
      setSettings(saved);
    } catch {
      // keep optimistic state
    }
  };

  const handleSaveSettings = async (themeMode: ThemeMode, provider: AiProvider) => {
    setSettings((prev) => ({ ...prev, themeMode, provider }));
    setIsSettingsOpen(false);
    try {
      const saved = await talkApi.updateSettings({ themeMode, provider });
      setSettings(saved);
    } catch (err) {
      setErrorBanner((err as Error).message);
    }
  };

  const handleCancelStream = async () => {
    const reqId = activeRequestIdRef.current;
    if (reqId) {
      await talkApi.cancelChat(reqId).catch(() => {});
    }
  };

  const handleSendMessage = async (
    text: string,
    attachments: ChatAttachment[],
    useWebSearch: boolean
  ) => {
    if (!activeChat) return;
    const chatId = activeChat.id;
    setErrorBanner(null);

    const userMsg: ChatMessage = {
      id: createId('msg'),
      role: 'user',
      content: text,
      createdAt: Date.now(),
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    const messagesWithUser = [...activeChat.messages, userMsg];
    const nextTitle =
      activeChat.messages.length === 0 && activeChat.title.startsWith('Study Session')
        ? text.slice(0, 42) || activeChat.title
        : activeChat.title;

    setChats((prev) =>
      prev.map((c) =>
        c.id === chatId
          ? { ...c, title: nextTitle, messages: messagesWithUser, updatedAt: Date.now() }
          : c
      )
    );
    await talkApi.updateChat(chatId, { title: nextTitle, messages: messagesWithUser });

    // Check direct chat intents (no AI call)
    const intent = parseChatIntent(text);
    if (intent && attachments.length === 0) {
      let confirmation = '';
      if (intent.type === 'add_last_question') {
        const lastAssistant = [...activeChat.messages]
          .reverse()
          .find((m) => m.role === 'assistant' && !m.memoryStage);
        const parsed = lastAssistant ? parseQaSuggestions(lastAssistant.content) : [];
        const existing = questionsByChat[chatId] || [];
        const nextToAdd = parsed.find(
          (p) => !existing.some((q) => q.question.trim().toLowerCase() === p.question.trim().toLowerCase())
        ) ?? parsed[0];
        if (nextToAdd) {
          await addQuestionAndCard(chatId, nextToAdd.question, nextToAdd.answer);
          confirmation = `Saved question to your Questions list and created an EXAM flashcard:\n"${nextToAdd.question}"`;
        } else {
          confirmation = 'No suggested question was found in the previous tutor message to add.';
        }
      } else if (intent.type === 'delete_question') {
        const list = questionsByChat[chatId] || [];
        const target = list[intent.index - 1];
        if (target) {
          await deleteQuestionAndCard(chatId, target.id);
          confirmation = `Deleted question ${intent.index}: "${target.question}"`;
        } else {
          confirmation = `Question ${intent.index} does not exist (there are ${list.length} saved questions).`;
        }
      } else if (intent.type === 'change_question') {
        const list = questionsByChat[chatId] || [];
        const target = list[intent.index - 1];
        if (target) {
          await updateQuestionAndCard(chatId, target.id, intent.newQuestion, target.answer);
          confirmation = `Updated question ${intent.index} to:\n"${intent.newQuestion}"`;
        } else {
          confirmation = `Question ${intent.index} does not exist (there are ${list.length} saved questions).`;
        }
      }

      const replyMsg: ChatMessage = {
        id: createId('msg'),
        role: 'assistant',
        content: confirmation,
        createdAt: Date.now(),
      };
      const updatedMessages = [...messagesWithUser, replyMsg];
      setChats((prev) =>
        prev.map((c) => (c.id === chatId ? { ...c, messages: updatedMessages, updatedAt: Date.now() } : c))
      );
      await talkApi.updateChat(chatId, { messages: updatedMessages });
      return;
    }

    // Optional Tavily web search before sending
    const extraSystemNotices: string[] = [];
    if (useWebSearch && text.trim()) {
      setIsSearchingWeb(true);
      try {
        const searchRes = await talkApi.webSearch(text);
        const formattedResults = searchRes.results
          .map((r, i) => `${i + 1}. ${r.title} (${r.url})\n${r.content}`)
          .join('\n\n');
        extraSystemNotices.push(
          `## Live Web Search Results (Tavily)\n${searchRes.answer ? `Summary: ${searchRes.answer}\n\n` : ''}${formattedResults}`
        );
      } catch (err) {
        setErrorBanner((err as Error).message);
      } finally {
        setIsSearchingWeb(false);
      }
    }

    const requestId = createId('req');
    activeRequestIdRef.current = requestId;
    setStreamingState({ requestId, chatId, text: '' });

    const assembled = assembleContextPrompt({
      memory: memoryByChat[chatId] || createEmptyMemory(),
      note: notesByChat[chatId],
      textbook,
      messages: messagesWithUser,
      extraSystemNotices,
    });

    let accumulated = '';

    try {
      await talkApi.streamChat(
        {
          requestId,
          chatId,
          messages: assembled.selectedMessages,
          systemPrompt: assembled.systemPrompt,
          thinkingLevel: settings.thinkingLevel,
          textbookImages: assembled.textbookImagesForLatestUser,
        },
        {
          onChunk: (rid, delta) => {
            if (rid !== activeRequestIdRef.current) return;
            accumulated += delta;
            setStreamingState((prev) =>
              prev && prev.requestId === rid ? { ...prev, text: prev.text + delta } : prev
            );
          },
          onDone: async (rid, fullText, cancelled) => {
            if (rid !== activeRequestIdRef.current) return;
            activeRequestIdRef.current = null;
            setStreamingState(null);

            const finalContent = (fullText || accumulated).trim();
            if (!finalContent) {
              if (!cancelled) {
                setErrorBanner('The model returned an empty response. Please try again.');
              }
              return;
            }

            const assistantMsg: ChatMessage = {
              id: createId('msg'),
              role: 'assistant',
              content: finalContent,
              createdAt: Date.now(),
            };
            const finalMessages = [...messagesWithUser, assistantMsg];
            setChats((prev) =>
              prev.map((c) =>
                c.id === chatId ? { ...c, messages: finalMessages, updatedAt: Date.now() } : c
              )
            );
            await talkApi.updateChat(chatId, { messages: finalMessages });

            // Background compaction runs after reply is saved & composer unlocks
            if (needsStage1Compaction(finalMessages, memoryRef.current[chatId] || createEmptyMemory())) {
              void runMemoryCompaction(chatId, finalMessages, false);
            }
          },
          onError: (rid, error) => {
            if (rid !== activeRequestIdRef.current) return;
            activeRequestIdRef.current = null;
            setStreamingState(null);
            setErrorBanner(error);
          },
        }
      );
    } catch (err) {
      if (activeRequestIdRef.current === requestId) {
        activeRequestIdRef.current = null;
        setStreamingState(null);
        setErrorBanner((err as Error).message || 'Failed to stream response.');
      }
    }
  };

  const handleProcessChatFiles = async (files: FileList | File[]) => {
    const { images, textBlocks } = await processSelectedFiles(files);
    if (images.length > 0) {
      setPendingAttachments((prev) => [...prev, ...images]);
    }
    if (textBlocks.length > 0) {
      setChatInput((prev) => {
        const prefix = prev.trim() ? `${prev.trimEnd()}\n\n` : '';
        return `${prefix}${textBlocks.join('\n\n')}`;
      });
    }
    if ((images.length > 0 || textBlocks.length > 0) && activeTab !== 'chat') {
      setActiveTab('chat');
    }
  };

  return (
    <div className="h-screen flex flex-col bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 overflow-hidden">
      <input
        ref={attachInputRef}
        type="file"
        multiple
        accept="image/*,.txt,.md,.csv,.json,.ts,.tsx,.js,.jsx,.py"
        className="hidden"
        onChange={async (e) => {
          if (e.target.files?.length) {
            await handleProcessChatFiles(e.target.files);
            e.target.value = '';
          }
        }}
      />
      <div className="relative flex-1 min-h-0 flex">
        <ChatManagerDrawer
          chats={chats}
          activeChatId={activeChatId}
          isOpen={isDrawerOpen}
          isPinned={isDrawerPinned}
          onCloseDrawer={() => setIsDrawerOpen(false)}
          onTogglePin={() => {
            setIsDrawerPinned((p) => {
              const next = !p;
              setIsDrawerOpen(next);
              return next;
            });
          }}
          onSelectChat={handleSelectChat}
          onCreateChat={handleCreateChat}
          onRenameChat={handleRenameChat}
          onDeleteChat={handleDeleteChat}
        />

        <main className="relative flex-1 min-w-0 min-h-0 flex flex-col">
          <WorkspaceRail
            showSessionButton={!isDrawerOpen && !isDrawerPinned}
            onOpenSessionDrawer={() => setIsDrawerOpen(true)}
            activeTab={activeTab}
            onSelectTab={setActiveTab}
            onAttachFilesClick={() => attachInputRef.current?.click()}
            webSearchArmed={webSearchArmed}
            onToggleWebSearch={() => setWebSearchArmed((v) => !v)}
            thinkingLevel={settings.thinkingLevel}
            onSelectThinkingLevel={handleSelectThinkingLevel}
            isMemoryOpen={isMemoryOpen}
            onOpenMemory={() => setIsMemoryOpen(true)}
            isCompacting={Boolean(activeChatId && compactingChatId === activeChatId)}
            memoryError={activeMemory.lastError}
            onOpenSettings={() => setIsSettingsOpen(true)}
            questionCount={activeQuestions.length}
          />

          {isLoading || !activeChat ? (
            <div className="flex-1 flex items-center justify-center text-sm text-slate-500 dark:text-slate-400">
              Loading study workspace…
            </div>
          ) : activeTab === 'chat' ? (
            <ChatTab
              chatId={activeChat.id}
              chatTitle={activeChat.title}
              messages={activeChat.messages}
              savedQuestions={activeQuestions}
              streamingText={
                streamingState && streamingState.chatId === activeChat.id
                  ? streamingState.text
                  : null
              }
              isStreaming={Boolean(streamingState && streamingState.chatId === activeChat.id)}
              isSearchingWeb={isSearchingWeb}
              errorBanner={errorBanner}
              onDismissError={() => setErrorBanner(null)}
              input={chatInput}
              onChangeInput={setChatInput}
              attachments={pendingAttachments}
              onRemoveAttachment={(id) =>
                setPendingAttachments((prev) => prev.filter((item) => item.id !== id))
              }
              onClearAttachments={() => setPendingAttachments([])}
              onProcessFiles={handleProcessChatFiles}
              webSearchArmed={webSearchArmed}
              onClearWebSearch={() => setWebSearchArmed(false)}
              onSendMessage={handleSendMessage}
              onCancelStream={handleCancelStream}
              onToggleSuggestedQa={handleToggleSuggestedQa}
              onTranscribeAudio={async (blob) => {
                const res = await talkApi.transcribeAudio(blob);
                return res.text;
              }}
            />
          ) : activeTab === 'notes' ? (
            <NotesTab
              chatId={activeChat.id}
              note={activeNote}
              onSaveNote={handleSaveNote}
            />
          ) : activeTab === 'textbook' ? (
            <TextbookTab textbook={textbook} onSaveTextbook={handleSaveTextbook} />
          ) : (
            <QuestionsTab
              questions={activeQuestions}
              cards={activeCards}
              onAddQuestion={(q, a) => addQuestionAndCard(activeChat.id, q, a)}
              onUpdateQuestion={(id, q, a) => updateQuestionAndCard(activeChat.id, id, q, a)}
              onDeleteQuestion={(id) => deleteQuestionAndCard(activeChat.id, id)}
            />
          )}
        </main>
      </div>

      <MemoryDialog
        isOpen={isMemoryOpen}
        memory={activeMemory}
        messages={activeChat?.messages || []}
        isCompacting={Boolean(activeChatId && compactingChatId === activeChatId)}
        onCompactNow={() => {
          if (activeChat) {
            void runMemoryCompaction(activeChat.id, activeChat.messages, true);
          }
        }}
        onRemoveConcept={handleRemoveConcept}
        onDeletePack={handleDeletePack}
        onClose={() => setIsMemoryOpen(false)}
      />

      <SettingsModal
        isOpen={isSettingsOpen}
        currentTheme={settings.themeMode}
        currentProvider={settings.provider}
        onSave={handleSaveSettings}
        onClose={() => setIsSettingsOpen(false)}
      />
    </div>
  );
}
