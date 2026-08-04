import React, { useState, useEffect } from 'react';
import { Search, Plus, Trash2, Tag, AlertCircle, ArrowUp, ArrowDown, Upload, Pencil, X, Save, ChevronDown, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GlossaryImportPreview, GlossaryLibrary, GlossaryTerm } from '../types';
import { apiFetch } from '../lib/api';

const GLOSSARY_CATEGORY_LABELS: Record<string, string> = {
  'Product & Brand': '产品与品牌名',
  'Code & Acronym': '代号与专业缩写',
  'Industry Domain': '行业垂直术语',
  'Company Internal': '企业内部/自定义',
  'Other': '其它',
};

const GLOSSARY_CATEGORY_OPTIONS = [
  'Product & Brand',
  'Code & Acronym',
  'Industry Domain',
  'Company Internal',
  'Other',
];

const GLOSSARY_SCOPE_OPTIONS: Array<{ value: GlossaryLibrary['scope']; label: string }> = [
  { value: 'general', label: '通用' },
  { value: 'domain', label: '行业领域' },
  { value: 'client', label: '客户专属' },
  { value: 'product', label: '产品专属' },
  { value: 'project', label: '项目专属' },
];

const GLOSSARY_LANGUAGE_OPTIONS = [
  { value: '', label: '不限定' },
  { value: 'English', label: '英语' },
  { value: 'Simplified Chinese', label: '简体中文' },
  { value: 'French', label: '法语' },
  { value: 'Japanese', label: '日语' },
  { value: 'Italian', label: '意大利语' },
  { value: 'Arabic', label: '阿拉伯语' },
];

function getCategoryLabel(category?: string): string {
  if (!category) return GLOSSARY_CATEGORY_LABELS.Other;
  return GLOSSARY_CATEGORY_LABELS[category] || category;
}

function compareGlossaryText(a = '', b = ''): number {
  return a.trim().localeCompare(b.trim(), undefined, { sensitivity: 'base', numeric: true });
}

function normalizeGlossaryMatchValue(value = ''): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase();
}

function getGlossaryLanguageLabel(language?: string): string {
  if (!language) return '任意';
  const normalized = language.trim().toLowerCase();
  const match = GLOSSARY_LANGUAGE_OPTIONS.find(option => option.value.toLowerCase() === normalized);
  return match?.label || language;
}

function getTermLanguageDirection(term: GlossaryTerm, fallbackLibrary?: GlossaryLibrary): { key: string; label: string } | null {
  const sourceLang = term.sourceLang || fallbackLibrary?.sourceLang;
  const targetLang = term.targetLang || fallbackLibrary?.targetLang;
  if (sourceLang && targetLang) {
    return {
      key: `${sourceLang.trim().toLowerCase()}|||${targetLang.trim().toLowerCase()}`,
      label: `${getGlossaryLanguageLabel(sourceLang)}→${getGlossaryLanguageLabel(targetLang)}`
    };
  }
  if (term.direction === 'zh-en') return { key: 'simplified chinese|||english', label: '简体中文→英语' };
  if (term.direction === 'en-zh') return { key: 'english|||simplified chinese', label: '英语→简体中文' };
  return null;
}

function getLibraryLanguageDirections(library: GlossaryLibrary): Array<{ key: string; label: string }> {
  const directions = new Map<string, string>();
  library.terms.forEach(term => {
    const direction = getTermLanguageDirection(term, library);
    if (direction) directions.set(direction.key, direction.label);
  });
  if (directions.size === 0 && library.sourceLang && library.targetLang) {
    const fallback = getTermLanguageDirection({ source: '', target: '' }, library);
    if (fallback) directions.set(fallback.key, fallback.label);
  }
  return Array.from(directions, ([key, label]) => ({ key, label })).sort((a, b) => compareGlossaryText(a.label, b.label));
}

function compareGlossaryTerms(a: GlossaryTerm, b: GlossaryTerm): number {
  return compareGlossaryText(a.source, b.source)
    || compareGlossaryText(a.target, b.target)
    || compareGlossaryText(a.category || '', b.category || '')
    || compareGlossaryText(a.explanation || '', b.explanation || '');
}

interface GlossaryManagerProps {
  glossary: GlossaryTerm[];
  libraries?: GlossaryLibrary[];
  onAddTerm: (source: string, target: string, category?: string, explanation?: string) => Promise<void>;
  onUpdateTerm: (oldSource: string, oldTarget: string, term: GlossaryTerm) => Promise<void>;
  onDeleteTerm: (source: string, target?: string) => Promise<void>;
  onGlossaryImported?: (glossary: GlossaryTerm[]) => void;
  onLibrariesChanged?: (libraries: GlossaryLibrary[]) => void;
  isAdding: boolean;
}

type PendingTermConflict = {
  operation: 'add' | 'edit_source';
  incoming: GlossaryTerm;
  existingTerms: GlossaryTerm[];
  original?: GlossaryTerm;
};

