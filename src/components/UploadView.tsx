import React, { useState, useRef, useEffect } from 'react';
import { Upload, FileText, Languages, ChevronRight, Play, CheckCircle2, AlertCircle, Sparkles, Plus, Trash2, PlusCircle, Check, Loader2, ArrowUp, ArrowDown, ChevronLeft, ChevronDown, Globe2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GlossaryImportPreview, GlossaryLibrary, GlossaryTerm, ProjectSummary, TranslationDirection, TranslationDomain } from '../types';
import { apiFetch } from '../lib/api';
import { GLOSSARY_CATEGORY_KEYS, GLOSSARY_CATEGORY_LABELS, DEFAULT_GLOSSARY_CATEGORY, normalizeGlossaryCategory, type GlossaryCategoryKey } from '../lib/glossary';
import { displayLanguageLabel } from '../lib/language';
interface RecommendedTerm {
    source: string;
    target: string;
    description?: string;
    category?: string;
    explanation?: string;
    origin?: string;
    status?: string;
    usageCount?: number;
    confidence?: number;
    reason?: string;
    checked?: boolean;
    sourceLang?: string;
    targetLang?: string;
    direction?: TranslationDirection | 'bidirectional';
}
type UploadTranslationDirection = TranslationDirection | 'auto';
const GLOSSARY_CATEGORIES: string[] = [...GLOSSARY_CATEGORY_KEYS];
const DEFAULT_CATEGORY = DEFAULT_GLOSSARY_CATEGORY;
function cleanCategory(desc: string | undefined): string {
    return normalizeGlossaryCategory(desc);
}
function getTermCategory(term: RecommendedTerm): string {
    return cleanCategory(term.category || term.description);
}
function getTermExplanation(term: RecommendedTerm): string {
    const fallback = term.description || '';
    if (!fallback)
        return term.explanation || '';
    // A description that merely repeats the category (in any known spelling)
    // must not be shown a second time as the term explanation.
    const canonical = normalizeGlossaryCategory(fallback);
    const isCategoryDesc = fallback === canonical || fallback === GLOSSARY_CATEGORY_LABELS[canonical as GlossaryCategoryKey];
    return term.explanation || (isCategoryDesc ? '' : fallback);
}
function compareGlossaryText(a = '', b = ''): number {
    return a.trim().localeCompare(b.trim(), undefined, { sensitivity: 'base', numeric: true });
}
function compareRecommendedTermRows(a: {
    term: RecommendedTerm;
    index: number;
}, b: {
    term: RecommendedTerm;
    index: number;
}): number {
    return compareGlossaryText(a.term.source, b.term.source)
        || compareGlossaryText(a.term.target, b.term.target)
        || a.index - b.index;
}
function formatFileSize(fileSizeBytes?: number, fileSizeMb?: number): string {
    if (typeof fileSizeBytes === 'number' && Number.isFinite(fileSizeBytes) && fileSizeBytes > 0) {
        if (fileSizeBytes < 1024 * 1024) {
            return `${Math.round(fileSizeBytes / 1024).toLocaleString()} KB`;
        }
        return `${(fileSizeBytes / (1024 * 1024)).toFixed(2)} MB`;
    }
    if (typeof fileSizeMb === 'number' && Number.isFinite(fileSizeMb) && fileSizeMb > 0) {
        return `${fileSizeMb.toFixed(2)} MB`;
    }
    return 'Unknown';
}
function getLanguagePairForDirection(direction: TranslationDirection) {
    return direction === 'zh-en'
        ? { sourceLang: 'Simplified Chinese', targetLang: 'English' }
        : { sourceLang: 'English', targetLang: 'Simplified Chinese' };
}
function getToneForSettings(targetLang: string): string {
    return `professional business/training ${targetLang}`;
}
function getGlossaryPresetForDomain(): string {
    return 'business';
}
function inferProjectDirection(project: ProjectSummary | null, fallback: TranslationDirection): TranslationDirection {
    if (project?.translationDirection) {
        return project.translationDirection;
    }
    const source = String(project?.sourceLang || '').toLowerCase();
    const target = String(project?.targetLang || '').toLowerCase();
    if (source.includes('chinese') || target.includes('english'))
        return 'zh-en';
    if (source.includes('english') || target.includes('chinese'))
        return 'en-zh';
    return fallback;
}
function getGlossaryLanguageLabels(sourceLang: string, targetLang: string) {
    return {
        sourceHeader: `原词（${displayLanguageLabel(sourceLang)}）`,
        targetHeader: `推荐译文（${displayLanguageLabel(targetLang)}）`,
        sourcePlaceholder: `${displayLanguageLabel(sourceLang)}词条`,
        targetPlaceholder: `${displayLanguageLabel(targetLang)}译文`
    };
}
interface UploadViewProps {
    onUploadSuccess: (project: ProjectSummary | null) => void;
    activeProject: ProjectSummary | null;
    onStartTranslation: (sourceLang: string, targetLang: string, tone: string, glossaryPreset: string, translationDirection?: TranslationDirection, translationDomain?: TranslationDomain) => void;
    isTranslating: boolean;
    onProjectUpdated?: (project: any) => void;
    currentStep?: number;
    onNextStep?: (latestTerms?: RecommendedTerm[]) => void;
    onStepChange?: (step: number) => void;
    onOpenGlobalGlossary?: () => void;
    onProjectGlossaryChanged?: (sources: string[]) => void;
    personalGlossary?: GlossaryTerm[];
    glossaryLibraries?: GlossaryLibrary[];
    targetLanguage?: string;
    languageSettings?: React.ReactNode;
}
export default function UploadView({ onUploadSuccess, activeProject, onStartTranslation, isTranslating, onProjectUpdated, currentStep = 1, onNextStep, onStepChange, onOpenGlobalGlossary, personalGlossary = [], glossaryLibraries = [], targetLanguage, languageSettings }: UploadViewProps) {
    const [isDragging, setIsDragging] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadProgressInfo, setUploadProgressInfo] = useState<string | null>(null);
    const [uploadNote, setUploadNote] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    // Settings state
    const [translationDirection, setTranslationDirection] = useState<UploadTranslationDirection>('auto');
    const [sourceLang, setSourceLang] = useState('自动检测');
    const [targetLang, setTargetLang] = useState('Simplified Chinese');
    const [tone, setTone] = useState(getToneForSettings('Simplified Chinese'));
    const translationDomain: TranslationDomain = 'business';
    const glossaryPreset = getGlossaryPresetForDomain();
    useEffect(() => {
        if (!activeProject) {
            if (currentStep === 1) {
                setTranslationDirection('auto');
                setSourceLang('自动检测');
                setTargetLang('Simplified Chinese');
                setTone(getToneForSettings('Simplified Chinese'));
            }
            return;
        }
        const projectDirection = inferProjectDirection(activeProject, translationDirection === 'auto' ? 'en-zh' : translationDirection);
        const pair = getLanguagePairForDirection(projectDirection);
        setTranslationDirection(projectDirection);
        setSourceLang(activeProject.sourceLang || pair.sourceLang);
        setTargetLang(activeProject.targetLang || pair.targetLang);
        setTone(activeProject.tone || getToneForSettings(activeProject.targetLang || pair.targetLang));
    }, [
        activeProject?.id,
        activeProject?.sourceLang,
        activeProject?.targetLang,
        activeProject?.translationDirection,
        activeProject?.translationDomain,
        activeProject?.tone,
        currentStep
    ]);
    const activeGlossaryDirection = inferProjectDirection(activeProject, translationDirection === 'auto' ? 'en-zh' : translationDirection);
    const activeGlossaryPair = {
        sourceLang: activeProject?.sourceLang || sourceLang || 'English',
        targetLang: activeProject?.targetLang || targetLanguage || targetLang || 'Simplified Chinese'
    };
    const glossaryLanguageLabels = getGlossaryLanguageLabels(activeGlossaryPair.sourceLang, activeGlossaryPair.targetLang);
    const buildUploadSettingsPayload = () => {
        const selectedTargetLang = targetLanguage || targetLang;
        const payload: Record<string, string> = {
            translationDirection: 'auto',
            targetLang: selectedTargetLang,
            tone: getToneForSettings(selectedTargetLang),
            translationDomain,
            glossaryPreset
        };
        return payload;
    };
    // State for recommended glossary terms
    const [recommendedTerms, setRecommendedTerms] = useState<RecommendedTerm[]>([]);
    const targetBeforeEditRef = useRef<Record<number, string>>({});
    // Custom manual entry fields
    const [newSource, setNewSource] = useState('');
    const [newTarget, setNewTarget] = useState('');
    const [newDesc, setNewDesc] = useState<string>(DEFAULT_CATEGORY);
    const [deleteConfirm, setDeleteConfirm] = useState<{
        index: number;
        word: string;
    } | null>(null);
    const [scrollControlDirection, setScrollControlDirection] = useState<'up' | 'down' | null>(null);
    const [glossaryImportPreview, setGlossaryImportPreview] = useState<GlossaryImportPreview | null>(null);
    const [isImportingGlossary, setIsImportingGlossary] = useState(false);
    const [glossaryImportError, setGlossaryImportError] = useState<string | null>(null);
    const glossaryInputRef = useRef<HTMLInputElement>(null);
    const [editingProjectExplanationIndex, setEditingProjectExplanationIndex] = useState<number | null>(null);
    const [editingProjectExplanation, setEditingProjectExplanation] = useState('');
    const [selectedLibraryIds, setSelectedLibraryIds] = useState<string[]>([]);
    const [isSavingLibraries, setIsSavingLibraries] = useState(false);
    const preDetectStatus = activeProject?.preDetectStatus;
    const isPreDetectActive = preDetectStatus === 'pending' || preDetectStatus === 'running';
    const selectedLibraries = glossaryLibraries.filter(library => selectedLibraryIds.includes(library.id));
    const librarySelectionLabel = selectedLibraries.length === 0
        ? '未选择术语库'
        : selectedLibraries.length === 1
            ? selectedLibraries[0].name
            : `已选 ${selectedLibraries.length} 个术语库`;
    useEffect(() => {
        if (!activeProject) {
            setSelectedLibraryIds([]);
            return;
        }
        const persistedIds = activeProject.selectedGlossaryLibraryIds || [];
        setSelectedLibraryIds(persistedIds.length > 0
            ? persistedIds
            : glossaryLibraries.filter(library => library.id.startsWith('default_')).map(library => library.id));
    }, [activeProject?.id, activeProject?.selectedGlossaryLibraryIds, glossaryLibraries]);
    const normalizeSourceKey = (value?: string) => (value || '').trim().toLowerCase();
    const personalSourceSet = new Set(personalGlossary.map(term => normalizeSourceKey(term.source)));
    const isPersonalGlossaryMatch = (term: RecommendedTerm) => personalSourceSet.has(normalizeSourceKey(term.source)) || (term.origin || '').toLowerCase() === 'global';
    const isNeedsReviewTerm = (term: RecommendedTerm) => ['candidate', 'ambiguous', 'needs_review'].includes((term.status || '').toLowerCase());
    const isAiTerm = (term: RecommendedTerm) => (term.origin || '').toLowerCase() === 'ai';
    const isManualOrImportedTerm = (term: RecommendedTerm) => {
        const origin = (term.origin || '').toLowerCase();
        return origin === 'manual' || origin === 'imported';
    };
    const selectedProjectCount = recommendedTerms.filter(term => term.checked !== false).length;
    const personalMatchCount = recommendedTerms.filter(isPersonalGlossaryMatch).length;
    const aiRecommendationCount = recommendedTerms.filter(isAiTerm).length;
    const filteredRecommendedTerms = recommendedTerms
        .map((term, index) => ({ term, index }))
        .sort(compareRecommendedTermRows);
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
                if (!canScroll)
                    setScrollControlDirection(null);
                return;
            }
            const direction = delta > 0 ? 'down' : 'up';
            accumulatedDistance = direction === lastDirection
                ? accumulatedDistance + Math.abs(delta)
                : Math.abs(delta);
            lastDirection = direction;
            lastScrollY = scrollY;
            if (accumulatedDistance < threshold)
                return;
            if (direction === 'up' && scrollY > 100) {
                setScrollControlDirection('up');
            }
            else if (direction === 'down' && distanceFromBottom > 100) {
                setScrollControlDirection('down');
            }
            else {
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
    // Load recommended terms whenever activeProject updates
    useEffect(() => {
        if (activeProject && activeProject.preDetectReport) {
            setRecommendedTerms(activeProject.preDetectReport.recommendedGlossary || []);
        }
        else {
            setRecommendedTerms([]);
        }
    }, [activeProject?.id, activeProject?.preDetectReport]);
    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    };
    const handleDragLeave = () => {
        setIsDragging(false);
    };
    const handleDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        setUploadError(null);
        const files = e.dataTransfer.files;
        if (files && files.length > 0) {
            const file = files[0];
            if (!/\.(pptx|docx|xlsx)$/i.test(file.name)) {
                setUploadError('Only .pptx, .docx, and .xlsx files are supported.');
                return;
            }
            await uploadFile(file);
        }
    };
    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (files && files.length > 0) {
            setUploadError(null);
            await uploadFile(files[0]);
        }
    };
    const uploadFile = async (file: File) => {
        setIsUploading(true);
        setUploadError(null);
        setUploadNote(null);
        if (!/\.(pptx|docx|xlsx)$/i.test(file.name)) {
            setUploadError('Only .pptx, .docx, and .xlsx files are supported.');
            setIsUploading(false);
            return;
        }
        const sizeMB = file.size / (1024 * 1024);
        // The browser transfers the selected file only to the Node process on localhost.
        {
            setUploadProgressInfo(`正在从本地导入并解析文档 (${sizeMB.toFixed(1)} MB)...`);
            try {
                const formData = new FormData();
                formData.append('file', file);
                formData.append('originalName', file.name);
                const uploadSettings = buildUploadSettingsPayload();
                Object.entries(uploadSettings).forEach(([key, value]) => {
                    formData.append(key, value);
                });
                const response = await apiFetch('/api/projects/upload', {
                    method: 'POST',
                    body: formData,
                });
                if (!response.ok) {
                    let msg = 'Failed to analyze document file.';
                    try {
                        const contentType = response.headers.get('content-type');
                        if (contentType && contentType.includes('application/json')) {
                            const errorData = await response.json();
                            msg = errorData.error || msg;
                        }
                        else {
                            const errorText = await response.text();
                            msg = errorText.substring(0, 150) || `Server returned error status (${response.status})`;
                        }
                    }
                    catch (inner) {
                        msg = `Server returned status code ${response.status}`;
                    }
                    throw new Error(msg);
                }
                const project: ProjectSummary = await response.json();
                onUploadSuccess(project);
            }
            catch (err: any) {
                setUploadError(err.message || 'An error occurred during file upload.');
            }
            finally {
                setIsUploading(false);
                setUploadProgressInfo(null);
            }
            return;
        }
    };
    const triggerSelectFile = () => {
        fileInputRef.current?.click();
    };
    // Sync / save updated terminology list to backend
    const syncGlossaryWithBackend = async (updatedList: RecommendedTerm[]) => {
        if (!activeProject)
            return;
        // Filter only those selected to build project's active glossary
        const activeGlossary = updatedList
            .filter(t => t.checked !== false)
            .map(t => ({
            source: t.source,
            target: t.target,
            category: getTermCategory(t),
            explanation: getTermExplanation(t),
            description: getTermCategory(t),
            sourceLang: t.sourceLang || activeProject.sourceLang || activeGlossaryPair.sourceLang,
            targetLang: t.targetLang || activeProject.targetLang || activeGlossaryPair.targetLang,
            direction: t.direction || activeProject.translationDirection || activeGlossaryDirection
        }));
        try {
            const res = await apiFetch(`/api/projects/${activeProject.id}/glossary`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    glossary: activeGlossary,
                    preDetectReport: {
                        ...activeProject.preDetectReport,
                        recommendedGlossary: updatedList
                    }
                })
            });
            if (res.ok) {
                const data = await res.json();
                if (onProjectUpdated) {
                    onProjectUpdated(data);
                }
            }
        }
        catch (err) {
            console.error('Failed to sync glossary modifications:', err);
        }
    };
    const handleGlossaryFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !activeProject)
            return;
        setGlossaryImportError(null);
        setGlossaryImportPreview(null);
        setIsImportingGlossary(true);
        try {
            const formData = new FormData();
            formData.append('file', file);
            const res = await apiFetch(`/api/projects/${activeProject.id}/glossary/import-preview`, {
                method: 'POST',
                body: formData
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || '导入术语表失败。');
            }
            const preview: GlossaryImportPreview = await res.json();
            setGlossaryImportPreview(preview);
        }
        catch (err: any) {
            setGlossaryImportError(err.message || '导入术语表失败。');
        }
        finally {
            setIsImportingGlossary(false);
            if (glossaryInputRef.current)
                glossaryInputRef.current.value = '';
        }
    };
    const applyGlossaryImport = async (conflictStrategy: 'skip' | 'overwrite') => {
        if (!activeProject || !glossaryImportPreview)
            return;
        setIsImportingGlossary(true);
        setGlossaryImportError(null);
        try {
            const res = await apiFetch(`/api/projects/${activeProject.id}/glossary/import-apply`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    terms: glossaryImportPreview.terms,
                    conflictStrategy
                })
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || '应用术语表导入失败。');
            }
            const data = await res.json();
            if (onProjectUpdated)
                onProjectUpdated(data.project);
            const updatedGlossary = (data.project.glossary || []).map((term: any) => ({
                source: term.source,
                target: term.target,
                category: term.category || term.description,
                explanation: term.explanation || '',
                description: term.category || term.description,
                checked: true
            }));
            setRecommendedTerms(updatedGlossary);
            setGlossaryImportPreview(null);
        }
        catch (err: any) {
            setGlossaryImportError(err.message || '应用术语表导入失败。');
        }
        finally {
            setIsImportingGlossary(false);
        }
    };
    const handleToggleLibrary = async (libraryId: string) => {
        if (!activeProject || isSavingLibraries)
            return;
        const nextIds = selectedLibraryIds.includes(libraryId)
            ? selectedLibraryIds.filter(id => id !== libraryId)
            : [...selectedLibraryIds, libraryId];
        setSelectedLibraryIds(nextIds);
        setIsSavingLibraries(true);
        try {
            const res = await apiFetch(`/api/projects/${activeProject.id}/glossaries/select`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ libraryIds: nextIds })
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || '术语库选择保存失败。');
            }
            const data = await res.json();
            onProjectUpdated?.(data.project);
            const nextGlossary = (data.project?.glossary || []).map((term: any) => ({
                ...term,
                category: term.category || term.description,
                explanation: term.explanation || ''
            }));
            setRecommendedTerms(nextGlossary);
        }
        catch (err: any) {
            setSelectedLibraryIds(activeProject.selectedGlossaryLibraryIds || []);
            setGlossaryImportError(err.message || '术语库选择保存失败。');
        }
        finally {
            setIsSavingLibraries(false);
        }
    };
    // Edit target translation word with immediate update on blurring text field
    const handleEditTargetTerm = (index: number, newTargetVal: string) => {
        const updated = [...recommendedTerms];
        updated[index] = { ...updated[index], target: newTargetVal };
        setRecommendedTerms(updated);
    };
    const handleBlurTarget = (index: number) => {
        const before = targetBeforeEditRef.current[index];
        delete targetBeforeEditRef.current[index];
        if (before === undefined || before === recommendedTerms[index]?.target)
            return;
        syncGlossaryWithBackend(recommendedTerms);
    };
    const beginEditProjectExplanation = (index: number, term: RecommendedTerm) => {
        setEditingProjectExplanationIndex(index);
        setEditingProjectExplanation(getTermExplanation(term));
    };
    const cancelEditProjectExplanation = () => {
        setEditingProjectExplanationIndex(null);
        setEditingProjectExplanation('');
    };
    const saveProjectExplanation = (index: number) => {
        const nextExplanation = editingProjectExplanation.trim();
        if (getTermExplanation(recommendedTerms[index]) === nextExplanation) {
            cancelEditProjectExplanation();
            return;
        }
        const updated = recommendedTerms.map((term, idx) => {
            if (idx === index) {
                return { ...term, explanation: nextExplanation };
            }
            return term;
        });
        setRecommendedTerms(updated);
        syncGlossaryWithBackend(updated);
        cancelEditProjectExplanation();
    };
    // Remove term entirely from recommendation list
    const handleDeleteTerm = (index: number) => {
        const updated = recommendedTerms.filter((_, i) => i !== index);
        setRecommendedTerms(updated);
        syncGlossaryWithBackend(updated);
    };
    // Demo Project initializer trigger
    const handleDemoClick = async () => {
        setIsUploading(true);
        setUploadError(null);
        setUploadProgressInfo('正在生成并加载 AI 演示示例文稿...');
        try {
            const response = await apiFetch('/api/projects/demo', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            if (!response.ok) {
                throw new Error('Failed to load demo project');
            }
            const project: ProjectSummary = await response.json();
            onUploadSuccess(project);
        }
        catch (err: any) {
            setUploadError(err.message || 'Error occurred while loading demo.');
        }
        finally {
            setIsUploading(false);
            setUploadProgressInfo(null);
        }
    };
    const stepOneNavigation = (<div className="mx-auto flex w-full items-center justify-end border-b border-border/80 pb-6">
      <button type="button" onClick={() => onStepChange?.(2)} aria-label="下一步" title={activeProject ? '下一步' : '请先导入文件'} disabled={!activeProject || isUploading} className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-primary bg-primary text-sm font-semibold text-primary-foreground shadow-sm transition-all hover:bg-primary-hover disabled:cursor-not-allowed disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none">
        <ChevronRight className="h-5 w-5"/>
      </button>
    </div>);
    // Unified Step Conditional Render
    if (currentStep === 1) {
        if (activeProject) {
            const fileSizeLabel = formatFileSize(activeProject.fileSizeBytes, activeProject.fileSize);
            const pages = activeProject.slideCount;
            const estimatedChars = activeProject.estimatedChars || (activeProject.uniqueCount * 38) || 350;
            return (<div className="flex-1 px-4 pb-12 pt-0 font-sans">
          <div className="mx-auto max-w-4xl text-left">
            {stepOneNavigation}
            <div className="mb-8 mt-10">
              <h2 className="text-2xl font-bold text-foreground">导入本地文件</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                支持 PPTX、DOCX、XLSX 等多种格式，结合文档上下文、术语治理、人工审校与格式保留，生成可直接交付的本地化文档。
              </p>
            </div>

            <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
              {languageSettings && (<div className="p-3">{languageSettings}</div>)}
              <div className="flex min-h-[260px] flex-col justify-between border-t border-border px-8 py-8">
                <div>
                  <div className="flex min-w-0 items-center gap-4">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <FileText className="h-6 w-6"/>
                    </div>
                    <div className="min-w-0">
                      <p className="mb-1 text-sm font-medium text-muted-foreground">已导入文件</p>
                      <p className="truncate text-lg font-semibold text-foreground" title={activeProject.originalName}>{activeProject.originalName}</p>
                    </div>
                  </div>

                  <div className="mt-8 grid grid-cols-1 gap-5 border-t border-border pt-6 sm:grid-cols-3 sm:gap-6">
                    <div>
                      <p className="mb-1 text-xs font-medium text-muted-foreground">文件大小</p>
                      <p className="text-base font-semibold text-foreground">{fileSizeLabel}</p>
                    </div>
                    <div>
                      <p className="mb-1 text-xs font-medium text-muted-foreground">总页数</p>
                      <p className="text-base font-semibold text-foreground">{pages} 页</p>
                    </div>
                    <div>
                      <p className="mb-1 text-xs font-medium text-muted-foreground">预计字符数</p>
                      <p className="text-base font-semibold text-foreground">{estimatedChars.toLocaleString()}</p>
                    </div>
                  </div>
                </div>

                <button onClick={() => {
                    onUploadSuccess(null);
                    if (onStepChange)
                        onStepChange(1);
                }} className="mt-6 inline-flex w-fit items-center rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:border-foreground hover:text-foreground cursor-pointer">
                  更换文件
                </button>
              </div>
            </div>

          </div>
        </div>);
        }
        return (<div className="flex-1 px-4 pb-12 pt-0 font-sans">
        <div className="mx-auto max-w-4xl text-left">
          {stepOneNavigation}
          <div className="mb-8 mt-10">
            <h2 className="text-2xl font-bold text-foreground">导入本地文件</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              支持 PPTX、DOCX、XLSX 等多种格式，结合文档上下文、术语治理、人工审校与格式保留，生成可直接交付的本地化文档。
            </p>
          </div>

          <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
            {languageSettings && (<div className="p-3">{languageSettings}</div>)}
            <div onDragOver={isUploading ? undefined : handleDragOver} onDragLeave={isUploading ? undefined : handleDragLeave} onDrop={isUploading ? undefined : handleDrop} onClick={isUploading ? undefined : triggerSelectFile} className={`relative flex min-h-[260px] flex-col items-center justify-center border-t border-dashed px-8 py-12 transition-all ${isUploading
                ? 'border-muted bg-secondary/50 cursor-wait'
                : isDragging
                    ? 'border-primary bg-primary/5 cursor-pointer'
                    : 'border-border bg-secondary hover:border-primary/50 hover:bg-primary/5 cursor-pointer'}`}>
              {isUploading ? (<Loader2 className="mb-4 h-12 w-12 text-primary animate-spin"/>) : (<Upload className="mb-4 h-12 w-12 text-primary"/>)}
              <h3 className="mb-2 text-xl font-semibold text-foreground">
                {isUploading ? '正在导入和解析' : '拖拽本地文件到此处'}
              </h3>
              <p className="text-center text-sm text-muted-foreground">
                {isUploading ? '系统正在快速分析和提取文档内容，请稍候' : '或点击浏览你的计算机'}
              </p>
              {!isUploading && (<p className="mt-3 text-center text-xs text-muted-foreground">
                原始文档仅由本机服务处理；翻译时仅将提取的文本发送至你配置的模型服务。
              </p>)}
              <input ref={fileInputRef} type="file" accept=".pptx,.docx,.xlsx" onChange={handleFileChange} className="hidden" disabled={isUploading}/>
            </div>
          </div>

          {uploadNote && (<div className="mt-4 text-center max-w-md mx-auto bg-primary/10 p-3 rounded-2xl border border-primary/20">
              <p className="text-[11px] text-primary font-sans leading-relaxed flex items-center justify-center gap-1.5">
                💡 <span className="font-medium">{uploadNote}</span>
              </p>
            </div>)}

          {/* Error notification */}
          <AnimatePresence>
            {uploadError && (<motion.div id="upload-error-banner" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }} className="mt-6 p-4 bg-destructive/10 border border-destructive/20 rounded-2xl flex items-start gap-3 text-left font-sans">
                <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5"/>
                <div>
                  <p className="text-xs font-bold text-destructive">Upload Action Failed</p>
                  <p className="text-xs text-destructive mt-0.5 leading-relaxed">{uploadError}</p>
                </div>
              </motion.div>)}
          </AnimatePresence>
        </div>
      </div>);
    }
    // Else, return Step 2 (Glossary Table Review Layout)
    return (<div className="flex-1 animate-fade">
      <div className="mx-auto w-full max-w-none">
        <div className="mx-auto flex w-full max-w-none items-center justify-between border-b border-border/80 pb-6">
          <button type="button" onClick={() => {
            if (onStepChange)
                onStepChange(1);
        }} aria-label="上一步" title="上一步" className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-muted/60 text-sm font-semibold text-foreground transition-all hover:bg-muted cursor-pointer">
            <ChevronLeft className="w-5 h-5"/>
          </button>

          <button type="button" onClick={() => onNextStep?.(recommendedTerms)} aria-label="下一步" title="下一步" className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-primary bg-primary text-sm font-semibold text-primary-foreground shadow-sm transition-all hover:bg-primary-hover cursor-pointer">
            <ChevronRight className="w-5 h-5"/>
          </button>
        </div>

        <div className="mt-10 mb-8 text-left font-sans">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-2">
            <div className="min-w-[180px] shrink-0">
            <h2 className="text-2xl font-bold text-foreground tracking-tight">
              本文术语表
            </h2>
            {isPreDetectActive ? (<p className="mt-1.5 flex items-start gap-1.5 text-sm font-semibold leading-5 text-amber-700">
                <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin"/>
                <span>AI 正在检测和推荐术语，请稍等……你也可以手动添加项目术语。</span>
              </p>) : preDetectStatus === 'failed' ? (<p className="mt-1.5 text-sm font-semibold leading-5 text-destructive">
                AI 术语检测失败，可手动添加项目术语。{activeProject?.preDetectError ? ` ${activeProject.preDetectError}` : ''}
              </p>) : (<p className="mt-1.5 text-sm text-muted-foreground">
                本文翻译将遵循以下术语表：
              </p>)}
            </div>
            {glossaryLibraries.length > 0 && (<div className="flex min-w-0 flex-1 items-start justify-end">
                <details className="group relative min-w-0 w-[280px] shrink">
                  <summary aria-label="选择用于本项目的术语库" className="flex h-[58px] min-w-0 cursor-pointer list-none items-center justify-between gap-3 rounded-xl border border-border bg-card px-3 py-2 text-foreground shadow-sm transition hover:border-primary/40 hover:bg-muted/30 group-open:border-primary/40 [&::-webkit-details-marker]:hidden">
                    <span className="min-w-0">
                      <span className="block text-[10px] font-semibold text-muted-foreground">用于本项目的术语库</span>
                      <span className="mt-0.5 block truncate text-sm font-semibold text-foreground">{librarySelectionLabel}</span>
                    </span>
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"/>
                  </summary>
                  <div className="absolute left-0 top-full z-40 mt-2 w-[320px] max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-background p-2 shadow-xl">
                    <div className="max-h-64 space-y-1 overflow-y-auto">
                      {glossaryLibraries.map(library => (<label key={library.id} className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2.5 text-sm text-foreground transition hover:bg-muted/60">
                          <input type="checkbox" checked={selectedLibraryIds.includes(library.id)} onChange={() => handleToggleLibrary(library.id)} disabled={isSavingLibraries} className="h-4 w-4 shrink-0 accent-primary"/>
                          <span className="min-w-0 flex-1 truncate font-medium">{library.name}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">{library.terms.length} 条</span>
                        </label>))}
                    </div>
                  </div>
                </details>
                {isSavingLibraries && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground"/>}
              </div>)}
            <div className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-3 lg:w-[315px]">
              <div className="rounded-xl border border-border bg-card px-3 py-2 text-left shadow-sm">
                <p className="text-[10px] font-semibold text-muted-foreground">本文术语</p>
                <p className="mt-0.5 text-lg font-bold leading-tight text-foreground">{selectedProjectCount}<span className="text-xs text-muted-foreground"> / {recommendedTerms.length}</span></p>
              </div>
              <div className="rounded-xl border border-border bg-card px-3 py-2 text-left shadow-sm">
                <p className="text-[10px] font-semibold text-muted-foreground">个人术语命中</p>
                <p className="mt-0.5 text-lg font-bold leading-tight text-foreground">{personalMatchCount}</p>
              </div>
              <div className="rounded-xl border border-border bg-card px-3 py-2 text-left shadow-sm">
                <p className="text-[10px] font-semibold text-muted-foreground">AI 推荐</p>
                <p className="mt-0.5 text-lg font-bold leading-tight text-foreground">{aiRecommendationCount}</p>
              </div>
            </div>
          </div>
        </div>

        <>
            <div className="space-y-4">
              <div className="grid grid-cols-12 gap-4 border-b border-border pb-4 font-sans text-left">
                <div className="col-span-3">
                  <p className="text-sm font-semibold text-foreground">{glossaryLanguageLabels.sourceHeader}</p>
                </div>
                <div className="col-span-4">
                  <p className="text-sm font-semibold text-foreground">{glossaryLanguageLabels.targetHeader}</p>
                </div>
                <div className="col-span-4">
                  <p className="text-sm font-semibold text-foreground">领域 & 解释</p>
                </div>
                <div className="col-span-1 text-right">
                  <p className="text-sm font-semibold text-foreground">操作</p>
                </div>
              </div>

              {recommendedTerms.length > 0 && filteredRecommendedTerms.length === 0 && (<div className="rounded-xl border border-dashed border-border bg-muted/20 p-4 text-left text-sm font-medium text-muted-foreground">
                  没有符合当前筛选条件的术语。
                </div>)}

              {filteredRecommendedTerms.map(({ term, index }) => (<div key={`${term.source}-${index}`} className="grid grid-cols-12 gap-4 rounded-xl bg-card p-4 shadow-sm hover:shadow-md transition-shadow border border-neutral-150 font-sans text-left items-center">
                  <div className="col-span-3">
                    <p className="font-medium text-foreground">{term.source}</p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {isPersonalGlossaryMatch(term) && <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-bold text-green-800">个人术语库</span>}
                      {isAiTerm(term) && <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold text-blue-800">AI 推荐</span>}
                      {isManualOrImportedTerm(term) && <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-bold text-neutral-700">手动/导入</span>}
                      {isNeedsReviewTerm(term) && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">需复核</span>}
                      {!isPersonalGlossaryMatch(term) && !isAiTerm(term) && !isManualOrImportedTerm(term) && !isNeedsReviewTerm(term) && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold text-muted-foreground">本文术语</span>}
                    </div>
                  </div>
                  <div className="col-span-4 flex items-center bg-transparent">
                    <input type="text" value={term.target} onFocus={() => {
                targetBeforeEditRef.current[index] = term.target;
            }} onChange={(e) => handleEditTargetTerm(index, e.target.value)} onBlur={() => handleBlurTarget(index)} className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary font-sans font-medium"/>
                  </div>
                  <div className="col-span-4">
                    <select value={getTermCategory(term)} onChange={(e) => {
                const updatedVal = e.target.value;
                const updated = recommendedTerms.map((t, idx) => {
                    if (idx === index) {
                        return { ...t, category: updatedVal, description: updatedVal };
                    }
                    return t;
                });
                setRecommendedTerms(updated);
                syncGlossaryWithBackend(updated);
            }} className="max-w-48 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-semibold text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer hover:bg-muted/30 transition-all font-sans">
                      {GLOSSARY_CATEGORIES.map(cat => (<option key={cat} value={cat}>
                          {GLOSSARY_CATEGORY_LABELS[cat as GlossaryCategoryKey] || cat}
                        </option>))}
                    </select>
                    {editingProjectExplanationIndex === index ? (<textarea value={editingProjectExplanation} autoFocus onChange={(e) => setEditingProjectExplanation(e.target.value)} onBlur={() => saveProjectExplanation(index)} onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        saveProjectExplanation(index);
                    }
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        cancelEditProjectExplanation();
                    }
                }} className="mt-2 h-12 w-full resize-none rounded-lg border border-border bg-background px-2 py-1 text-xs leading-4 text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"/>) : (<button type="button" onClick={() => beginEditProjectExplanation(index, term)} className="mt-2 block h-10 w-full overflow-hidden rounded-lg bg-muted/30 px-2 py-1 text-left text-xs leading-4 text-muted-foreground transition hover:bg-muted hover:text-foreground" title={getTermExplanation(term) || '暂无解释'}>
                        {getTermExplanation(term) || '暂无解释'}
                      </button>)}
                  </div>
                  <div className="col-span-1 flex items-center justify-end gap-2">
                    <button type="button" onClick={() => setDeleteConfirm({ index, word: term.source })} className="rounded-lg p-2 hover:bg-destructive/10 transition-colors cursor-pointer" title="删除">
                      <Trash2 className="h-4 w-4 text-destructive"/>
                    </button>
                  </div>
                </div>))}

              <div className="grid grid-cols-12 gap-4 rounded-xl border-2 border-dashed border-muted bg-muted/30 p-4 font-sans text-left items-center">
                <input type="text" placeholder={glossaryLanguageLabels.sourcePlaceholder} value={newSource} onChange={(e) => setNewSource(e.target.value)} className="col-span-3 rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none"/>
                <input type="text" placeholder={glossaryLanguageLabels.targetPlaceholder} value={newTarget} onChange={(e) => setNewTarget(e.target.value)} className="col-span-4 rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none"/>
                <select value={newDesc || DEFAULT_CATEGORY} onChange={(e) => setNewDesc(e.target.value)} className="col-span-3 max-w-48 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none cursor-pointer font-sans">
                  {GLOSSARY_CATEGORIES.map(cat => (<option key={cat} value={cat}>
                      {GLOSSARY_CATEGORY_LABELS[cat as GlossaryCategoryKey] || cat}
                    </option>))}
                </select>
                <div className="col-span-2 flex items-center justify-end">
                  <button type="button" onClick={() => {
            if (newSource.trim() && newTarget.trim()) {
                const newTerm: RecommendedTerm = {
                    source: newSource.trim(),
                    target: newTarget.trim(),
                    category: newDesc || DEFAULT_CATEGORY,
                    description: newDesc || DEFAULT_CATEGORY,
                    explanation: 'Manually added customized term',
                    origin: 'manual',
                    sourceLang: activeProject?.sourceLang || activeGlossaryPair.sourceLang,
                    targetLang: activeProject?.targetLang || activeGlossaryPair.targetLang,
                    direction: activeProject?.translationDirection || activeGlossaryDirection,
                    checked: true
                };
                const updated = [...recommendedTerms, newTerm];
                setRecommendedTerms(updated);
                setNewSource('');
                setNewTarget('');
                setNewDesc(DEFAULT_CATEGORY);
                syncGlossaryWithBackend(updated);
            }
        }} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:shadow-md transition-all cursor-pointer">
                    添加
                  </button>
                </div>
              </div>
            </div>
        </>
        {/* 导航按钮组 */}
        <div className="mt-12 flex justify-between items-center font-sans">
          <button type="button" onClick={() => {
            if (onStepChange)
                onStepChange(1);
        }} className="inline-flex items-center gap-2 rounded-lg border border-border px-5 py-3 font-semibold text-muted-foreground hover:text-foreground hover:bg-muted transition-all cursor-pointer">
            <ChevronLeft className="w-4 h-4"/>
            <span>上一步</span>
          </button>

          <button type="button" onClick={() => onNextStep?.(recommendedTerms)} className="inline-flex items-center gap-2 rounded-lg bg-primary px-8 py-3 font-semibold text-primary-foreground shadow-sm transition-all hover:shadow-md active:shadow-none cursor-pointer animate-fade">
            <span>✓</span>
            <span>确认并开始翻译</span>
          </button>
        </div>

        {/* 删除确认弹窗 */}
        {deleteConfirm && (<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 font-sans">
            <div className="w-96 rounded-2xl bg-card p-8 shadow-lg border border-border">
              <h3 className="mb-4 text-lg font-semibold text-foreground">
                确认删除术语？
              </h3>
              <p className="mb-6 text-muted-foreground">
                即将删除术语 <span className="font-medium text-foreground">"{deleteConfirm.word}"</span>，此操作无法撤销。
               </p>
              <div className="flex gap-3 justify-end">
                <button type="button" onClick={() => setDeleteConfirm(null)} className="rounded-lg border border-border px-4 py-2 font-medium text-foreground hover:bg-muted transition-colors cursor-pointer">
                  取消
                </button>
                <button type="button" onClick={() => {
                const updated = recommendedTerms.filter((_, i) => i !== deleteConfirm.index);
                setRecommendedTerms(updated);
                syncGlossaryWithBackend(updated);
                setDeleteConfirm(null);
            }} className="rounded-lg bg-destructive px-4 py-2 font-medium text-white hover:bg-destructive/90 transition-colors cursor-pointer">
                  确认删除
                </button>
              </div>
            </div>
          </div>)}

        {/* Direction-aware floating scroll button */}
        <AnimatePresence>
          {scrollControlDirection && (<div className="fixed bottom-8 left-1/2 z-[999] -translate-x-1/2">
              <motion.button initial={{ opacity: 0, scale: 0.8, y: 15 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.8, y: 15 }} onClick={scrollControlDirection === 'up' ? scrollToTop : scrollToBottom} className="flex items-center justify-center rounded-full border border-primary/20 bg-primary p-4 text-primary-foreground shadow-2xl transition-all hover:scale-105 hover:bg-primary/95 hover:shadow-xl active:scale-95 group" title={scrollControlDirection === 'up' ? '回到顶部' : '回到底部'}>
                {scrollControlDirection === 'up' ? (<ArrowUp className="w-5 h-5 transition-transform group-hover:-translate-y-0.5"/>) : (<ArrowDown className="w-5 h-5 transition-transform group-hover:translate-y-0.5"/>)}
              </motion.button>
            </div>)}
        </AnimatePresence>
      </div>
    </div>);
}
