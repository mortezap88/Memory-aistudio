import { useEffect, useRef, useState, type DragEvent } from 'react';
import { AlertTriangle, CheckCircle2, ImagePlus, Loader2, Trash2 } from 'lucide-react';
import type { ChatAttachment, TextbookData } from '../types/talk';
import { TEXTBOOK_MAX_CHARS } from '../utils/memoryEngine';
import { createId } from '../utils/formatters';

interface TextbookTabProps {
  textbook: TextbookData;
  onSaveTextbook: (next: TextbookData) => Promise<void>;
}

type SaveStatus = 'saved' | 'saving' | 'failed';
const MAX_IMAGES = 8;

export function TextbookTab({ textbook, onSaveTextbook }: TextbookTabProps) {
  const [title, setTitle] = useState(textbook.title);
  const [body, setBody] = useState(textbook.body);
  const [images, setImages] = useState<ChatAttachment[]>(textbook.images);
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [isDragging, setIsDragging] = useState(false);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setTitle(textbook.title);
    setBody(textbook.body);
    setImages(textbook.images);
  }, [textbook.title, textbook.body, textbook.images]);

  const scheduleSave = (nextTitle: string, nextBody: string, nextImages: ChatAttachment[]) => {
    setStatus('saving');
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      try {
        await onSaveTextbook({
          title: nextTitle,
          body: nextBody,
          images: nextImages,
          updatedAt: Date.now(),
        });
        setStatus('saved');
      } catch {
        setStatus('failed');
      }
    }, 600);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleImageDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer?.files || []).filter((f) =>
      f.type.startsWith('image/')
    );
    if (files.length === 0) return;

    const remaining = Math.max(0, MAX_IMAGES - images.length);
    const accepted = files.slice(0, remaining);

    accepted.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = typeof reader.result === 'string' ? reader.result : '';
        if (!dataUrl) return;
        setImages((prev) => {
          if (prev.length >= MAX_IMAGES) return prev;
          const next = [
            ...prev,
            {
              id: createId('tbimg'),
              kind: 'image' as const,
              name: file.name || 'textbook-page.png',
              mimeType: file.type,
              dataUrl,
            },
          ];
          scheduleSave(title, body, next);
          return next;
        });
      };
      reader.readAsDataURL(file);
    });
  };

  const removeImage = (id: string) => {
    const next = images.filter((img) => img.id !== id);
    setImages(next);
    scheduleSave(title, body, next);
  };

  const isClipped = body.length > TEXTBOOK_MAX_CHARS;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-slate-50 dark:bg-slate-950 pl-16 pr-4 sm:pr-6 py-6">
      <div className="max-w-4xl mx-auto space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
              Global Textbook Reference
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Shared across all chats as an authoritative reference. Text clips at 6,000 chars; pages attach to your latest prompt.
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
            <label htmlFor="textbook-title" className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
              Document Title
            </label>
            <input
              id="textbook-title"
              type="text"
              value={title}
              onChange={(e) => {
                const v = e.target.value;
                setTitle(v);
                scheduleSave(v, body, images);
              }}
              placeholder="Textbook or course guide title…"
              className="w-full px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/60 text-sm font-medium text-slate-900 dark:text-slate-100 focus:outline-none focus:border-sky-500"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="textbook-body" className="text-xs font-medium text-slate-600 dark:text-slate-400">
                Authoritative Text
              </label>
              <span
                className={`text-xs tabular-nums ${
                  isClipped
                    ? 'text-amber-700 dark:text-amber-400 font-medium'
                    : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                {body.length.toLocaleString()} / {TEXTBOOK_MAX_CHARS.toLocaleString()} chars
                {isClipped ? ' (clipped in prompts)' : ''}
              </span>
            </div>
            <textarea
              id="textbook-body"
              rows={12}
              value={body}
              onChange={(e) => {
                const v = e.target.value;
                setBody(v);
                scheduleSave(title, v, images);
              }}
              placeholder="Paste authoritative textbook excerpts, definitions, or theorems…"
              className="w-full px-3.5 py-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/60 text-sm text-slate-900 dark:text-slate-100 leading-relaxed focus:outline-none focus:border-sky-500 resize-y"
            />
          </div>

          {/* Drag-and-drop only image zone at the bottom, max 8 */}
          <div className="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                Authoritative Textbook Pages (drag-and-drop only)
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                {images.length} / {MAX_IMAGES} images
              </span>
            </div>

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleImageDrop}
              className={`rounded-xl border-2 border-dashed p-5 transition-colors ${
                isDragging
                  ? 'border-sky-500 bg-sky-50/70 dark:bg-sky-950/40'
                  : 'border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-950/40'
              }`}
            >
              {images.length === 0 ? (
                <div className="py-4 text-center space-y-1.5">
                  <ImagePlus className="w-6 h-6 mx-auto text-slate-400 dark:text-slate-500" />
                  <p className="text-xs font-medium text-slate-600 dark:text-slate-300">
                    Drag and drop textbook page images here (max {MAX_IMAGES})
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {images.map((img) => (
                    <div
                      key={img.id}
                      className="group relative rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden bg-white dark:bg-slate-900"
                    >
                      {img.dataUrl ? (
                        <img
                          src={img.dataUrl}
                          alt={img.name}
                          referrerPolicy="no-referrer"
                          className="h-28 w-full object-cover"
                        />
                      ) : null}
                      <div className="px-2 py-1 text-[11px] text-slate-600 dark:text-slate-300 truncate border-t border-slate-100 dark:border-slate-800">
                        {img.name}
                      </div>
                      <button
                        type="button"
                        onClick={() => removeImage(img.id)}
                        aria-label={`Remove ${img.name}`}
                        className="absolute top-1.5 right-1.5 h-7 w-7 rounded-md bg-slate-900/75 text-white inline-flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity hover:bg-red-600"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
