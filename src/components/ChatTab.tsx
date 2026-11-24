import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from 'react';
import {
  ArrowDown,
  BookOpen,
  Check,
  Copy,
  Loader2,
  Mic,
  MicOff,
  Square,
  X,
} from 'lucide-react';
import type {
  ChatAttachment,
  ChatMessage,
  StoredQuestion,
} from '../types/talk';
import { parseMessageSegments, parseQaSuggestions, type ParsedQaSuggestion } from '../utils/qaParser';
import { computeComposerLayout, formatRelativeTime } from '../utils/formatters';

interface ChatTabProps {
  chatId: string;
  chatTitle: string;
  messages: ChatMessage[];
  savedQuestions: StoredQuestion[];
  streamingText: string | null;
  isStreaming: boolean;
  isSearchingWeb: boolean;
  errorBanner: string | null;
  onDismissError: () => void;
  input: string;
  onChangeInput: (value: string) => void;
  attachments: ChatAttachment[];
  onRemoveAttachment: (id: string) => void;
  onClearAttachments: () => void;
  onProcessFiles: (files: FileList | File[]) => Promise<void>;
  webSearchArmed: boolean;
  onClearWebSearch: () => void;
  onSendMessage: (
    text: string,
    attachments: ChatAttachment[],
    useWebSearch: boolean
  ) => Promise<void>;
  onCancelStream: () => void;
  onToggleSuggestedQa: (suggestion: ParsedQaSuggestion, checked: boolean) => void;
  onTranscribeAudio: (blob: Blob) => Promise<string>;
}

function MessageBody({ content }: { content: string }) {
  const segments = useMemo(() => parseMessageSegments(content), [content]);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  return (
    <div className="space-y-3 text-[15px] leading-relaxed break-words">
      {segments.map((seg, idx) => {
        if (seg.type === 'code') {
          return (
            <div
              key={idx}
              className="rounded-lg border border-slate-200 dark:border-slate-700/80 bg-slate-900 dark:bg-slate-950 text-slate-100 overflow-hidden"
            >
              <div className="px-3 py-1.5 border-b border-slate-800 flex items-center justify-between text-xs text-slate-400">
                <span className="font-mono">{seg.language || 'code'}</span>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard?.writeText(seg.content);
                    setCopiedIdx(idx);
                    setTimeout(() => setCopiedIdx(null), 1400);
                  }}
                  aria-label="Copy code block"
                  className="inline-flex items-center gap-1 hover:text-slate-200 transition-colors"
                >
                  {copiedIdx === idx ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedIdx === idx ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
              <pre className="p-3 overflow-x-auto text-xs leading-relaxed font-mono">
                <code>{seg.content}</code>
              </pre>
            </div>
          );
        }
        return (
          <div key={idx} className="whitespace-pre-wrap">
            {seg.content}
          </div>
        );
      })}
    </div>
  );
}