export default function GlossaryManager({
  glossary,
  libraries = [],
  onAddTerm,
  onUpdateTerm,
  onDeleteTerm,
  onGlossaryImported,
  onLibrariesChanged,
  isAdding
}: GlossaryManagerProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [newSource, setNewSource] = useState('');
  const [newTarget, setNewTarget] = useState('');
  const [newCategory, setNewCategory] = useState('Other');
  const [newExplanation, setNewExplanation] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);
  const [scrollControlDirection, setScrollControlDirection] = useState<'up' | 'down' | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingSourceKey, setEditingSourceKey] = useState<string | null>(null);
  const [editingExplanationKey, setEditingExplanationKey] = useState<string | null>(null);
  const [editingCategoryKey, setEditingCategoryKey] = useState<string | null>(null);
  const [editingSource, setEditingSource] = useState('');
  const [editingTarget, setEditingTarget] = useState('');
  const [editingExplanation, setEditingExplanation] = useState('');
  const [editingCategory, setEditingCategory] = useState('');
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [importPreview, setImportPreview] = useState<GlossaryImportPreview | null>(null);
  const [importFileName, setImportFileName] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [activeLibraryId, setActiveLibraryId] = useState('');
  const [languageDirectionFilter, setLanguageDirectionFilter] = useState('all');
  const [libraryEditorMode, setLibraryEditorMode] = useState<'create' | 'edit' | null>(null);
  const [libraryName, setLibraryName] = useState('');
  const [libraryDescription, setLibraryDescription] = useState('');
  const [libraryScope, setLibraryScope] = useState<GlossaryLibrary['scope']>('general');
  const [librarySourceLang, setLibrarySourceLang] = useState('English');
  const [libraryTargetLang, setLibraryTargetLang] = useState('Simplified Chinese');
  const [libraryPriority, setLibraryPriority] = useState('0');
  const [isSavingLibrary, setIsSavingLibrary] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [pendingTermConflict, setPendingTermConflict] = useState<PendingTermConflict | null>(null);
  const [isResolvingTermConflict, setIsResolvingTermConflict] = useState(false);

  const activeLibrary = libraries.find(library => library.id === activeLibraryId)
    || libraries.find(library => library.id.startsWith('default_'))
    || libraries[0];
  const activeGlossary = activeLibrary ? activeLibrary.terms : glossary;
  const isDefaultLibrary = Boolean(activeLibrary?.id.startsWith('default_'));
  const activeLibraryDirections = activeLibrary ? getLibraryLanguageDirections(activeLibrary) : [];
  const activeDirectionLabel = languageDirectionFilter === 'all'
    ? '全部'
    : activeLibraryDirections.find(direction => direction.key === languageDirectionFilter)?.label || '全部';

  const isSameTermDirection = (left: GlossaryTerm, right: GlossaryTerm): boolean => {
    const leftDirection = getTermLanguageDirection(left, activeLibrary)?.key;
    const rightDirection = getTermLanguageDirection(right, activeLibrary)?.key;
    // Legacy/default libraries can contain terms with language metadata even
    // when the library itself has no fixed direction. An unscoped new term is
    // therefore treated conservatively as overlapping any matching source.
    if (!leftDirection || !rightDirection) return true;
    return leftDirection === rightDirection;
  };

  const isSameExactTerm = (left: GlossaryTerm, right: GlossaryTerm): boolean =>
    normalizeGlossaryMatchValue(left.source) === normalizeGlossaryMatchValue(right.source)
    && normalizeGlossaryMatchValue(left.target) === normalizeGlossaryMatchValue(right.target)
    && isSameTermDirection(left, right);

  const findSameSourceTerms = (incoming: GlossaryTerm, exclude?: GlossaryTerm): GlossaryTerm[] =>
    activeGlossary.filter(term => {
      if (exclude && isSameExactTerm(term, exclude)) return false;
      return normalizeGlossaryMatchValue(term.source) === normalizeGlossaryMatchValue(incoming.source)
        && isSameTermDirection(term, incoming);
    });

  const hasRelatedSourceOutsideCurrentDirection = (incoming: GlossaryTerm): boolean => {
    const incomingDirection = getTermLanguageDirection(incoming, activeLibrary)?.key;
    return libraries.some(library => library.terms.some(term => {
      if (normalizeGlossaryMatchValue(term.source) !== normalizeGlossaryMatchValue(incoming.source)) return false;
      if (library.id !== activeLibrary?.id) return true;
      const termDirection = getTermLanguageDirection(term, library)?.key;
      return Boolean(incomingDirection && termDirection && incomingDirection !== termDirection);
    }));
  };

  useEffect(() => {
    if (activeLibraryId && libraries.some(library => library.id === activeLibraryId)) return;
    const fallback = libraries.find(library => library.id.startsWith('default_')) || libraries[0];
    setActiveLibraryId(fallback?.id || '');
  }, [libraries, activeLibraryId]);

  useEffect(() => {
    setLanguageDirectionFilter('all');
  }, [activeLibrary?.id]);

  const refreshLibraries = async (preferredLibraryId?: string) => {
    const res = await apiFetch('/api/glossary/libraries');
    if (!res.ok) throw new Error('刷新术语库失败。');
    const data = await res.json();
    const nextLibraries: GlossaryLibrary[] = Array.isArray(data?.libraries) ? data.libraries : [];
    onLibrariesChanged?.(nextLibraries);
    if (preferredLibraryId && nextLibraries.some(library => library.id === preferredLibraryId)) {
      setActiveLibraryId(preferredLibraryId);
    }
    return nextLibraries;
  };

  const saveLibraryTerms = async (terms: GlossaryTerm[]) => {
    if (!activeLibrary) throw new Error('请先选择一个术语库。');
    const res = await apiFetch(`/api/glossary/libraries/${encodeURIComponent(activeLibrary.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terms })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || '保存术语库失败。');
    }
    await refreshLibraries(activeLibrary.id);
  };

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

  const resetNewTermForm = () => {
    setNewSource('');
    setNewTarget('');
    setNewCategory('Other');
    setNewExplanation('');
  };

  const commitAddTerm = async (newTerm: GlossaryTerm, replaceTerms: GlossaryTerm[] = []) => {
    const hasRelatedSource = hasRelatedSourceOutsideCurrentDirection(newTerm);
    if (activeLibrary && !isDefaultLibrary) {
      const nextTerms = activeGlossary
        .filter(term => !replaceTerms.some(existing => isSameExactTerm(term, existing)))
        .concat(newTerm);
      await saveLibraryTerms(nextTerms);
    } else {
      for (const existing of replaceTerms) {
        await onDeleteTerm(existing.source, existing.target);
      }
      await onAddTerm(newTerm.source, newTerm.target, newTerm.category, newTerm.explanation);
      await refreshLibraries(activeLibrary?.id);
    }
    resetNewTermForm();
    if (hasRelatedSource) {
      setNoticeMessage('已保存。此原词还存在于其他术语库或语言方向，请留意项目加载顺序和术语库优先级。');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setNoticeMessage(null);

    if (!newSource.trim() || !newTarget.trim()) {
      setErrorMessage('源术语和目标术语均为必填项。');
      return;
    }

    const newTerm: GlossaryTerm = {
      source: newSource.trim(),
      target: newTarget.trim(),
      category: newCategory.trim() || undefined,
      explanation: newExplanation.trim() || undefined,
      sourceLang: activeLibrary?.sourceLang,
      targetLang: activeLibrary?.targetLang,
      status: 'active',
      origin: 'manual'
    };
    const sameSourceTerms = findSameSourceTerms(newTerm);
    if (sameSourceTerms.some(term => isSameExactTerm(term, newTerm))) {
      setErrorMessage(`该术语已存在：${newTerm.source} → ${newTerm.target}`);
      return;
    }
    if (sameSourceTerms.length > 0) {
      setPendingTermConflict({ operation: 'add', incoming: newTerm, existingTerms: sameSourceTerms });
      return;
    }

    try {
      await commitAddTerm(newTerm);
    } catch (err: any) {
      setErrorMessage(err.message || '添加术语规则失败。');
    }
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    setImportError(null);
    setImportPreview(null);

    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setImportError('仅支持逗号分隔的 .csv 文件。');
      return;
    }

    const formData = new FormData();
    formData.append('file', file);
    setImportFileName(file.name);
    setIsImporting(true);

    try {
      const res = await apiFetch('/api/glossary/import-preview', {
        method: 'POST',
        body: formData
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '导入术语表失败。');
      }
      const preview: GlossaryImportPreview = await res.json();
      if (activeLibrary && !isDefaultLibrary) {
        const existingBySource = new Map<string, GlossaryTerm[]>();
        const exactKeys = new Set(activeGlossary.map(term => `${term.source.trim().toLowerCase()}|||${term.target.trim().toLowerCase()}`));
        activeGlossary.forEach(term => {
          const key = term.source.trim().toLowerCase();
          existingBySource.set(key, [...(existingBySource.get(key) || []), term]);
        });
        const additions: GlossaryTerm[] = [];
        const conflicts: GlossaryImportPreview['conflicts'] = [];
        preview.terms.forEach(term => {
          const exactKey = `${term.source.trim().toLowerCase()}|||${term.target.trim().toLowerCase()}`;
          if (exactKeys.has(exactKey)) return;
          const sameSource = existingBySource.get(term.source.trim().toLowerCase()) || [];
          if (sameSource.length > 0) conflicts.push({ source: term.source, existing: sameSource[0], incoming: term });
          else additions.push(term);
        });
        setImportPreview({ ...preview, additions, conflicts });
      } else {
        setImportPreview(preview);
      }
    } catch (err: any) {
      setImportError(err.message || '导入术语表失败。');
    } finally {
      setIsImporting(false);
    }
  };

  const applyImportPreview = async (conflictStrategy: 'skip' | 'overwrite') => {
    if (!importPreview) return;
    setIsImporting(true);
    setImportError(null);

    try {
      if (activeLibrary && !isDefaultLibrary) {
        let nextTerms = [...activeGlossary];
        for (const incoming of importPreview.terms) {
          const exactIndex = nextTerms.findIndex(term =>
            term.source.trim().toLowerCase() === incoming.source.trim().toLowerCase()
            && term.target.trim().toLowerCase() === incoming.target.trim().toLowerCase()
          );
          if (exactIndex >= 0) {
            if (conflictStrategy === 'overwrite') nextTerms[exactIndex] = incoming;
            continue;
          }
          const sameSourceIndexes = nextTerms
            .map((term, index) => ({ term, index }))
            .filter(({ term }) => term.source.trim().toLowerCase() === incoming.source.trim().toLowerCase())
            .map(({ index }) => index);
          if (sameSourceIndexes.length > 0 && conflictStrategy === 'skip') continue;
          if (sameSourceIndexes.length > 0) {
            const replaceAt = sameSourceIndexes[0];
            nextTerms = nextTerms.filter((_, index) => !sameSourceIndexes.includes(index));
            nextTerms.splice(Math.min(replaceAt, nextTerms.length), 0, incoming);
          } else {
            nextTerms.push(incoming);
          }
        }
        await saveLibraryTerms(nextTerms);
        setImportPreview(null);
        setImportFileName('');
        return;
      }
      const res = await apiFetch('/api/glossary/import-apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ terms: importPreview.terms, conflictStrategy })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '应用术语表导入失败。');
      }
      const data = await res.json();
      if (Array.isArray(data.glossary)) {
        onGlossaryImported?.(data.glossary);
      }
      await refreshLibraries(activeLibrary?.id);
      setImportPreview(null);
      setImportFileName('');
    } catch (err: any) {
      setImportError(err.message || '应用术语表导入失败。');
    } finally {
      setIsImporting(false);
    }
  };

  const filteredGlossary = activeGlossary.filter(term => {
    const direction = getTermLanguageDirection(term, activeLibrary);
    const matchesDirection = languageDirectionFilter === 'all' || direction?.key === languageDirectionFilter;
    const normalizedSearch = searchTerm.toLowerCase();
    const matchesSearch = term.source.toLowerCase().includes(normalizedSearch) ||
      term.target.toLowerCase().includes(normalizedSearch) ||
      (term.category && getCategoryLabel(term.category).toLowerCase().includes(normalizedSearch)) ||
      (term.explanation && term.explanation.toLowerCase().includes(normalizedSearch));
    return matchesDirection && matchesSearch;
  }).sort(compareGlossaryTerms);

  const handleDelete = async (source: string, target?: string) => {
    const confirmed = window.confirm(`从“${activeLibrary?.name || '个人术语库'}”删除这条术语吗？\n\n${source}${target ? ` -> ${target}` : ''}`);
    if (!confirmed) return;
    if (activeLibrary && !isDefaultLibrary) {
      await saveLibraryTerms(activeGlossary.filter(term => !(
        term.source.trim().toLowerCase() === source.trim().toLowerCase()
        && (!target || term.target.trim().toLowerCase() === target.trim().toLowerCase())
      )));
    } else {
      await onDeleteTerm(source, target);
      await refreshLibraries(activeLibrary?.id);
    }
  };

  const glossaryTermKey = (term: GlossaryTerm): string =>
    `${normalizeGlossaryMatchValue(term.source)}|||${normalizeGlossaryMatchValue(term.target)}`;

  const beginEditSource = (term: GlossaryTerm) => {
    setEditingSourceKey(glossaryTermKey(term));
    setEditingSource(term.source);
    setErrorMessage(null);
    setNoticeMessage(null);
  };

  const cancelEditSource = () => {
    setEditingSourceKey(null);
    setEditingSource('');
  };

  const beginEditTarget = (term: GlossaryTerm) => {
    setEditingKey(glossaryTermKey(term));
    setEditingTarget(term.target);
    setErrorMessage(null);
    setNoticeMessage(null);
  };

  const cancelEditTarget = () => {
    setEditingKey(null);
    setEditingTarget('');
  };

  const beginEditExplanation = (term: GlossaryTerm) => {
    setEditingExplanationKey(glossaryTermKey(term));
    setEditingExplanation(term.explanation || '');
    setErrorMessage(null);
  };

  const cancelEditExplanation = () => {
    setEditingExplanationKey(null);
    setEditingExplanation('');
  };

  const beginEditCategory = (term: GlossaryTerm) => {
    setEditingCategoryKey(glossaryTermKey(term));
    setEditingCategory(term.category || 'Other');
    setErrorMessage(null);
  };

  const cancelEditCategory = () => {
    setEditingCategoryKey(null);
    setEditingCategory('');
  };

  const commitEditSource = async (
    original: GlossaryTerm,
    incoming: GlossaryTerm,
    replaceTerms: GlossaryTerm[] = []
  ) => {
    const hasRelatedSource = hasRelatedSourceOutsideCurrentDirection(incoming);
    if (activeLibrary && !isDefaultLibrary) {
      const nextTerms = activeGlossary
        .filter(item => !replaceTerms.some(existing => isSameExactTerm(item, existing)))
        .map(item => isSameExactTerm(item, original) ? incoming : item);
      await saveLibraryTerms(nextTerms);
    } else {
      for (const existing of replaceTerms) {
        await onDeleteTerm(existing.source, existing.target);
      }
      await onUpdateTerm(original.source, original.target, incoming);
      await refreshLibraries(activeLibrary?.id);
    }
    cancelEditSource();
    if (hasRelatedSource) {
      setNoticeMessage('已保存。此原词还存在于其他术语库或语言方向，请留意项目加载顺序和术语库优先级。');
    }
  };

  const saveEditSource = async (term: GlossaryTerm) => {
    setNoticeMessage(null);
    const nextSource = editingSource.trim();
    if (!nextSource) {
      setErrorMessage('源术语不能为空。');
      return;
    }
    if (nextSource === term.source) {
      cancelEditSource();
      return;
    }

    const incoming = { ...term, source: nextSource };
    const sameSourceTerms = findSameSourceTerms(incoming, term);
    if (sameSourceTerms.some(existing => isSameExactTerm(existing, incoming))) {
      setErrorMessage(`该术语已存在：${incoming.source} → ${incoming.target}`);
      return;
    }
    if (sameSourceTerms.length > 0) {
      setPendingTermConflict({
        operation: 'edit_source',
        incoming,
        existingTerms: sameSourceTerms,
        original: term
      });
      return;
    }

    setIsSavingEdit(true);
    setErrorMessage(null);
    try {
      await commitEditSource(term, incoming);
    } catch (err: any) {
      setErrorMessage(err.message || '更新源术语失败。');
    } finally {
      setIsSavingEdit(false);
    }
  };

  const saveEditTarget = async (term: GlossaryTerm) => {
    setNoticeMessage(null);
    const nextTarget = editingTarget.trim();
    if (!nextTarget) {
      setErrorMessage('目标术语不能为空。');
      return;
    }
    if (nextTarget === term.target) {
      cancelEditTarget();
      return;
    }

    const incoming = { ...term, target: nextTarget };
    const exactConflict = activeGlossary.find(item =>
      !isSameExactTerm(item, term) && isSameExactTerm(item, incoming)
    );
    if (exactConflict) {
      setErrorMessage(`该术语已存在：${incoming.source} → ${incoming.target}`);
      return;
    }

    setIsSavingEdit(true);
    setErrorMessage(null);
    try {
      if (activeLibrary && !isDefaultLibrary) {
        await saveLibraryTerms(activeGlossary.map(item => glossaryTermKey(item) === glossaryTermKey(term) ? { ...item, target: nextTarget } : item));
      } else {
        await onUpdateTerm(term.source, term.target, { ...term, target: nextTarget });
        await refreshLibraries(activeLibrary?.id);
      }
      cancelEditTarget();
    } catch (err: any) {
      setErrorMessage(err.message || '更新术语失败。');
    } finally {
      setIsSavingEdit(false);
    }
  };

  const saveEditCategory = async (term: GlossaryTerm, nextCategoryValue = editingCategory) => {
    const nextCategory = nextCategoryValue.trim() || 'Other';
    if (nextCategory === (term.category || 'Other')) {
      cancelEditCategory();
      return;
    }

    setIsSavingEdit(true);
    setErrorMessage(null);
    try {
      if (activeLibrary && !isDefaultLibrary) {
        await saveLibraryTerms(activeGlossary.map(item => glossaryTermKey(item) === glossaryTermKey(term) ? { ...item, category: nextCategory } : item));
      } else {
        await onUpdateTerm(term.source, term.target, { ...term, category: nextCategory });
        await refreshLibraries(activeLibrary?.id);
      }
      cancelEditCategory();
    } catch (err: any) {
      setErrorMessage(err.message || '更新术语类别失败。');
    } finally {
      setIsSavingEdit(false);
    }
  };

  const saveEditExplanation = async (term: GlossaryTerm) => {
    const nextExplanation = editingExplanation.trim();
    if (nextExplanation === (term.explanation || '')) {
      cancelEditExplanation();
      return;
    }

    setIsSavingEdit(true);
    setErrorMessage(null);
    try {
      if (activeLibrary && !isDefaultLibrary) {
        await saveLibraryTerms(activeGlossary.map(item => glossaryTermKey(item) === glossaryTermKey(term) ? { ...item, explanation: nextExplanation } : item));
      } else {
        await onUpdateTerm(term.source, term.target, { ...term, explanation: nextExplanation });
        await refreshLibraries(activeLibrary?.id);
      }
      cancelEditExplanation();
    } catch (err: any) {
      setErrorMessage(err.message || '更新术语解释失败。');
    } finally {
      setIsSavingEdit(false);
    }
  };

  const resolveTermConflict = async (strategy: 'keep' | 'replace') => {
    if (!pendingTermConflict || isResolvingTermConflict) return;
    setIsResolvingTermConflict(true);
    setErrorMessage(null);
    try {
      const replaceTerms = strategy === 'replace' ? pendingTermConflict.existingTerms : [];
      if (pendingTermConflict.operation === 'add') {
        await commitAddTerm(pendingTermConflict.incoming, replaceTerms);
      } else if (pendingTermConflict.original) {
        await commitEditSource(pendingTermConflict.original, pendingTermConflict.incoming, replaceTerms);
      }
      setPendingTermConflict(null);
    } catch (err: any) {
      setErrorMessage(err.message || '处理术语冲突失败。');
    } finally {
      setIsResolvingTermConflict(false);
    }
  };

  const resetLibraryEditor = () => {
    setLibraryEditorMode(null);
    setLibraryName('');
    setLibraryDescription('');
    setLibraryScope('general');
    setLibrarySourceLang('English');
    setLibraryTargetLang('Simplified Chinese');
    setLibraryPriority('0');
    setLibraryError(null);
  };

  const beginCreateLibrary = () => {
    resetLibraryEditor();
    setLibraryEditorMode('create');
  };

  const saveLibraryMetadata = async (event: React.FormEvent) => {
    event.preventDefault();
    const cleanName = libraryName.trim();
    if (!cleanName) {
      setLibraryError('术语库名称不能为空。');
      return;
    }
    setIsSavingLibrary(true);
    setLibraryError(null);
    try {
      const isCreate = libraryEditorMode === 'create';
      const url = isCreate
        ? '/api/glossary/libraries'
        : `/api/glossary/libraries/${encodeURIComponent(activeLibrary!.id)}`;
      const res = await apiFetch(url, {
        method: isCreate ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: cleanName,
          description: libraryDescription.trim(),
          scope: libraryScope,
          sourceLang: librarySourceLang || undefined,
          targetLang: libraryTargetLang || undefined,
          priority: Number(libraryPriority) || 0
        })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '保存术语库失败。');
      }
      const data = await res.json();
      await refreshLibraries(data.library?.id || activeLibrary?.id);
      resetLibraryEditor();
    } catch (err: any) {
      setLibraryError(err.message || '保存术语库失败。');
    } finally {
      setIsSavingLibrary(false);
    }
  };

  const deleteActiveLibrary = async () => {
    if (!activeLibrary || isDefaultLibrary) return;
    const confirmed = window.confirm(`删除术语库“${activeLibrary.name}”吗？\n\n其中 ${activeLibrary.terms.length} 条术语也会一并删除，此操作不可撤销。`);
    if (!confirmed) return;
    setIsSavingLibrary(true);
    setLibraryError(null);
    try {
      const res = await apiFetch(`/api/glossary/libraries/${encodeURIComponent(activeLibrary.id)}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '删除术语库失败。');
      }
      const data = await res.json();
      const nextLibraries: GlossaryLibrary[] = Array.isArray(data?.libraries) ? data.libraries : [];
      onLibrariesChanged?.(nextLibraries);
      const fallback = nextLibraries.find(library => library.id.startsWith('default_')) || nextLibraries[0];
      setActiveLibraryId(fallback?.id || '');
      resetLibraryEditor();
    } catch (err: any) {
      setLibraryError(err.message || '删除术语库失败。');
    } finally {
      setIsSavingLibrary(false);
    }
  };

  return (
    <div className="space-y-6 relative">
      <section className="text-left font-sans">
        <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card px-4 py-3 shadow-sm md:flex-row md:items-center md:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <details className="group relative min-w-0 w-[320px] max-w-full">
              <summary
                aria-label="选择当前编辑的术语库和语言方向"
                className="flex h-10 min-w-0 cursor-pointer list-none items-center justify-between gap-3 rounded-xl border border-border bg-background px-3 text-sm font-semibold text-foreground transition hover:border-primary/40 hover:bg-muted/30 group-open:border-primary/40 [&::-webkit-details-marker]:hidden"
              >
                <span className="truncate">
                  {activeLibrary ? `${activeLibrary.name} · ${activeDirectionLabel} · ${activeGlossary.length} 条` : '选择术语库'}
                </span>
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
              </summary>
              <div className="absolute left-0 top-full z-50 mt-2 w-[420px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-background shadow-xl">
                <div className="max-h-64 overflow-y-auto p-2">
                  {libraries.map(library => {
                    const selected = activeLibrary?.id === library.id;
                    const directions = getLibraryLanguageDirections(library);
                    const directionSummary = directions.length === 1 ? directions[0].label : '全部';
                    return (
                      <button
                        key={library.id}
                        type="button"
                        onClick={() => {
                          setActiveLibraryId(library.id);
                          setLanguageDirectionFilter('all');
                          resetLibraryEditor();
                          setSearchTerm('');
                        }}
                        className={`grid w-full grid-cols-[20px_minmax(0,1fr)_auto_auto] items-center gap-2 rounded-lg px-2 py-2.5 text-left text-sm transition ${selected ? 'bg-primary/5 text-foreground' : 'text-foreground hover:bg-muted/60'}`}
                      >
                        <Check className={`h-4 w-4 text-primary ${selected ? 'opacity-100' : 'opacity-0'}`} />
                        <span className="truncate font-medium">{library.name}</span>
                        <span className="text-xs text-muted-foreground">{directionSummary}</span>
                        <span className="min-w-12 text-right text-xs text-muted-foreground">{library.terms.length} 条</span>
                      </button>
                    );
                  })}
                </div>
                {activeLibrary && (
                  <div className="border-t border-border bg-muted/20 p-3">
                    <p className="mb-2 text-[11px] font-bold text-muted-foreground">语言方向</p>
                    <div className="flex flex-wrap gap-2">
                      {[{ key: 'all', label: '全部' }, ...activeLibraryDirections].map(direction => (
                        <button
                          key={direction.key}
                          type="button"
                          onClick={event => {
                            setLanguageDirectionFilter(direction.key);
                            event.currentTarget.closest('details')?.removeAttribute('open');
                          }}
                          className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${languageDirectionFilter === direction.key
                            ? 'bg-primary text-primary-foreground'
                            : 'border border-border bg-background text-foreground hover:bg-muted'}`}
                        >
                          {direction.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </details>
            <button
              type="button"
              onClick={beginCreateLibrary}
              className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl bg-primary px-4 text-xs font-bold text-primary-foreground transition hover:bg-primary-hover"
            >
              <Plus className="h-4 w-4" />
              新建术语库
            </button>
          </div>
          {activeLibrary && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[180px] flex-1 md:w-56 md:flex-none">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
                <input
                  id="glossary-search"
                  type="text"
                  placeholder="检索当前术语库..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="h-9 w-full rounded-xl border border-neutral-200 bg-neutral-50 pl-9 pr-3 text-xs text-neutral-800 outline-none transition focus:border-neutral-900 focus:bg-white"
                />
              </div>
              {!isDefaultLibrary && (
                <button
                  type="button"
                  onClick={deleteActiveLibrary}
                  disabled={isSavingLibrary}
                  className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-destructive/20 bg-destructive/5 px-3 text-xs font-bold text-destructive transition hover:bg-destructive/10 disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" /> 删除
                </button>
              )}
            </div>
          )}
        </div>

        {libraryEditorMode && (
          <form onSubmit={saveLibraryMetadata} className="mt-4 rounded-xl border border-primary/20 bg-primary/5 p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-bold text-foreground">{libraryEditorMode === 'create' ? '新建术语库' : '编辑术语库设置'}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">设置适用范围和语言方向，便于项目选择和术语治理。</p>
              </div>
              <button type="button" onClick={resetLibraryEditor} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-background hover:text-foreground" aria-label="关闭">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="grid grid-cols-12 gap-3">
              <label className="col-span-12 md:col-span-4">
                <span className="mb-1 block text-[11px] font-medium text-neutral-700">名称</span>
                <input value={libraryName} onChange={event => setLibraryName(event.target.value)} placeholder="例如：汽车行业术语库" className="h-9 w-full rounded-xl border border-neutral-200 bg-white px-3 text-xs text-neutral-800 outline-none focus:border-primary" />
              </label>
              <label className="col-span-6 md:col-span-2">
                <span className="mb-1 block text-[11px] font-medium text-neutral-700">范围</span>
                <select value={libraryScope} onChange={event => setLibraryScope(event.target.value as GlossaryLibrary['scope'])} className="h-9 w-full rounded-xl border border-neutral-200 bg-white px-3 text-xs text-neutral-800 outline-none focus:border-primary">
                  {GLOSSARY_SCOPE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label className="col-span-6 md:col-span-2">
                <span className="mb-1 block text-[11px] font-medium text-neutral-700">源语言</span>
                <select value={librarySourceLang} onChange={event => setLibrarySourceLang(event.target.value)} className="h-9 w-full rounded-xl border border-neutral-200 bg-white px-3 text-xs text-neutral-800 outline-none focus:border-primary">
                  {GLOSSARY_LANGUAGE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label className="col-span-6 md:col-span-2">
                <span className="mb-1 block text-[11px] font-medium text-neutral-700">目标语言</span>
                <select value={libraryTargetLang} onChange={event => setLibraryTargetLang(event.target.value)} className="h-9 w-full rounded-xl border border-neutral-200 bg-white px-3 text-xs text-neutral-800 outline-none focus:border-primary">
                  {GLOSSARY_LANGUAGE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label className="col-span-6 md:col-span-2">
                <span className="mb-1 block text-[11px] font-medium text-neutral-700">优先级</span>
                <input type="number" value={libraryPriority} onChange={event => setLibraryPriority(event.target.value)} className="h-9 w-full rounded-xl border border-neutral-200 bg-white px-3 text-xs text-neutral-800 outline-none focus:border-primary" />
              </label>
              <label className="col-span-12 md:col-span-10">
                <span className="mb-1 block text-[11px] font-medium text-neutral-700">描述</span>
                <input value={libraryDescription} onChange={event => setLibraryDescription(event.target.value)} placeholder="说明这套术语适用于哪些业务、客户或产品" className="h-9 w-full rounded-xl border border-neutral-200 bg-white px-3 text-xs text-neutral-800 outline-none focus:border-primary" />
              </label>
              <div className="col-span-12 flex items-end justify-end gap-2 md:col-span-2">
                <button type="button" onClick={resetLibraryEditor} className="h-9 rounded-xl border border-border bg-background px-3 text-xs font-bold text-foreground hover:bg-muted">取消</button>
                <button type="submit" disabled={isSavingLibrary} className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-primary px-3 text-xs font-bold text-primary-foreground hover:bg-primary-hover disabled:opacity-50">
                  <Save className="h-3.5 w-3.5" /> {isSavingLibrary ? '保存中...' : '保存'}
                </button>
              </div>
            </div>
            {libraryError && <div className="mt-3 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">{libraryError}</div>}
          </form>
        )}
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px] xl:items-stretch">
      {/* 注册术语词条面板 */}
      <div className="rounded-2xl border border-border bg-card p-4 text-left font-sans shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <Tag className="w-5 h-5 text-neutral-700" />
          <h3 className="text-sm font-bold text-foreground font-sans">添加术语</h3>
        </div>

        <form onSubmit={handleSubmit} className="grid grid-cols-12 gap-4 items-end" id="glossary-form">
          <div className="col-span-12 md:col-span-6 xl:col-span-2">
            <label className="block text-[11px] font-medium text-neutral-700 mb-1 font-sans">源术语</label>
            <input
              id="glossary-source-input"
              type="text"
              placeholder="例如：My Home"
              value={newSource}
              onChange={(e) => setNewSource(e.target.value)}
              className="w-full px-3 py-2 bg-neutral-50 border border-neutral-200 rounded-xl text-xs text-neutral-800 focus:outline-none focus:border-neutral-900 focus:bg-white"
            />
          </div>

          <div className="col-span-12 md:col-span-6 xl:col-span-2">
            <label className="block text-[11px] font-medium text-neutral-700 mb-1 font-sans">目标术语</label>
            <input
              id="glossary-target-input"
              type="text"
              placeholder="例如：我的主页"
              value={newTarget}
              onChange={(e) => setNewTarget(e.target.value)}
              className="w-full px-3 py-2 bg-neutral-50 border border-neutral-200 rounded-xl text-xs text-neutral-800 focus:outline-none focus:border-neutral-900 focus:bg-white"
            />
          </div>

          <div className="col-span-12 md:col-span-4 xl:col-span-2">
            <label className="block text-[11px] font-medium text-neutral-700 mb-1 font-sans">类别</label>
            <select
              id="glossary-category-input"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              className="w-full px-3 py-2 bg-neutral-50 border border-neutral-200 rounded-xl text-xs text-neutral-800 focus:outline-none focus:border-neutral-900 focus:bg-white"
            >
              {GLOSSARY_CATEGORY_OPTIONS.map((category) => (
                <option key={category} value={category}>
                  {getCategoryLabel(category)}
                </option>
              ))}
            </select>
          </div>
          <div className="col-span-12 md:col-span-4 xl:col-span-4">
            <label className="block text-[11px] font-medium text-neutral-700 mb-1 font-sans">解释</label>
            <input
              id="glossary-explanation-input"
              type="text"
              placeholder="例如：标准的菜单栏或页面主标题"
              value={newExplanation}
              onChange={(e) => setNewExplanation(e.target.value)}
              className="w-full px-3 py-2 bg-neutral-50 border border-neutral-200 rounded-xl text-xs text-neutral-800 focus:outline-none focus:border-neutral-900 focus:bg-white"
            />
          </div>

          {errorMessage && (
            <div className="col-span-12 p-3 bg-red-50 border border-red-100 rounded-xl flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
              <p className="text-[11px] text-red-600 leading-relaxed">{errorMessage}</p>
            </div>
          )}

          {noticeMessage && (
            <div className="col-span-12 flex items-start gap-2 rounded-xl border border-warning/25 bg-warning-muted p-3">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning-foreground" />
              <p className="text-[11px] leading-relaxed text-warning-foreground">{noticeMessage}</p>
            </div>
          )}

          <button
            id="add-glossary-btn"
            type="submit"
            disabled={isAdding}
            className="col-span-12 md:col-span-2 h-9 rounded-xl bg-primary px-3 text-xs font-bold text-primary-foreground transition hover:bg-primary-hover disabled:opacity-50 flex items-center justify-center gap-1 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            {isAdding ? '...' : '添加'}
          </button>
        </form>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4 text-left font-sans shadow-sm">
        <div className="flex flex-col gap-2">
          <div className="flex items-start gap-2">
            <Upload className="mt-0.5 h-5 w-5 text-neutral-700" />
            <h3 className="text-sm font-bold text-foreground font-sans">导入术语表</h3>
          </div>

          <p className="text-xs leading-4 text-neutral-500">
            <span className="block">CSV UTF-8：原文,译文,源/目标语言代码</span>
            <span className="block text-[11px] text-neutral-400">示例：Change Order,变更单,EN,ZH</span>
          </p>

          <label className={`inline-flex h-9 w-full cursor-pointer items-center justify-center rounded-xl border border-neutral-200 bg-neutral-50 px-3 text-xs font-bold text-neutral-700 transition hover:bg-white ${isImporting ? 'pointer-events-none opacity-50' : ''}`}>
            <Upload className="mr-2 h-4 w-4" />
            {isImporting ? '处理中...' : '选择 CSV'}
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              disabled={isImporting}
              onChange={handleImportFile}
            />
          </label>
        </div>

        {importError && (
          <div className="mt-4 rounded-xl border border-red-100 bg-red-50 p-3 text-xs text-red-600">
            {importError}
          </div>
        )}

        {importPreview && (
          <div className="mt-4 rounded-xl border border-neutral-100 bg-neutral-50 p-4">
            <div className="flex flex-col gap-3">
              <div className="text-xs text-neutral-600">
                <span className="font-bold text-neutral-900">{importFileName}</span>
                <span className="ml-3">新增 {importPreview.additions.length}</span>
                <span className="ml-3">冲突 {importPreview.conflicts.length}</span>
                <span className="ml-3">跳过 {importPreview.skippedRows}</span>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={isImporting}
                  onClick={() => applyImportPreview('skip')}
                  className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground transition hover:bg-primary-hover disabled:opacity-50"
                >
                  导入并跳过冲突
                </button>
                {importPreview.conflicts.length > 0 && (
                  <button
                    type="button"
                    disabled={isImporting}
                    onClick={() => applyImportPreview('overwrite')}
                    className="rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-bold text-neutral-700 transition hover:bg-neutral-50 disabled:opacity-50"
                  >
                    覆盖冲突
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 术语列表 */}
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card text-left font-sans shadow-sm">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-neutral-50/75 border-b border-neutral-100 text-neutral-500 text-[11px] font-semibold uppercase tracking-wider font-sans">
                <th className="py-3 px-4">源术语</th>
                <th className="py-3 px-4">目标术语</th>
                <th className="py-3 px-4">类别 & 解释</th>
                <th className="py-3 px-4 text-right">
                  <Trash2 className="ml-auto h-3.5 w-3.5" aria-label="删除" />
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 text-xs">
              {filteredGlossary.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-12 text-center text-neutral-400 font-sans">
                    暂未在系统中检索或添加任何术语规则
                  </td>
                </tr>
              ) : (
                filteredGlossary.map((item) => {
                  const itemKey = glossaryTermKey(item);
                  const isEditingSource = editingSourceKey === itemKey;
                  const isEditingTarget = editingKey === itemKey;
                  const isEditingExplanation = editingExplanationKey === itemKey;
                  const isEditingCategory = editingCategoryKey === itemKey;
                  return (
                    <tr key={`${item.source}-${item.target}`} className="hover:bg-neutral-50/20 transition-colors group">
                      <td className="py-3 px-4 font-semibold text-neutral-800 font-mono">
                        {isEditingSource ? (
                          <input
                            type="text"
                            value={editingSource}
                            autoFocus
                            disabled={isSavingEdit}
                            onChange={(e) => setEditingSource(e.target.value)}
                            onBlur={() => saveEditSource(item)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                saveEditSource(item);
                              }
                              if (e.key === 'Escape') {
                                e.preventDefault();
                                cancelEditSource();
                              }
                            }}
                            className="w-full rounded-lg border border-neutral-200 bg-white px-2 py-1 text-xs font-semibold text-neutral-800 outline-none focus:border-neutral-500 focus:ring-1 focus:ring-neutral-500"
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => beginEditSource(item)}
                            className="group/edit flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1 text-left font-semibold text-neutral-800 transition hover:bg-neutral-100 hover:text-neutral-950"
                            title="点击编辑源术语"
                          >
                            <span className="min-w-0 truncate">{item.source}</span>
                            <Pencil className="h-3 w-3 shrink-0 text-neutral-400 transition group-hover/edit:text-neutral-700" aria-hidden="true" />
                          </button>
                        )}
                      </td>
                      <td className="py-3 px-4 font-medium text-neutral-900 font-sans">
                        {isEditingTarget ? (
                          <input
                            type="text"
                            value={editingTarget}
                            autoFocus
                            disabled={isSavingEdit}
                            onChange={(e) => setEditingTarget(e.target.value)}
                            onBlur={() => saveEditTarget(item)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                saveEditTarget(item);
                              }
                              if (e.key === 'Escape') {
                                e.preventDefault();
                                cancelEditTarget();
                              }
                            }}
                            className="w-full rounded-lg border border-green-200 bg-white px-2 py-1 text-xs font-semibold text-green-700 outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500"
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => beginEditTarget(item)}
                            className="group/edit flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1 text-left font-semibold text-green-700 transition hover:bg-green-50 hover:text-green-800"
                            title="点击编辑目标术语"
                          >
                            <span className="min-w-0 truncate">{item.target}</span>
                            <Pencil className="h-3 w-3 shrink-0 text-green-500/60 transition group-hover/edit:text-green-700" aria-hidden="true" />
                          </button>
                        )}
                      </td>
                      <td className="py-3 px-4 text-neutral-500 font-sans">
                        {isEditingCategory ? (
                          <select
                            value={editingCategory}
                            autoFocus
                            disabled={isSavingEdit}
                            onChange={(e) => {
                              setEditingCategory(e.target.value);
                              saveEditCategory(item, e.target.value);
                            }}
                            onBlur={cancelEditCategory}
                            onKeyDown={(e) => {
                              if (e.key === 'Escape') {
                                e.preventDefault();
                                cancelEditCategory();
                              }
                            }}
                            className="mb-1 w-full rounded-lg border border-neutral-200 bg-white px-2 py-1 text-xs font-semibold text-neutral-700 outline-none focus:border-neutral-500 focus:ring-1 focus:ring-neutral-500"
                          >
                            {item.category && !GLOSSARY_CATEGORY_OPTIONS.includes(item.category) && (
                              <option value={item.category}>{getCategoryLabel(item.category)}</option>
                            )}
                            {GLOSSARY_CATEGORY_OPTIONS.map((category) => (
                              <option key={category} value={category}>
                                {getCategoryLabel(category)}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <button
                            type="button"
                            onClick={() => beginEditCategory(item)}
                            className="group/edit mb-1 flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1 text-left font-semibold text-neutral-700 transition hover:bg-neutral-50 hover:text-neutral-900"
                            title="点击编辑类别"
                          >
                            <span className="min-w-0 truncate">{getCategoryLabel(item.category)}</span>
                            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-neutral-400 transition group-hover/edit:text-neutral-700" aria-hidden="true" />
                          </button>
                        )}
                        {isEditingExplanation ? (
                          <textarea
                            value={editingExplanation}
                            autoFocus
                            disabled={isSavingEdit}
                            onChange={(e) => setEditingExplanation(e.target.value)}
                            onBlur={() => saveEditExplanation(item)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                saveEditExplanation(item);
                              }
                              if (e.key === 'Escape') {
                                e.preventDefault();
                                cancelEditExplanation();
                              }
                            }}
                            className="mt-1 h-10 w-full resize-none rounded-lg border border-neutral-200 bg-white px-2 py-1 text-xs leading-4 text-neutral-700 outline-none focus:border-neutral-500 focus:ring-1 focus:ring-neutral-500"
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => beginEditExplanation(item)}
                            className="group/edit mt-1 flex h-10 w-full items-start justify-between gap-2 overflow-hidden rounded-lg px-2 py-1 text-left leading-4 text-neutral-500 transition hover:bg-neutral-50 hover:text-neutral-800"
                            title="点击编辑解释"
                          >
                            <span className="min-w-0 flex-1 overflow-hidden">{item.explanation || '-'}</span>
                            <Pencil className="mt-0.5 h-3 w-3 shrink-0 text-neutral-400 transition group-hover/edit:text-neutral-700" aria-hidden="true" />
                          </button>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <button
                          id={`btn-delete-glossary-${item.source}`}
                          type="button"
                          onClick={() => handleDelete(item.source, item.target)}
                          className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-lg border border-red-150 bg-red-50 text-red-600 transition hover:bg-red-100 cursor-pointer"
                          aria-label={`删除 ${item.source} -> ${item.target}`}
                          title={`删除 ${item.source} -> ${item.target}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
      </div>

      <AnimatePresence>
        {pendingTermConflict && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[1000] flex items-center justify-center bg-neutral-900/60 p-4 backdrop-blur-xs"
            onClick={() => !isResolvingTermConflict && setPendingTermConflict(null)}
          >
            <motion.div
              initial={{ scale: 0.96, y: 12 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.96, y: 12 }}
              onClick={(event) => event.stopPropagation()}
              className="w-full max-w-md rounded-2xl border border-border bg-card p-5 text-left shadow-2xl"
            >
              <div className="flex items-start gap-3">
                <div className="rounded-xl bg-warning-muted p-2 text-warning-foreground">
                  <AlertCircle className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-bold text-foreground">发现同原词术语</h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    “{pendingTermConflict.incoming.source}”在当前术语库和语言方向中已有其他译法。
                  </p>
                </div>
              </div>

              <div className="mt-4 space-y-2 rounded-xl border border-border bg-muted/30 p-3 text-xs">
                <div>
                  <span className="font-semibold text-muted-foreground">已有译法：</span>
                  <span className="ml-1 text-foreground">
                    {pendingTermConflict.existingTerms.map(term => term.target).join('；')}
                  </span>
                </div>
                <div>
                  <span className="font-semibold text-muted-foreground">新译法：</span>
                  <span className="ml-1 text-foreground">{pendingTermConflict.incoming.target}</span>
                </div>
                <div>
                  <span className="font-semibold text-muted-foreground">语言方向：</span>
                  <span className="ml-1 text-foreground">
                    {getTermLanguageDirection(pendingTermConflict.incoming, activeLibrary)?.label || '未限定'}
                  </span>
                </div>
              </div>

              <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
                保留多个译法适用于确有上下文差异的术语；替换会删除当前同原词译法，仅保留新译法。
              </p>

              <div className="mt-5 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  disabled={isResolvingTermConflict}
                  onClick={() => setPendingTermConflict(null)}
                  className="rounded-xl border border-border bg-background px-3 py-2 text-xs font-bold text-foreground transition hover:bg-muted disabled:opacity-50"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={isResolvingTermConflict}
                  onClick={() => void resolveTermConflict('keep')}
                  className="rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-xs font-bold text-primary transition hover:bg-primary/10 disabled:opacity-50"
                >
                  保留两个译法
                </button>
                <button
                  type="button"
                  disabled={isResolvingTermConflict}
                  onClick={() => void resolveTermConflict('replace')}
                  className="rounded-xl bg-primary px-3 py-2 text-xs font-bold text-primary-foreground transition hover:bg-primary-hover disabled:opacity-50"
                >
                  {isResolvingTermConflict ? '处理中...' : '替换已有术语'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

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
