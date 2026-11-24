import { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Brain,
  Database,
  FileText,
  Globe,
  HelpCircle,
  Loader2,
  Menu,
  MessageSquare,
  Paperclip,
  Settings,
} from 'lucide-react';
import type { ModeTab, ThinkingLevel } from '../types/talk';

interface WorkspaceRailProps {
  showSessionButton: boolean;
  onOpenSessionDrawer: () => void;
  activeTab: ModeTab;
  onSelectTab: (tab: ModeTab) => void;
  onAttachFilesClick: () => void;
  webSearchArmed: boolean;
  onToggleWebSearch: () => void;
  thinkingLevel: ThinkingLevel;
  onSelectThinkingLevel: (level: ThinkingLevel) => void;
  isMemoryOpen: boolean;
  onOpenMemory: () => void;
  isCompacting: boolean;
  memoryError?: string;
  onOpenSettings: () => void;
  questionCount: number;
}

const TABS: Array<{ id: ModeTab; label: string; Icon: typeof MessageSquare }> = [
  { id: 'chat', label: 'Chat', Icon: MessageSquare },
  { id: 'notes', label: 'Notes', Icon: FileText },
  { id: 'textbook', label: 'Textbook', Icon: BookOpen },
  { id: 'questions', label: 'Questions', Icon: HelpCircle },
];

const THINKING_OPTIONS: Array<{ id: ThinkingLevel; label: string; description: string }> = [
  { id: 'low', label: 'Low', description: 'Fastest responses' },
  { id: 'medium', label: 'Medium', description: 'Balanced reasoning' },
  { id: 'high', label: 'High', description: 'Deep reasoning' },
  { id: 'xhigh', label: 'XHigh', description: 'Maximum reasoning depth' },
];

const THINKING_LABEL: Record<ThinkingLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
};