export function ChatTab({
  chatId,
  chatTitle,
  messages,
  savedQuestions,
  streamingText,
  isStreaming,
  isSearchingWeb,
  errorBanner,
  onDismissError,
  input,
  onChangeInput,
  attachments,
  onRemoveAttachment,
  onClearAttachments,
  onProcessFiles,
  webSearchArmed,
  onClearWebSearch,
  onSendMessage,
  onCancelStream,
  onToggleSuggestedQa,
  onTranscribeAudio,
}: ChatTabProps) {
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<{ src: string; name: string } | null>(null);
  const [showJumpBottom, setShowJumpBottom] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const latestInputRef = useRef(input);
  latestInputRef.current = input;

  // Auto-focus composer when switching chats
  useEffect(() => {
    textareaRef.current?.focus();
    setShowJumpBottom(false);
  }, [chatId]);

  // Auto-grow composer vertically on input changes and keep scrollbar hidden until max height
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const borderHeight = el.offsetHeight - el.clientHeight;
    el.style.height = '36px';
    const { heightPx, overflowY } = computeComposerLayout(el.scrollHeight, borderHeight);
    el.style.height = `${heightPx}px`;
    el.style.overflowY = overflowY;
  }, [input, chatId]);

  // Close lightbox on Escape
  useEffect(() => {
    if (!lightboxImage) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxImage(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxImage]);

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 180) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, streamingText]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowJumpBottom(distance > 140);
  };

  const handlePaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      await onProcessFiles(imageFiles);
    }
  };

  const handleDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingOver(false);
    if (e.dataTransfer?.files?.length) {
      await onProcessFiles(e.dataTransfer.files);
    }
  };

  const handleToggleMic = async () => {
    setMicError(null);
    if (isRecording) {
      mediaRecorderRef.current?.stop();
      setIsRecording(false);
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setMicError('Microphone recording is not supported in this browser.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) audioChunksRef.current.push(ev.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size === 0) return;
        setIsTranscribing(true);
        try {
          const transcript = await onTranscribeAudio(blob);
          if (transcript) {
            const cur = latestInputRef.current;
            onChangeInput(cur.trim() ? `${cur.trimEnd()} ${transcript}` : transcript);
            textareaRef.current?.focus();
          }
        } catch (err) {
          setMicError((err as Error).message || 'Transcription failed');
        } finally {
          setIsTranscribing(false);
        }
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
    } catch (err) {
      setMicError((err as Error).message || 'Could not access microphone');
    }
  };

  const submitMessage = async () => {
    if (isStreaming) return;
    const text = input.trim();
    if (!text && attachments.length === 0) return;
    const useSearch = webSearchArmed;
    const atts = [...attachments];
    onChangeInput('');
    onClearAttachments();
    onClearWebSearch();
    await onSendMessage(text, atts, useSearch);
  };

  const savedQuestionNormalized = useMemo(
    () => new Set(savedQuestions.map((q) => q.question.trim().toLowerCase())),
    [savedQuestions]
  );

  return (
    <div
      className="relative flex-1 min-h-0 flex flex-col bg-slate-50 dark:bg-slate-950"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDraggingOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setIsDraggingOver(false);
        }
      }}
      onDrop={handleDrop}
    >
      {/* Top dismissible error banner */}
      {errorBanner ? (
        <div
          role="alert"
          className="shrink-0 pl-16 pr-4 py-2.5 bg-red-50 dark:bg-red-950/70 border-b border-red-200 dark:border-red-900 flex items-center justify-between gap-3 text-sm text-red-800 dark:text-red-200"
        >
          <span className="truncate">{errorBanner}</span>
          <button
            type="button"
            onClick={onDismissError}
            aria-label="Dismiss error"
            className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-red-100 dark:hover:bg-red-900/60 shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : null}

      {/* Scrollable Message List */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto pl-16 pr-4 sm:pr-6 pt-6 pb-6"
      >
        <div className="max-w-4xl mx-auto space-y-6">
          {messages.length === 0 && streamingText === null ? (
            <div className="py-16 text-center max-w-lg mx-auto space-y-3">
              <div className="w-10 h-10 mx-auto rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center justify-center text-sky-600 dark:text-sky-400">
                <BookOpen className="w-5 h-5" />
              </div>
              <h1 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
                {chatTitle}
              </h1>
              <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                Ask a question, paste lecture screenshots, or attach study notes. Your conversation memory, per-chat notes, and global textbook stay synchronized automatically.
              </p>
            </div>
          ) : null}

          {messages.map((msg) => {
            if (msg.memoryStage) {
              return (
                <div
                  key={msg.id}
                  className="max-w-3xl mx-auto p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/60 text-xs text-slate-600 dark:text-slate-300 space-y-1"
                >
                  <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 font-medium">
                    <span>Legacy Embedded Memory · Stage {msg.memoryStage}</span>
                    <span className="tabular-nums">{formatRelativeTime(msg.createdAt)}</span>
                  </div>
                  <p className="leading-relaxed text-slate-700 dark:text-slate-300">{msg.content}</p>
                </div>
              );
            }

            const isUser = msg.role === 'user';
            const suggestions = !isUser ? parseQaSuggestions(msg.content) : [];

            return (
              <div key={msg.id} className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
                <div
                  className={`rounded-xl px-4 py-3 border ${
                    isUser
                      ? 'max-w-2xl bg-sky-600 dark:bg-sky-700 text-white border-sky-700 dark:border-sky-600'
                      : 'max-w-3xl w-full bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 border-slate-200 dark:border-slate-800'
                  }`}
                >
                  <MessageBody content={msg.content} />

                  {/* Image attachment thumbnails */}
                  {msg.attachments && msg.attachments.some((a) => a.kind === 'image' && a.dataUrl) ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {msg.attachments
                        .filter((a) => a.kind === 'image' && a.dataUrl)
                        .map((img) => (
                          <button
                            key={img.id}
                            type="button"
                            onClick={() =>
                              setLightboxImage({ src: img.dataUrl!, name: img.name })
                            }
                            aria-label={`Zoom image ${img.name}`}
                            className="group relative rounded-lg overflow-hidden border border-white/25 dark:border-slate-700 bg-white dark:bg-slate-950 focus-visible:outline-2 focus-visible:outline-sky-500"
                          >
                            <img
                              src={img.dataUrl}
                              alt={img.name}
                              referrerPolicy="no-referrer"
                              className="h-28 w-40 object-cover transition-transform duration-150 group-hover:scale-105"
                            />
                          </button>
                        ))}
                    </div>
                  ) : null}

                  <div
                    className={`mt-2 text-[11px] tabular-nums ${
                      isUser ? 'text-sky-100/90 text-right' : 'text-slate-400 dark:text-slate-500'
                    }`}
                  >
                    {formatRelativeTime(msg.createdAt)}
                  </div>
                </div>

                {/* Q&A Suggestion Cards below assistant reply */}
                {suggestions.length > 0 ? (
                  <div className="mt-2.5 max-w-3xl w-full space-y-2">
                    <div className="text-xs font-medium text-slate-500 dark:text-slate-400 px-1">
                      Suggested Study Questions — check to save to Questions & Flashcards
                    </div>
                    {suggestions.map((item, sIdx) => {
                      const isChecked = savedQuestionNormalized.has(
                        item.question.trim().toLowerCase()
                      );
                      return (
                        <label
                          key={`${msg.id}_qa_${sIdx}`}
                          className={`flex items-start gap-3 p-3.5 rounded-xl border cursor-pointer transition-colors ${
                            isChecked
                              ? 'bg-sky-50/70 dark:bg-sky-950/35 border-sky-300 dark:border-sky-800'
                              : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={(e) => onToggleSuggestedQa(item, e.target.checked)}
                            className="mt-1 h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500 shrink-0"
                          />
                          <div className="min-w-0 space-y-1 text-sm">
                            <div className="font-medium text-slate-900 dark:text-slate-100">
                              {item.question}
                            </div>
                            <div className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed whitespace-pre-wrap">
                              <span className="font-semibold text-slate-700 dark:text-slate-300">
                                Answer:{' '}
                              </span>
                              {item.answer}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}

          {/* Live streaming assistant reply */}
          {streamingText !== null ? (
            <div className="flex flex-col items-start">
              <div className="max-w-3xl w-full rounded-xl px-4 py-3 border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100">
                {streamingText ? (
                  <MessageBody content={streamingText} />
                ) : (
                  <div className="inline-flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                    <Loader2 className="w-4 h-4 animate-spin text-sky-600" />
                    <span>Thinking…</span>
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Jump-to-bottom button */}
      {showJumpBottom ? (
        <button
          type="button"
          onClick={() => scrollToBottom('smooth')}
          aria-label="Jump to bottom"
          className="absolute bottom-16 right-6 z-20 h-9 px-3 rounded-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-md text-xs font-medium text-slate-700 dark:text-slate-200 inline-flex items-center gap-1.5 hover:bg-slate-50 dark:hover:bg-slate-800"
        >
          <ArrowDown className="w-3.5 h-3.5" />
          <span>Jump to bottom</span>
        </button>
      ) : null}

      {/* Drag-over indicator */}
      {isDraggingOver ? (
        <div className="absolute inset-4 z-30 rounded-xl border-2 border-dashed border-sky-500 bg-sky-50/90 dark:bg-sky-950/85 flex items-center justify-center pointer-events-none">
          <p className="font-display text-base font-semibold text-sky-800 dark:text-sky-200">
            Drop images or text files to attach
          </p>
        </div>
      ) : null}

      {/* Optional hints & attachment thumbnails above the single-row bottom bar */}
      {isSearchingWeb || webSearchArmed || micError || attachments.length > 0 ? (
        <div className="shrink-0 border-t border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 px-4 sm:px-6 py-2 space-y-2">
          {isSearchingWeb ? (
            <div className="flex items-center gap-2 text-xs text-sky-700 dark:text-sky-300 font-medium">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Searching the web with Tavily before sending…</span>
            </div>
          ) : webSearchArmed ? (
            <div className="text-xs text-sky-700 dark:text-sky-300 font-medium">
              Web search enabled — next message will include live Tavily results.
            </div>
          ) : null}

          {micError ? (
            <div className="text-xs text-red-600 dark:text-red-400">{micError}</div>
          ) : null}

          {attachments.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {attachments.map((att) => (
                <div
                  key={att.id}
                  className="relative group rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden bg-slate-50 dark:bg-slate-800"
                >
                  {att.dataUrl ? (
                    <img
                      src={att.dataUrl}
                      alt={att.name}
                      referrerPolicy="no-referrer"
                      className="h-14 w-20 object-cover"
                    />
                  ) : null}
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(att.id)}
                    aria-label={`Remove ${att.name}`}
                    className="absolute top-1 right-1 h-5 w-5 rounded-full bg-slate-900/75 text-white inline-flex items-center justify-center hover:bg-slate-900"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Single-row bottom bar: Mic + auto-growing textbox */}
      <footer className="shrink-0 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 sm:px-4 py-2 flex items-end gap-2 select-none">
        <button
          type="button"
          onClick={handleToggleMic}
          disabled={isTranscribing}
          aria-label={
            isRecording
              ? 'Stop recording'
              : isTranscribing
              ? 'Transcribing audio'
              : 'Voice input'
          }
          title="Voice transcription (STT)"
          className={`h-9 w-9 inline-flex items-center justify-center rounded-lg border transition-colors shrink-0 focus-visible:outline-2 focus-visible:outline-sky-600 ${
            isRecording
              ? 'bg-red-600 border-red-600 text-white hover:bg-red-700'
              : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          {isTranscribing ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : isRecording ? (
            <MicOff className="w-4 h-4" />
          ) : (
            <Mic className="w-4 h-4" />
          )}
        </button>

        <div className="flex-1 min-w-0 flex items-end gap-1.5">
          <label htmlFor="chat-composer-input" className="sr-only">
            Ask your study tutor
          </label>
          <textarea
            id="chat-composer-input"
            ref={textareaRef}
            rows={1}
            value={input}
            onChange={(e) => onChangeInput(e.target.value)}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submitMessage();
              }
            }}
            placeholder="Ask a question, paste an image, or press Enter to send…"
            className="w-full min-h-9 resize-none overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/60 px-3 py-1.5 text-sm leading-[22px] text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-sky-500 dark:focus:border-sky-500 transition-colors"
          />
          {isStreaming ? (
            <button
              type="button"
              onClick={onCancelStream}
              aria-label="Stop generating"
              title="Stop generating"
              className="h-9 px-2.5 rounded-lg bg-slate-800 dark:bg-slate-700 hover:bg-slate-900 text-white text-xs font-medium inline-flex items-center gap-1.5 shrink-0 transition-colors"
            >
              <Square className="w-3 h-3 fill-current" />
              <span>Stop</span>
            </button>
          ) : null}
        </div>
      </footer>

      {/* Image Zoom Lightbox */}
      {lightboxImage ? (
        <div
          className="fixed inset-0 z-50 bg-slate-950/80 flex items-center justify-center p-6"
          onClick={() => setLightboxImage(null)}
        >
          <div
            className="relative max-w-4xl max-h-[90vh] flex flex-col items-center gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setLightboxImage(null)}
              aria-label="Close image zoom"
              className="self-end h-9 px-3 rounded-lg bg-slate-900/90 text-white text-xs font-medium inline-flex items-center gap-1.5 hover:bg-slate-800"
            >
              <X className="w-4 h-4" />
              <span>Close</span>
            </button>
            <img
              src={lightboxImage.src}
              alt={lightboxImage.name}
              referrerPolicy="no-referrer"
              className="max-w-full max-h-[80vh] rounded-xl bg-white object-contain shadow-2xl"
            />
            <div className="text-xs text-slate-300">{lightboxImage.name}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
