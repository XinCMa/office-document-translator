import React, { useState, useEffect, useRef } from 'react';
import { Search, Edit3, CheckCircle2, AlertTriangle, ShieldCheck, Check, X, Filter, Loader2, ArrowUp, ArrowDown, ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { DocumentType, ExtractedTextItem, GlossaryTerm, ProjectSummary, TranslationProgress } from '../types';
import { isGlossaryTermMatch } from '../lib/glossary';

interface ReviewTableProps {
  projectId?: string;
  textItems: ExtractedTextItem[];
  onUpdateItem: (originalText: string, translatedText: string) => Promise<void>;
  isUpdatingItem: string | null;
  isTranslating?: boolean;
  translationProgress?: TranslationProgress;
  translationStatus?: ProjectSummary['status'];
  onPauseTranslation?: () => Promise<void>;
  onResumeTranslation?: () => Promise<void>;
  onNextStep: () => void;
  onPrevStep?: () => void;
  onTranslatePending?: () => Promise<void>;
  glossary?: GlossaryTerm[];
  recentChangedKeys?: string[];
  sourceLang?: string;
  targetLang?: string;
  documentType?: DocumentType;
}

// Escaping utility for keywords in regex
function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Case-insensitive literal substring matching. Characters in the query must
// appear contiguously and in the same order; fuzzy subsequence matching is not allowed.
export function isLiteralSearchMatch(text: string | null | undefined, search: string): boolean {
  const normalizedSearch = search.trim().toLocaleLowerCase();
  if (!normalizedSearch) return true;
  return String(text || '').toLocaleLowerCase().includes(normalizedSearch);
}

function displayLanguageLabel(language: string | null | undefined): string {
  const normalized = String(language || '').toLowerCase();
  if (normalized.includes('chinese')) return '中文';
  if (normalized.includes('english')) return '英文';
  if (normalized.includes('italian')) return '意大利语';
  if (normalized.includes('arabic')) return '阿拉伯语';
  return language || '原语言';
}

function displayPageNumber(pageNumber: number | null | undefined, documentType?: DocumentType): string {
  if (documentType === 'docx') return '—';
  return pageNumber && pageNumber > 0 ? String(pageNumber) : '—';
}

export default function ReviewTable({
  projectId,
  textItems,
  onUpdateItem,
  isUpdatingItem,
  isTranslating = false,
  translationProgress,
  translationStatus,
  onPauseTranslation,
  onResumeTranslation,
  onNextStep,
  onPrevStep,
  onTranslatePending,
  glossary = [],
  recentChangedKeys = [],
  sourceLang,
  targetLang,
  documentType
}: ReviewTableProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [replaceTerm, setReplaceTerm] = useState('');
  const [slideFilter, setSlideFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [isReplacingAll, setIsReplacingAll] = useState(false);
  const [scrollControlDirection, setScrollControlDirection] = useState<'up' | 'down' | null>(null);
  const [completionDialog, setCompletionDialog] = useState<{
    type: 'complete' | 'pending';
    pendingCount: number;
    translatedCount: number;
    totalCount: number;
  } | null>(null);
  const wasTranslatingRef = useRef(false);
  const currentRunKeyRef = useRef<string | null>(null);
  const promptedRunKeyRef = useRef<string | null>(null);

  // Track currently edited item ID
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingTranslatedValue, setEditingTranslatedValue] = useState('');
  const isPausing = translationStatus === 'pausing';
  const isPaused = translationStatus === 'paused';

  // Show one floating scroll control only after the user has moved a little.
  useEffect(() => {
    let lastScrollY = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop;
    let accumulatedDistance = 0;
    let lastDirection: 'up' | 'down' | null = null;
    const threshold = 48;

    const handleScroll = () => {
      const scrollY = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop;
      const scrollHeight = document.documentElement.scrollHeight || document.body.scrollHeight;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
      const distanceFromBottom = scrollHeight - (scrollY + viewportHeight);
      const canScroll = scrollHeight > viewportHeight + 100;
      const delta = scrollY - lastScrollY;

      if (!canScroll || Math.abs(delta) < 2) {
        lastScrollY = scrollY;
        if (!canScroll) setScrollControlDirection(null);
        return;
      }

      const direction = delta > 0 ? 'down' : 'up';
      accumulatedDistance = direction === lastDirection
        ? accumulatedDistance + Math.abs(delta)
        : Math.abs(delta);
      lastDirection = direction;
      lastScrollY = scrollY;

      if (accumulatedDistance < threshold) return;

      if (direction === 'up' && scrollY > 100) {
        setScrollControlDirection('up');
      } else if (direction === 'down' && distanceFromBottom > 100) {
        setScrollControlDirection('down');
      } else {
        setScrollControlDirection(null);
      }
    };

    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const scrollToBottom = () => {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
  };

  const isWordDocument = documentType === 'docx';
  // Extract list of all unique slide/page markers. DOCX page markers are not reliable,
  // so P3 intentionally hides them and shows an em dash instead.
  const slides = isWordDocument ? [] : Array.from(new Set(textItems.map(item => item.slideNum))).sort((a, b) => a - b);

  // Filter logic
  const filteredItems = textItems.filter(item => {
    const matchesSearch =
      isLiteralSearchMatch(item.originalText, searchTerm) ||
      isLiteralSearchMatch(item.translatedText, searchTerm);

    const matchesSlide = isWordDocument || slideFilter === 'all' || item.slideNum.toString() === slideFilter;
    const matchesStatus = statusFilter === 'all' || item.status === statusFilter;

    return matchesSearch && matchesSlide && matchesStatus;
  });

  const startEditing = (item: ExtractedTextItem) => {
    setEditingItemId(item.id);
    setEditingTranslatedValue(item.translatedText || item.originalText);
  };

  const cancelEditing = () => {
    setEditingItemId(null);
    setEditingTranslatedValue('');
  };

  const saveEditing = async (itemId?: string) => {
    const targetItemId = itemId || editingItemId;
    if (targetItemId !== null) {
      const currentItem = textItems.find(item => item.id === targetItemId);
      if (currentItem) {
        const initialVal = currentItem.translatedText !== undefined ? currentItem.translatedText : currentItem.originalText;
        if (editingTranslatedValue !== initialVal) {
          await onUpdateItem(currentItem.originalText, editingTranslatedValue);
        }
      }
      setEditingItemId(null);
      setEditingTranslatedValue('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>, itemId: string) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveEditing(itemId);
    } else if (e.key === 'Escape') {
      cancelEditing();
    }
  };

  // Replace All Logic
  const handleReplaceAll = async () => {
    if (!searchTerm.trim()) return;
    const literalSearchTerm = searchTerm.trim();

    // Find translated items matching search term currently active in filtered list
    const itemsToReplace = filteredItems.filter(item =>
      isLiteralSearchMatch(item.translatedText, literalSearchTerm)
    );

    if (itemsToReplace.length === 0) return;

    // Filter unique original texts to avoid duplicate endpoint triggers
    const uniqueOriginals = Array.from(new Set(itemsToReplace.map(item => item.originalText)));

    setIsReplacingAll(true);
    try {
      const regex = new RegExp(escapeRegExp(literalSearchTerm), 'gi');
      for (const orig of uniqueOriginals) {
        // Find current loaded translation value matching this original
        const item = textItems.find(t => t.originalText === orig);
        if (item && item.translatedText) {
          const newTranslated = item.translatedText.replace(regex, replaceTerm);
          await onUpdateItem(orig, newTranslated);
        }
      }
    } catch (error) {
      console.error('Replace All execution failed:', error);
    } finally {
      setIsReplacingAll(false);
    }
  };

  // Text highlighting renderer
  const highlightText = (text: string | null | undefined, search: string) => {
    if (!text) return <span className="text-muted-foreground italic">(空)</span>;
    const literalSearchTerm = search.trim();
    if (!literalSearchTerm) return <span>{text}</span>;

    try {
      const regex = new RegExp(`(${escapeRegExp(literalSearchTerm)})`, 'gi');
      const parts = text.split(regex);

      return (
        <span>
          {parts.map((part, i) =>
            part.toLocaleLowerCase() === literalSearchTerm.toLocaleLowerCase() ? (
              <mark key={i} className="bg-sky-200/70 text-sky-950 px-0.5 rounded font-medium border-b border-sky-400">
                {part}
              </mark>
            ) : (
              part
            )
          )}
        </span>
      );
    } catch (e) {
      return <span>{text}</span>;
    }
  };

  // Counting metrics
  const translatedCount = textItems.filter(item =>
    item.translatedText?.trim() && item.status !== 'pending'
  ).length;
  const totalCount = textItems.length;
  const pendingCount = textItems.filter(item => !item.translatedText || item.status === 'pending').length;
  const hasBackfillNeeded = !isTranslating && !isPaused && pendingCount > 0 && translatedCount > 0;

  useEffect(() => {
    wasTranslatingRef.current = false;
    currentRunKeyRef.current = null;
    promptedRunKeyRef.current = null;
    setCompletionDialog(null);
  }, [projectId]);

  useEffect(() => {
    if (isTranslating && !wasTranslatingRef.current) {
      currentRunKeyRef.current = `${projectId || 'project'}:${Date.now()}`;
    }

    if (!isTranslating && !isPaused && wasTranslatingRef.current && currentRunKeyRef.current && totalCount > 0) {
      const runKey = currentRunKeyRef.current;
      if (promptedRunKeyRef.current !== runKey) {
        promptedRunKeyRef.current = runKey;
        setCompletionDialog({
          type: pendingCount > 0 ? 'pending' : 'complete',
          pendingCount,
          translatedCount,
          totalCount
        });
      }
    }

    wasTranslatingRef.current = isTranslating;
  }, [isPaused, isTranslating, pendingCount, projectId, totalCount, translatedCount]);

  const getStatusBadge = (item: ExtractedTextItem) => {
    const status = item.status;
    if (isTranslating && status !== 'edited' && status !== 'preserved' && status !== 'translated') {
      return (
        <span className="px-2.5 py-1 bg-primary/10 text-primary border border-primary/20 rounded-lg text-[10px] font-semibold flex items-center gap-1.5 animate-pulse">
          <span className="h-1.5 w-1.5 bg-primary rounded-full animate-ping" />
          正在翻译 (AI)
        </span>
      );
    }

    const keysToMatch = (recentChangedKeys && recentChangedKeys.length > 0)
      ? recentChangedKeys
      : (glossary || []).map(g => g.source);

    const hasGlossaryMatch = keysToMatch && keysToMatch.some(key =>
      isGlossaryTermMatch(item.originalText, key)
    );

    switch (status) {
      case 'edited':
        return (
          <span className="flex items-center gap-1 rounded-lg border border-warning/30 bg-warning-muted px-2.5 py-1 text-[10px] font-semibold text-warning-foreground">
            <Edit3 className="w-3 h-3" /> 用户修改
          </span>
        );
      case 'translated':
        if (hasGlossaryMatch) {
          return (
            <span className="px-2.5 py-1 bg-blue-50 text-blue-700 border border-blue-200 rounded-lg text-[10px] font-semibold flex items-center gap-1" title="该句已匹配并自动更新您的专属术语转换词牌">
              <CheckCircle2 className="w-3.5 h-3.5 text-blue-500 animate-spin-once" /> 术语已对齐
            </span>
          );
        }
        return (
          <span className="flex items-center gap-1 rounded-lg border border-success/30 bg-success-muted px-2.5 py-1 text-[10px] font-semibold text-success">
            <CheckCircle2 className="w-3 h-3" /> 翻译成功
          </span>
        );
      case 'preserved':
        return (
          <span className="px-2.5 py-1 bg-blue-50 text-blue-700 border border-blue-200 rounded-lg text-[10px] font-semibold flex items-center gap-1">
            <ShieldCheck className="w-3 h-3 text-blue-500" /> 已保留原文
          </span>
        );
      case 'warning':
        return (
          <span className="flex items-center gap-1 rounded-lg border border-destructive/30 bg-destructive-muted px-2.5 py-1 text-[10px] font-semibold text-destructive">
            <AlertTriangle className="w-3 h-3" /> 异常警告
          </span>
        );
      default:
        return (
          <span className="px-2.5 py-1 bg-neutral-100 text-neutral-500 rounded-lg text-[10px] font-semibold">
            待翻译
          </span>
        );
    }
  };

  return (
    <div className="space-y-8">
      <AnimatePresence>
        {completionDialog && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby="translation-completion-title"
              className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-left shadow-2xl"
              initial={{ opacity: 0, scale: 0.96, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 12 }}
              transition={{ duration: 0.18 }}
            >
              <div className="mb-4 flex items-center gap-3">
                <div className={`flex h-11 w-11 items-center justify-center rounded-lg ${completionDialog.type === 'complete' ? 'bg-success-muted text-success' : 'bg-warning-muted text-warning-foreground'}`}>
                  {completionDialog.type === 'complete' ? <CheckCircle2 className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}
                </div>
                <div>
                  <h3 id="translation-completion-title" className="text-lg font-bold text-foreground">
                    {completionDialog.type === 'complete' ? '翻译已完成' : `仍有 ${completionDialog.pendingCount} 条待补译`}
                  </h3>
                  <p className="mt-1 text-xs font-medium text-muted-foreground">
                    {completionDialog.type === 'complete'
                      ? `${completionDialog.totalCount}/${completionDialog.totalCount} 句子已完成。请快速检查红色警告项，然后进入 QA。`
                      : `${completionDialog.translatedCount}/${completionDialog.totalCount} 句子已完成。建议先补译剩余项，再进入 QA。`}
                  </p>
                </div>
              </div>

              <div className="flex justify-end">
                {completionDialog.type === 'complete' ? (
                  <button
                    type="button"
                    onClick={() => setCompletionDialog(null)}
                    className="inline-flex h-10 items-center justify-center rounded-lg bg-primary px-5 text-sm font-bold text-white transition hover:bg-primary-hover"
                  >
                    好的
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setCompletionDialog(null);
                      void onTranslatePending?.();
                    }}
                    disabled={!onTranslatePending}
                    className="inline-flex h-10 items-center justify-center rounded-lg bg-primary px-5 text-sm font-bold text-white transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    补译剩余项
                  </button>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="mx-auto flex w-full max-w-none items-center justify-between border-b border-border/80 pb-6">
        <button
          type="button"
          onClick={onPrevStep}
          aria-label="上一步"
          title="上一步"
          className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-muted/60 text-sm font-semibold text-foreground transition-all hover:bg-muted cursor-pointer"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>

        <button
          type="button"
          onClick={pendingCount > 0 || isTranslating ? undefined : onNextStep}
          aria-label="下一步"
          title={pendingCount > 0 ? `仍有 ${pendingCount} 条待补译` : '下一步'}
          disabled={pendingCount > 0 || isTranslating}
          className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-primary bg-primary text-sm font-semibold text-primary-foreground shadow-sm transition-all hover:bg-primary-hover cursor-pointer disabled:cursor-not-allowed disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
        >
          <ChevronRight className="w-5 h-5" />
        </button>
      </div>
      {/* 进度条 (Translation Progress Tracker) */}
      <div className="mb-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-2xl font-bold text-foreground">翻译进度</h2>
          <div className="flex items-center gap-3">
            {isTranslating && !isPausing && onPauseTranslation && (
              <button
                type="button"
                onClick={() => void onPauseTranslation()}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-background text-foreground transition hover:bg-muted"
                aria-label="暂停翻译"
                title="暂停翻译"
              >
                <Pause className="h-4 w-4" />
              </button>
            )}
            {isPausing && (
              <span
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground"
                aria-label="正在暂停"
                title="正在暂停，等待进行中的请求完成…"
              >
                <Loader2 className="h-4 w-4 animate-spin" />
              </span>
            )}
            {isPaused && onResumeTranslation && (
              <button
                type="button"
                onClick={() => void onResumeTranslation()}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-primary bg-primary text-primary-foreground shadow-sm transition hover:bg-primary-hover"
                aria-label="继续翻译"
                title="继续翻译"
              >
                <Play className="h-4 w-4" />
              </button>
            )}
            {hasBackfillNeeded && onTranslatePending && (
              <button
                type="button"
                onClick={onTranslatePending}
                disabled={isTranslating}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-warning/30 bg-warning-muted px-3 text-xs font-bold text-warning-foreground transition hover:bg-warning/10 disabled:opacity-50"
              >
                {isTranslating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                补译剩余待翻译项 ({pendingCount})
              </button>
            )}
            <p className={`text-sm font-semibold ${pendingCount > 0 && !isTranslating ? 'text-warning-foreground' : 'text-primary'}`}>
              {isPausing
                ? `${translationProgress?.message || '正在暂停，等待进行中的请求完成…'} (${translatedCount}/${totalCount} 句子)`
                : isPaused
                ? `翻译已暂停 (${translatedCount}/${totalCount} 句子)`
                : isTranslating
                ? `${translationProgress?.message || '正在自动翻译中...'} (${translatedCount}/${totalCount} 句子)`
                : pendingCount > 0
                  ? `仍有 ${pendingCount} 条待补译 (${translatedCount}/${totalCount} 句子)`
                  : `自动翻译已完成 (${translatedCount}/${totalCount} 句子)`}
            </p>
          </div>
        </div>
        <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-primary to-primary/80 transition-all duration-500"
            style={{ width: `${totalCount > 0 ? (translatedCount / totalCount) * 100 : 0}%` }}
          />
        </div>
      </div>

      {/* 统一管控翻译卡片 (Unified Translation Control Card) */}
      <div className="rounded-3xl border border-border bg-card shadow-xs overflow-hidden text-left">
        {/* 控制与过滤面板头部 */}
        <div className="p-6 bg-muted/15 border-b border-border space-y-5">
          {/* 筛选与快速查找行 */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-center">
            {/* 快速内容检索 */}
            <div className="relative md:col-span-6">
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-bold text-muted-foreground">快速内容检索</label>
                {(searchTerm || slideFilter !== 'all' || statusFilter !== 'all') && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchTerm('');
                      setSlideFilter('all');
                      setStatusFilter('all');
                    }}
                    className="text-[11px] font-bold text-primary hover:text-primary-hover flex items-center gap-1 cursor-pointer transition-colors"
                  >
                    <X className="w-3.5 h-3.5" />
                    清空并重置所有筛选
                  </button>
                )}
              </div>
              <div className="relative">
                <Search className="absolute left-3.5 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                  type="text"
                  placeholder="输入原文或译文中的连续文字（忽略大小写）..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-10 pr-10 h-10 bg-background border border-border rounded-xl text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/60 shadow-2xs"
                />
                {searchTerm && (
                  <button
                    type="button"
                    onClick={() => setSearchTerm('')}
                    className="absolute right-3 top-1/2 transform -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground rounded-full hover:bg-muted/60 transition-colors cursor-pointer flex items-center justify-center font-bold"
                    title="清空搜索内容"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {!isWordDocument && (
              <div className="md:col-span-3">
                <label className="block text-xs font-bold text-muted-foreground mb-1.5">幻灯片页码筛选</label>
                <select
                  value={slideFilter}
                  onChange={(e) => setSlideFilter(e.target.value)}
                  className="w-full bg-background border border-border rounded-xl px-3 h-10 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer shadow-2xs font-semibold truncate"
                >
                  <option value="all">所有页码</option>
                  {slides.map(num => (
                    <option key={num} value={num.toString()}>
                      {num > 0 ? `第 ${num} 页` : '页码不可用'}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* 翻译状态筛选 */}
            <div className="md:col-span-3">
              <label className="block text-xs font-bold text-muted-foreground mb-1.5">翻译记录状态</label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="w-full bg-background border border-border rounded-xl px-3 h-10 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer shadow-2xs font-semibold truncate"
              >
                <option value="all">所有状态</option>
                <option value="translated">翻译成功</option>
                <option value="edited">用户修改</option>
                <option value="preserved">已保留原文</option>
                <option value="pending">待翻译</option>
              </select>
            </div>
          </div>

          {/* PowerPoint 级“全部替换“高阶批量工具栏 */}
          <div className="p-4 rounded-2xl bg-secondary/35 border border-border/80 shadow-2xs text-left">
            <div className="flex items-center gap-2 mb-3">
              <span className="w-1.5 h-3.5 rounded-full bg-primary" />
              <h4 className="text-xs font-bold text-foreground">幻灯片全局批量替换译文工具</h4>
              <span className="text-[10px] text-muted-foreground bg-muted/60 px-2 py-0.5 rounded-md font-mono">
                此工具可依条件在该列表下执行极速同词替换
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
              <div className="relative md:col-span-4">
                <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5">1. 待精确查找翻译的词/短语</label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                  <input
                    type="text"
                    placeholder="输入需要匹配替换词段..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full pl-9 pr-9 h-9 bg-background border border-border rounded-xl text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/50"
                  />
                  {searchTerm && (
                    <button
                      type="button"
                      onClick={() => setSearchTerm('')}
                      className="absolute right-2.5 top-1/2 transform -translate-y-1/2 p-0.5 text-muted-foreground hover:text-foreground rounded-full hover:bg-muted transition-colors cursor-pointer flex items-center justify-center"
                      title="清除"
                    >
                      <X className="w-3 h-3 font-semibold" />
                    </button>
                  )}
                </div>
              </div>

              <div className="relative md:col-span-4">
                <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5">2. 目标批量替换为字词</label>
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 transform -translate-y-1/2 text-xs font-bold text-muted-foreground">→</span>
                  <input
                    type="text"
                    placeholder="输入期望替换出的新译文..."
                    value={replaceTerm}
                    onChange={(e) => setReplaceTerm(e.target.value)}
                    className="w-full pl-9 pr-9 h-9 bg-background border border-border rounded-xl text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/50"
                  />
                  {replaceTerm && (
                    <button
                      type="button"
                      onClick={() => setReplaceTerm('')}
                      className="absolute right-2.5 top-1/2 transform -translate-y-1/2 p-0.5 text-muted-foreground hover:text-foreground rounded-full hover:bg-muted transition-colors cursor-pointer flex items-center justify-center"
                      title="清除"
                    >
                      <X className="w-3 h-3 font-semibold" />
                    </button>
                  )}
                </div>
              </div>

              <div className="md:col-span-4">
                <button
                  type="button"
                  onClick={handleReplaceAll}
                  disabled={!searchTerm.trim() || isReplacingAll}
                  className="w-full h-9 bg-primary text-primary-foreground font-bold rounded-xl text-xs transition-all hover:bg-primary-hover disabled:opacity-50 cursor-pointer flex items-center justify-center gap-1.5 shadow-sm"
                >
                  {isReplacingAll ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      正在替换...
                    </>
                  ) : (
                    '全部一键替换'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* 翻译对照表格 */}
        <div className="p-6 space-y-3">
          {/* 表头 */}
          <div className="grid grid-cols-12 gap-4 pb-4 border-b border-border text-left">
            <div className="col-span-1 font-sans">
              <p className="text-sm font-semibold text-muted-foreground">页码</p>
            </div>
            <div className="col-span-4 font-sans">
              <p className="text-sm font-semibold text-muted-foreground">原文（{displayLanguageLabel(sourceLang)}）</p>
            </div>
            <div className="col-span-4 font-sans">
              <p className="text-sm font-semibold text-muted-foreground">译文（{displayLanguageLabel(targetLang)}，点击任意行即可直接精细微调修改）</p>
            </div>
            <div className="col-span-3 font-sans pb-0">
              <p className="text-sm font-semibold text-muted-foreground">状态 / 操作</p>
            </div>
          </div>

          {/* 表体 Rows */}
          <div className="divide-y divide-border/60">
            {filteredItems.length === 0 ? (
              <div className="py-12 text-center text-muted-foreground text-xs font-medium">
                暂无匹配当前检索和筛选条件的文段项目。
              </div>
            ) : (
              filteredItems.map((item) => {
                const isEditingThis = editingItemId === item.id;
                const isSavingThis = isUpdatingItem === item.originalText;

                const keysToMatch = (recentChangedKeys && recentChangedKeys.length > 0)
                  ? recentChangedKeys
                  : (glossary || []).map(g => g.source);

                const hasGlossaryMatch = keysToMatch && keysToMatch.some(key =>
                  isGlossaryTermMatch(item.originalText, key)
                );

                // Subtle visual highlighting for active glossary matched rows in P3
                const isRecentlyUpdatedGlossary = hasGlossaryMatch && (item.status === 'translated' || item.status === 'edited');

                return (
                  <div
                    key={item.id}
                    className={`grid grid-cols-12 gap-4 py-3.5 hover:bg-muted/30 rounded-lg px-2 transition-all duration-300 items-center text-left ${
                      isRecentlyUpdatedGlossary
                        ? 'bg-blue-50/10 border-l-4 border-l-primary/60 border-y border-y-primary/5 pl-1.5'
                        : 'border-l-4 border-l-transparent'
                    }`}
                  >
                    {/* Slide number */}
                    <div className="col-span-1 flex items-center">
                      <span className="text-sm font-semibold text-foreground font-mono">
                        {displayPageNumber(item.slideNum, documentType)}
                      </span>
                    </div>

                    {/* Original English Text */}
                    <div className="col-span-4">
                      <p className="text-sm text-foreground break-words font-sans selection:bg-sky-200">
                        {highlightText(item.originalText, searchTerm)}
                      </p>
                    </div>

                    {/* Translated Text Column */}
                    <div className="col-span-4 pr-2">
                      {isEditingThis ? (
                        <div className="flex items-center gap-1.5 w-full">
                          <textarea
                            autoFocus
                            rows={Math.max(2, editingTranslatedValue.split('\n').length)}
                            value={editingTranslatedValue}
                            onChange={(e) => setEditingTranslatedValue(e.target.value)}
                            onBlur={() => saveEditing()}
                            onKeyDown={(e) => handleKeyDown(e, item.id)}
                            className="w-full rounded-xl border border-primary bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary font-sans font-medium resize-y min-h-[60px]"
                            placeholder="请输入精细译文..."
                            disabled={isSavingThis}
                          />
                        </div>
                      ) : (
                        <div
                          onClick={() => startEditing(item)}
                          className="w-full text-sm text-foreground cursor-pointer rounded-lg px-3 py-2 border border-transparent hover:border-border hover:bg-primary/5 transition-all break-words select-none font-medium text-foreground py-1 focus:outline-none min-h-[32px] flex items-center"
                          title="点击直接进行精细化编辑修改"
                        >
                          {item.translatedText ? (
                            highlightText(item.translatedText, searchTerm)
                          ) : isTranslating ? (
                            <span className="text-primary font-semibold animate-pulse flex items-center gap-1 text-xs">
                              <span className="h-1 w-1 rounded-full bg-primary animate-ping" />
                              AI 正在极速生成译文...
                            </span>
                          ) : (
                            <span className="text-muted-foreground italic text-xs">(点击在此录入自定义译文)</span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Status / Quick Action Badge Column */}
                    <div className="col-span-3 flex items-center justify-between pl-2">
                      <div className="flex-1">
                        {isSavingThis ? (
                          <span className="text-xs text-muted-foreground font-mono flex items-center gap-1.5">
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                            同步中...
                          </span>
                        ) : (
                          getStatusBadge(item)
                        )}
                      </div>

                      {!isEditingThis && !isSavingThis && (
                        <button
                          type="button"
                          onClick={() => startEditing(item)}
                          className="text-xs font-semibold text-primary hover:text-primary-hover hover:underline transition-all cursor-pointer opacity-0 hover:opacity-100 group-hover:opacity-100 focus:opacity-100 ml-2"
                        >
                          编辑
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* 导航按钮组 */}
      <div className="mt-8 flex justify-between items-center">
        <button
          onClick={onPrevStep}
          className="inline-flex items-center gap-2 rounded-xl border border-border px-5 py-3.5 font-bold text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-all cursor-pointer"
        >
          <ChevronLeft className="h-4.5 w-4.5" />
          <span>上一步</span>
        </button>

        <button
          onClick={onNextStep}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-8 py-3.5 font-bold text-sm text-primary-foreground shadow-sm transition-all hover:shadow-md active:shadow-none cursor-pointer"
        >
          <Check className="h-4.5 w-4.5" />
          <span>确认，去下载</span>
        </button>
      </div>

      {/* Direction-aware floating scroll button */}
      <AnimatePresence>
        {scrollControlDirection && (
          <div className="fixed bottom-8 left-1/2 z-[999] -translate-x-1/2">
            <motion.button
              initial={{ opacity: 0, scale: 0.8, y: 15 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.8, y: 15 }}
              onClick={scrollControlDirection === 'up' ? scrollToTop : scrollToBottom}
              className="flex items-center justify-center rounded-full border border-primary/20 bg-primary p-4 text-primary-foreground shadow-2xl transition-all hover:scale-105 hover:bg-primary/95 hover:shadow-xl active:scale-95 group"
              title={scrollControlDirection === 'up' ? '回到顶部' : '回到底部'}
            >
              {scrollControlDirection === 'up' ? (
                <ArrowUp className="w-5 h-5 transition-transform group-hover:-translate-y-0.5" />
              ) : (
                <ArrowDown className="w-5 h-5 transition-transform group-hover:translate-y-0.5" />
              )}
            </motion.button>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
