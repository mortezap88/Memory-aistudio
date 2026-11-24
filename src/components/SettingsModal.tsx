import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun, X } from 'lucide-react';
import type { AiProvider, ThemeMode } from '../types/talk';

interface SettingsModalProps {
  isOpen: boolean;
  currentTheme: ThemeMode;
  currentProvider: AiProvider;
  onSave: (theme: ThemeMode, provider: AiProvider) => void;
  onClose: () => void;
}

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string; icon: typeof Monitor }> = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

const PROVIDER_OPTIONS: Array<{ value: AiProvider; label: string; detail: string }> = [
  {
    value: 'gemini',
    label: 'Gemini',
    detail: 'gemini-4-hydrogen (chat & memory) + gemini-3.5-transcribe (mic STT)',
  },
  {
    value: 'hormouz',
    label: 'Hormouz',
    detail: 'openai/gpt-6-luna + microsoft/mai-transcribe-2',
  },
];

export function SettingsModal({
  isOpen,
  currentTheme,
  currentProvider,
  onSave,
  onClose,
}: SettingsModalProps) {
  const [draftTheme, setDraftTheme] = useState<ThemeMode>(currentTheme);
  const [draftProvider, setDraftProvider] = useState<AiProvider>(currentProvider);

  useEffect(() => {
    if (isOpen) {
      setDraftTheme(currentTheme);
      setDraftProvider(currentProvider);
    }
  }, [isOpen, currentTheme, currentProvider]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const activeProviderDetail =
    PROVIDER_OPTIONS.find((p) => p.value === draftProvider)?.detail || '';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/40 backdrop-blur-[1px]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl overflow-hidden"
      >
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h2 id="settings-modal-title" className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
            Settings
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Settings"
            className="h-8 w-8 inline-flex items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          <div>
            <div className="text-sm font-medium text-slate-900 dark:text-slate-100 mb-2">
              Appearance
            </div>
            <div
              role="radiogroup"
              aria-label="Appearance theme"
              className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
            >
              {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
                const selected = draftTheme === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setDraftTheme(value)}
                    className={`py-2 px-3 rounded-md text-sm font-medium inline-flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap ${
                      selected
                        ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-50 shadow-xs'
                        : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              Choose how Talk looks across sessions. System follows your operating system preference.
            </p>
          </div>

          <div>
            <div className="text-sm font-medium text-slate-900 dark:text-slate-100 mb-2">
              AI Model Provider
            </div>
            <div
              role="radiogroup"
              aria-label="AI Model Provider"
              className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
            >
              {PROVIDER_OPTIONS.map(({ value, label }) => {
                const selected = draftProvider === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setDraftProvider(value)}
                    className={`py-2 px-3 rounded-md text-sm font-medium inline-flex items-center justify-center transition-colors whitespace-nowrap ${
                      selected
                        ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-50 shadow-xs'
                        : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                    }`}
                  >
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400 font-mono">
              {activeProviderDetail}
            </p>
          </div>
        </div>

        <div className="px-5 py-3.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-800 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave(draftTheme, draftProvider)}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-sky-600 hover:bg-sky-700 text-white transition-colors"
          >
            Save settings
          </button>
        </div>
      </div>
    </div>
  );
}
