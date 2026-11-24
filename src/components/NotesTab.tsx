import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, AlertTriangle, Loader2, X } from 'lucide-react';
import type { NoteData } from '../types/talk';

interface NotesTabProps {
  chatId: string;
  note: NoteData;
  onSaveNote: (chatId: string, nextNote: NoteData) => Promise<void>;
}

type SaveStatus = 'saved' | 'saving' | 'failed';

export function NotesTab({ chatId, note, onSaveNote }: NotesTabProps) {
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [tags, setTags] = useState<string[]>(note.tags);
  const [tagInput, setTagInput] = useState('');
  const [status, setStatus] = useState<SaveStatus>('saved');

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeChatRef = useRef(chatId);

  useEffect(() => {
    activeChatRef.current = chatId;
    setTitle(note.title);
    setBody(note.body);
    setTags(note.tags);
    setTagInput('');
    setStatus('saved');
    if (timerRef.current) clearTimeout(timerRef.current);
  }, [chatId, note.title, note.body, note.tags]);

  const scheduleSave = (nextTitle: string, nextBody: string, nextTags: string[]) => {
    setStatus('saving');
    if (timerRef.current) clearTimeout(timerRef.current);
    const targetChatId = chatId;
    timerRef.current = setTimeout(async () => {
      try {
        await onSaveNote(targetChatId, {
          title: nextTitle,
          body: nextBody,
          tags: nextTags,
          updatedAt: Date.now(),
        });
        if (activeChatRef.current === targetChatId) {
          setStatus('saved');
        }
      } catch {
        if (activeChatRef.current === targetChatId) {
          setStatus('failed');
        }
      }
    }, 600);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const addTag = () => {
    const clean = tagInput.trim().replace(/,$/, '');
    if (!clean) return;
    if (!tags.includes(clean)) {
      const nextTags = [...tags, clean];
      setTags(nextTags);
      scheduleSave(title, body, nextTags);
    }
    setTagInput('');
  };

  const removeTag = (tagToRemove: string) => {
    const nextTags = tags.filter((t) => t !== tagToRemove);
    setTags(nextTags);
    scheduleSave(title, body, nextTags);
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-slate-50 dark:bg-slate-950 pl-16 pr-4 sm:pr-6 py-6">
      <div className="max-w-4xl mx-auto space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
              Conversation Notes
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Injected into the tutor prompt as notes for this conversation.
            </p>
          </div>
          <div className="flex items-center gap-1.5 text-xs font-medium shrink-0">
            {status === 'saving' ? (
              <span className="inline-flex items-center gap-1.5 text-sky-600 dark:text-sky-400">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Saving…</span>
              </span>
            ) : status === 'failed' ? (
              <span className="inline-flex items-center gap-1.5 text-red-600 dark:text-red-400">
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>Save failed</span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Saved on server</span>
              </span>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
          <div>
            <label htmlFor="note-title" className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
              Title
            </label>
            <input
              id="note-title"
              type="text"
              value={title}
              onChange={(e) => {
                const v = e.target.value;
                setTitle(v);
                scheduleSave(v, body, tags);
              }}
              placeholder="Note title…"
              className="w-full px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/60 text-sm font-medium text-slate-900 dark:text-slate-100 focus:outline-none focus:border-sky-500"
            />
          </div>

          <div>
            <label htmlFor="note-tags" className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
              Tags
            </label>
            <div className="flex flex-wrap items-center gap-2">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 text-xs font-medium text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md px-2 py-1"
                >
                  <span>{tag}</span>
                  <button
                    type="button"
                    onClick={() => removeTag(tag)}
                    aria-label={`Remove tag ${tag}`}
                    className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-100"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
              <input
                id="note-tags"
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    addTag();
                  }
                }}
                onBlur={addTag}
                placeholder="Add tag + Enter…"
                className="px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/60 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:border-sky-500"
              />
            </div>
          </div>

          <div>
            <label htmlFor="note-body" className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
              Body
            </label>
            <textarea
              id="note-body"
              rows={14}
              value={body}
              onChange={(e) => {
                const v = e.target.value;
                setBody(v);
                scheduleSave(title, v, tags);
              }}
              placeholder="Write key formulas, exam takeaways, or reminders for this chat…"
              className="w-full px-3.5 py-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/60 text-sm text-slate-900 dark:text-slate-100 leading-relaxed focus:outline-none focus:border-sky-500 resize-y"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