export function WorkspaceRail({
  showSessionButton,
  onOpenSessionDrawer,
  activeTab,
  onSelectTab,
  onAttachFilesClick,
  webSearchArmed,
  onToggleWebSearch,
  thinkingLevel,
  onSelectThinkingLevel,
  isMemoryOpen,
  onOpenMemory,
  isCompacting,
  memoryError,
  onOpenSettings,
  questionCount,
}: WorkspaceRailProps) {
  const [isThinkingOpen, setIsThinkingOpen] = useState(false);
  const thinkingContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isThinkingOpen) return;

    const handlePointerDown = (e: PointerEvent) => {
      if (
        thinkingContainerRef.current &&
        !thinkingContainerRef.current.contains(e.target as Node)
      ) {
        setIsThinkingOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsThinkingOpen(false);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isThinkingOpen]);

  const isElevatedThinking = thinkingLevel === 'high' || thinkingLevel === 'xhigh';

  return (
    <div className="absolute top-3 left-3 z-30 flex flex-col items-center gap-1.5 select-none">
      {showSessionButton ? (
        <button
          type="button"
          onClick={onOpenSessionDrawer}
          aria-label="Open Chat Manager"
          aria-expanded={false}
          title="Chat Manager"
          className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xs shadow-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white transition-colors focus-visible:outline-2 focus-visible:outline-sky-600"
        >
          <Menu className="w-4 h-4" />
        </button>
      ) : null}

      <div className="w-9 flex flex-col items-center gap-1 py-1 rounded-lg bg-slate-100/95 dark:bg-slate-800/90 border border-slate-200/80 dark:border-slate-700/70 backdrop-blur-xs shadow-xs">
        <nav
          role="tablist"
          aria-orientation="vertical"
          aria-label="Study workspace sections"
          className="flex flex-col items-center gap-1"
        >
          {TABS.map(({ id, label, Icon }) => {
            const isActive = activeTab === id;
            const accessibleName =
              id === 'questions' && questionCount > 0 ? `${label} (${questionCount})` : label;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-label={accessibleName}
                title={accessibleName}
                onClick={() => onSelectTab(id)}
                className={`relative h-7 w-7 inline-flex items-center justify-center rounded-md transition-colors shrink-0 focus-visible:outline-2 focus-visible:outline-sky-600 ${
                  isActive
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-50 shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <Icon className="w-4 h-4" />
                {id === 'questions' && questionCount > 0 ? (
                  <span
                    aria-hidden="true"
                    className="absolute -top-1.5 -right-1.5 min-w-3.5 h-3.5 px-1 rounded-full bg-sky-600 text-white text-[9px] font-semibold inline-flex items-center justify-center tabular-nums ring-2 ring-slate-100 dark:ring-slate-800"
                  >
                    {questionCount}
                  </span>
                ) : null}
              </button>
            );
          })}
        </nav>

        <button
          type="button"
          onClick={onOpenMemory}
          aria-label={
            isCompacting
              ? 'Memory updating'
              : memoryError
              ? 'Open Memory dialog (compaction error)'
              : 'Open Memory dialog'
          }
          aria-expanded={isMemoryOpen}
          title={
            memoryError
              ? `Memory error: ${memoryError}`
              : isCompacting
              ? 'Updating memory…'
              : 'Memory system'
          }
          className={`relative h-7 w-7 inline-flex items-center justify-center rounded-md transition-colors shrink-0 focus-visible:outline-2 focus-visible:outline-sky-600 ${
            isMemoryOpen
              ? 'bg-white dark:bg-slate-900 text-sky-700 dark:text-sky-300 shadow-xs'
              : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          {isCompacting ? (
            <Loader2 className="w-4 h-4 animate-spin text-sky-600 dark:text-sky-400" />
          ) : (
            <Database className="w-4 h-4" />
          )}
          {memoryError ? (
            <span
              aria-label="Memory compaction failed"
              className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-red-600 ring-2 ring-slate-100 dark:ring-slate-800"
            />
          ) : null}
        </button>
      </div>

      <div className="flex flex-col items-center gap-1">
        <button
          type="button"
          onClick={onAttachFilesClick}
          aria-label="Attach files"
          title="Attach image or text file"
          className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xs shadow-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white transition-colors shrink-0 focus-visible:outline-2 focus-visible:outline-sky-600"
        >
          <Paperclip className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={onToggleWebSearch}
          aria-label="Web search"
          aria-pressed={webSearchArmed}
          title="Toggle Tavily web search for next message"
          className={`h-9 w-9 inline-flex items-center justify-center rounded-lg border backdrop-blur-xs shadow-xs transition-colors shrink-0 focus-visible:outline-2 focus-visible:outline-sky-600 ${
            webSearchArmed
              ? 'bg-sky-50 dark:bg-sky-950/80 border-sky-300 dark:border-sky-700 text-sky-700 dark:text-sky-300'
              : 'border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          <Globe className="w-4 h-4" />
        </button>

        <div ref={thinkingContainerRef} className="relative h-9 w-9 shrink-0">
          <div
            data-testid="thinking-expander"
            data-expanded={isThinkingOpen ? 'true' : 'false'}
            className={`absolute left-0 top-0 z-40 h-9 w-max inline-flex items-center rounded-lg border backdrop-blur-xs overflow-hidden transition-all duration-200 ease-out origin-left ${
              isThinkingOpen
                ? 'border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 shadow-md pr-1.5'
                : isElevatedThinking
                ? 'bg-sky-50 dark:bg-sky-950/80 border-sky-300 dark:border-sky-700 shadow-xs'
                : 'border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 shadow-xs'
            }`}
          >
            <button
              type="button"
              onClick={() => setIsThinkingOpen((prev) => !prev)}
              aria-label={`Thinking: ${THINKING_LABEL[thinkingLevel]}`}
              aria-expanded={isThinkingOpen}
              title={`Thinking: ${THINKING_LABEL[thinkingLevel]}`}
              className={`h-full w-[34px] inline-flex items-center justify-center shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-sky-600 ${
                isElevatedThinking
                  ? 'text-sky-700 dark:text-sky-300 hover:bg-sky-100/70 dark:hover:bg-sky-900/50'
                  : thinkingLevel === 'low'
                  ? 'text-slate-400 dark:text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-300'
                  : 'text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Brain className="w-4 h-4" />
            </button>

            <div
              role="radiogroup"
              aria-label="Thinking depth"
              aria-hidden={!isThinkingOpen}
              className={`grid transition-[grid-template-columns,opacity,visibility] duration-200 ease-out ${
                isThinkingOpen
                  ? 'grid-cols-[1fr] opacity-100 visible'
                  : 'grid-cols-[0fr] opacity-0 invisible pointer-events-none'
              }`}
            >
              <div className="min-w-0 overflow-hidden flex items-center gap-0.5 whitespace-nowrap">
                <span className="h-4 w-px bg-slate-200 dark:bg-slate-700 mr-1 shrink-0" />
                {THINKING_OPTIONS.map((option) => {
                  const selected = thinkingLevel === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      tabIndex={isThinkingOpen ? 0 : -1}
                      title={option.description}
                      onClick={() => {
                        onSelectThinkingLevel(option.id);
                        setIsThinkingOpen(false);
                      }}
                      className={`h-7 px-2 rounded-md text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-sky-600 ${
                        selected
                          ? 'bg-sky-600 text-white shadow-xs'
                          : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                      }`}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={onOpenSettings}
        aria-label="Open Settings"
        title="Settings"
        className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xs shadow-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white transition-colors shrink-0 focus-visible:outline-2 focus-visible:outline-sky-600"
      >
        <Settings className="w-4 h-4" />
      </button>
    </div>
  );
}
