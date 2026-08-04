import React, { useState, useEffect, useRef } from 'react';
import { FileText, Languages, BookOpen, Trash2, Sparkles, History, FolderOpen, ArrowRight, AlertCircle, Info, Plus, ChevronRight, Play, ChevronLeft, Globe, RefreshCw, CheckCircle2, AlertTriangle, XCircle, X } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { ProjectSummary, ProjectDetail, GlossaryLibrary, GlossaryTerm, TranslationDirection, TranslationDomain } from './types';
import UploadView from './components/UploadView';
import ReviewTable from './components/ReviewTable';
import GlossaryManager from './components/GlossaryManager';
import QAView from './components/QAView';
import { apiFetch } from './lib/api';
// Precise word boundary mapping to avoid overly broad matching in incremental segments
export function isGlossaryTermMatch(text: string | null | undefined, term: string | null | undefined): boolean {
    if (!text || !term)
        return false;
    const escapeRegExp = (value: string) => value.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const isCjk = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/.test(term);
    if (isCjk) {
        return text.toLowerCase().includes(term.toLowerCase());
    }
    const compactTerm = term.trim();
    if (!compactTerm)
        return false;
    const words = compactTerm.split(/\s+/);
    const lastWord = words[words.length - 1];
    const prefix = words.slice(0, -1).map(escapeRegExp).join('\\s+');
    const suffixPattern = /^[a-z]+$/i.test(lastWord) && lastWord.length >= 4
        ? (lastWord.toLowerCase().endsWith('e')
            ? `${escapeRegExp(lastWord.slice(0, -1))}(?:e|es|ed|ing|ion|ions|ive|ives|er|ers)?`
            : `${escapeRegExp(lastWord)}(?:s|es|ed|ing|ion|ions|ive|ives|er|ers)?`)
        : escapeRegExp(lastWord);
    const pattern = words.length > 1 ? `${prefix}\\s+${suffixPattern}` : suffixPattern;
    return new RegExp(`\\b${pattern}\\b`, 'i').test(text);
}
const normalizeGlossaryValue = (value: unknown): string => String(value || '').trim();
const languagePairForDirection = (direction: TranslationDirection) => direction === 'zh-en'
    ? { sourceLang: 'Simplified Chinese', targetLang: 'English' }
    : { sourceLang: 'English', targetLang: 'Simplified Chinese' };
const languagePairForProject = (project: ProjectSummary | ProjectDetail | null | undefined) => ({
    sourceLang: project?.sourceLang || languagePairForDirection(project?.translationDirection || 'en-zh').sourceLang,
    targetLang: project?.targetLang || languagePairForDirection(project?.translationDirection || 'en-zh').targetLang
});
const inferTranslationDirection = (project: ProjectSummary | ProjectDetail | null | undefined): TranslationDirection => {
    if (project?.translationDirection)
        return project.translationDirection;
    const target = String(project?.targetLang || '').toLowerCase();
    const source = String(project?.sourceLang || '').toLowerCase();
    if (source.includes('chinese') || target.includes('english'))
        return 'zh-en';
    if (source.includes('english') && target.includes('chinese'))
        return 'en-zh';
    return `${project?.sourceLang || 'English'}-${project?.targetLang || 'Simplified Chinese'}`;
};
const normalizeTranslationDomain = (_domain: unknown): TranslationDomain => {
    return 'business';
};
const TARGET_LANGUAGE_OPTIONS = ['Simplified Chinese', 'English', 'French', 'Japanese', 'Italian', 'Arabic'];
const displayLanguageLabel = (language?: string): string => {
    const normalized = String(language || '').toLowerCase();
    if (normalized.includes('simplified chinese'))
        return '简体中文';
    if (normalized.includes('english'))
        return '英语';
    if (normalized.includes('french'))
        return '法语';
    if (normalized.includes('japanese'))
        return '日语';
    if (normalized.includes('italian'))
        return '意大利语';
    if (normalized.includes('arabic'))
        return '阿拉伯语';
    return language || '自动检测';
};
const getToneForTargetLanguage = (targetLang: string): string => `professional business/training ${targetLang}`;
type StepNavigationReason = 'initial-project-load' | 'upload-reset' | 'project-deleted' | 'system-reset' | 'stepper' | 'project-card' | 'upload-view' | 'glossary-confirm' | 'language-review' | 'incremental-retranslate' | 'review-next' | 'review-prev' | 'qa-prev' | 'back-home' | 'fallback';
export default function App() {
    const [currentStep, setCurrentStep] = useState<number>(1);
    const [projectsList, setProjectsList] = useState<ProjectSummary[]>([]);
    const [activeProjectSummary, setActiveProjectSummary] = useState<ProjectSummary | null>(null);
    const [activeProjectDetail, setActiveProjectDetail] = useState<ProjectDetail | null>(null);
    // Glossary state
    const [glossary, setGlossary] = useState<GlossaryTerm[]>([]);
    const [glossaryLibraries, setGlossaryLibraries] = useState<GlossaryLibrary[]>([]);
    const [showGlobalGlossary, setShowGlobalGlossary] = useState<boolean>(false);
    // Loading indicator states
    const [loadingProjects, setLoadingProjects] = useState(false);
    const [translatingProjectIds, setTranslatingProjectIds] = useState<Set<string>>(new Set());
    const [isGenerating, setIsGenerating] = useState(false);
    const [isAddingGlossary, setIsAddingGlossary] = useState(false);
    const [isUpdatingTableItem, setIsUpdatingTableItem] = useState<string | null>(null);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const activeProjectIdRef = useRef<string | null>(null);
    const activeProjectIsTranslating = activeProjectSummary ? translatingProjectIds.has(activeProjectSummary.id) : false;
    const translatingProjectsKey = Array.from(translatingProjectIds).sort().join('|');
    const preDetectProjectsKey = projectsList
        .filter(p => p.preDetectStatus === 'pending' || p.preDetectStatus === 'running')
        .map(p => p.id)
        .sort()
        .join('|');
    const isInterruptedTranslationRecovery = (project: Pick<ProjectSummary, 'status' | 'errorMsg'>) => project.status === 'uploaded' && project.errorMsg === 'Translation was interrupted and is ready to retry.';
    const hasExistingTranslation = (project?: ProjectSummary | ProjectDetail | null) => {
        if (!project)
            return false;
        if (project.status !== 'uploaded')
            return true;
        return 'textItems' in project && project.textItems.some(item => Boolean(item.translatedText));
    };
    const shouldStopTrackingTranslation = (project: Pick<ProjectSummary, 'status' | 'errorMsg'>) => project.status === 'paused'
        || project.status === 'translated'
        || project.status === 'partial'
        || project.status === 'completed'
        || project.status === 'failed'
        || isInterruptedTranslationRecovery(project);
    const setProjectTranslating = (projectId: string, isRunning: boolean) => {
        setTranslatingProjectIds(prev => {
            const alreadyRunning = prev.has(projectId);
            if (alreadyRunning === isRunning)
                return prev;
            const next = new Set(prev);
            if (isRunning) {
                next.add(projectId);
            }
            else {
                next.delete(projectId);
            }
            return next;
        });
    };
    // Custom dialog and notification states to bypass sandboxed iframe alert/confirm limits
    const [modalConfig, setModalConfig] = useState<{
        isOpen: boolean;
        title: string;
        message: string;
        confirmText: string;
        cancelText: string;
        hideCancel?: boolean;
        isDanger?: boolean;
        onConfirm: () => void | Promise<void>;
        onCancel?: () => void | Promise<void>;
    } | null>(null);
    const [glossarySaveDialogTerms, setGlossarySaveDialogTerms] = useState<GlossaryTerm[]>([]);
    const [selectedGlossarySaveKeys, setSelectedGlossarySaveKeys] = useState<Set<string>>(new Set());
    const [isSavingGlossaryDialog, setIsSavingGlossaryDialog] = useState(false);
    // Snapshot of glossary state when entering Step 2 to detect changes
    const [glossarySnapshot, setGlossarySnapshot] = useState<GlossaryTerm[]>([]);
    const [projectGlossaryDirtyKeys, setProjectGlossaryDirtyKeys] = useState<string[]>([]);
    const [recentChangedKeys, setRecentChangedKeys] = useState<string[]>([]);
    const [lastStep, setLastStep] = useState<number>(1);
    const [notificationConfig, setNotificationConfig] = useState<{
        isOpen: boolean;
        title: string;
        message: string;
        type: 'success' | 'error' | 'info' | 'warning';
    } | null>(null);
    const [systemConfig, setSystemConfig] = useState<{
        activeEngine: string;
        hasApiKey: boolean;
        model: string;
        baseUrl: string;
        usesLegacyDeepseekConfig?: boolean;
    } | null>(null);
    const [pendingTargetLang, setPendingTargetLang] = useState('Simplified Chinese');
    const [isApplyingLanguageChange, setIsApplyingLanguageChange] = useState(false);
    useEffect(() => {
        if (activeProjectSummary?.targetLang) {
            setPendingTargetLang(activeProjectSummary.targetLang);
        }
    }, [activeProjectSummary?.id, activeProjectSummary?.targetLang]);
    const openPersonalGlossary = () => {
        setShowGlobalGlossary(true);
    };
    const closePersonalGlossary = () => {
        setShowGlobalGlossary(false);
    };
    const goToStep = (step: number, reason: StepNavigationReason = 'fallback') => {
        const glossaryEditIsPending = currentStep === 2 && projectGlossaryDirtyKeys.length > 0 && !activeProjectIsTranslating;
        const allowedWhileEditing = reason === 'glossary-confirm' || reason === 'incremental-retranslate' || reason === 'stepper' || reason === 'project-card';
        if (glossaryEditIsPending && step === 3 && !allowedWhileEditing) {
            console.warn(`[NAV BLOCKED] Ignored step 3 navigation during Project Glossary edit. reason=${reason}`);
            return;
        }
        if (step === 4 && activeProjectDetail?.textItems?.some(item => !item.translatedText || item.status === 'pending')) {
            setNotificationConfig({
                isOpen: true,
                title: '仍有待补译内容',
                message: '请先在 P3 点击“补译剩余待翻译项”，全部完成后再进入下载导出。',
                type: 'warning'
            });
            setCurrentStep(3);
            return;
        }
        console.info(`[NAV] ${currentStep} -> ${step}. reason=${reason}`);
        setCurrentStep(step);
    };
    const handleCreateNewProject = () => {
        setActiveProjectSummary(null);
        setActiveProjectDetail(null);
        setShowGlobalGlossary(false);
        setRecentChangedKeys([]);
        setProjectGlossaryDirtyKeys([]);
        setErrorMessage(null);
        goToStep(1, 'upload-reset');
    };
    // Initial loads on mount
    useEffect(() => {
        loadProjects();
        loadGlossary();
        loadSystemConfig();
    }, []);
    // Set up 5-second auto-dismiss for floating notifications / toast alerts
    useEffect(() => {
        if (notificationConfig && notificationConfig.isOpen) {
            const timer = setTimeout(() => {
                setNotificationConfig(prev => prev ? { ...prev, isOpen: false } : null);
            }, 5000);
            return () => clearTimeout(timer);
        }
    }, [notificationConfig?.isOpen, notificationConfig?.message]);
    // 切换步骤时，自动一键回到顶部 (Auto scroll to top on step transition)
    useEffect(() => {
        window.scrollTo({ top: 0, behavior: 'instant' });
    }, [currentStep]);
    const loadSystemConfig = async () => {
        try {
            const res = await apiFetch('/api/system/config');
            if (res.ok) {
                const data = await res.json();
                setSystemConfig(data);
            }
        }
        catch (err) {
            console.error('Failed to load system config details:', err);
        }
    };
    useEffect(() => {
        activeProjectIdRef.current = activeProjectSummary?.id || null;
    }, [activeProjectSummary?.id]);
    // Sync active project detailed info whenever active summary changes
    useEffect(() => {
        if (activeProjectSummary) {
            loadProjectDetail(activeProjectSummary.id);
            setProjectGlossaryDirtyKeys([]);
        }
        else {
            setActiveProjectDetail(null);
            setProjectGlossaryDirtyKeys([]);
        }
    }, [activeProjectSummary?.id]);
    // Capture a stable baseline Glossary snapshot upon first entering Step 2.
    // Using lastStep to detect step transitions so we copy exactly once upon entry
    // and subsequent local database edits within Step 2 do not overwrite the baseline.
    useEffect(() => {
        if (currentStep === 2 && lastStep !== 2) {
            const activeProj = activeProjectDetail || activeProjectSummary;
            if (activeProj) {
                const snap = activeProj.glossary || [];
                setGlossarySnapshot(JSON.parse(JSON.stringify(snap)));
            }
        }
        setLastStep(currentStep);
    }, [currentStep, activeProjectDetail, activeProjectSummary]);
    // Auto-trigger translation on transition to Step 3 if project is not yet translated
    useEffect(() => {
        if (currentStep === 3 && activeProjectSummary && activeProjectSummary.status === 'uploaded' && !activeProjectIsTranslating) {
            const translationDirection = inferTranslationDirection(activeProjectSummary);
            const translationDomain = normalizeTranslationDomain(activeProjectSummary.translationDomain);
            const pair = languagePairForProject(activeProjectSummary);
            handleStartTranslation(activeProjectSummary.sourceLang || sourceLangStep3 || pair.sourceLang, activeProjectSummary.targetLang || targetLangStep3 || pair.targetLang, activeProjectSummary.tone || toneStep3 || 'professional training/business Chinese', activeProjectSummary.glossaryPreset || 'business', translationDirection, translationDomain);
        }
    }, [currentStep, activeProjectSummary?.id, activeProjectSummary?.status, activeProjectIsTranslating]);
    // Periodically poll backend to update the translation comparison table and progress bar in real-time
    useEffect(() => {
        const ids = translatingProjectsKey ? translatingProjectsKey.split('|').filter(Boolean) : [];
        if (ids.length === 0)
            return;
        const pollProjects = () => {
            ids.forEach(id => loadProjectDetail(id));
        };
        pollProjects();
        const intervalId = setInterval(pollProjects, 1000);
        return () => {
            clearInterval(intervalId);
        };
    }, [translatingProjectsKey]);
    useEffect(() => {
        const projectId = activeProjectSummary?.id;
        if (!isGenerating || !projectId)
            return;
        const intervalId = window.setInterval(() => loadProjectDetail(projectId), 500);
        return () => window.clearInterval(intervalId);
    }, [isGenerating, activeProjectSummary?.id]);
    useEffect(() => {
        setTranslatingProjectIds(prev => {
            let changed = false;
            const next = new Set(prev);
            for (const project of projectsList) {
                if (project.status === 'translating' || project.status === 'pausing') {
                    if (!next.has(project.id)) {
                        next.add(project.id);
                        changed = true;
                    }
                }
                else if (next.has(project.id) && shouldStopTrackingTranslation(project)) {
                    next.delete(project.id);
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
    }, [projectsList]);
    // Poll terminology pre-detection for every project that is still running,
    // so switching projects does not orphan the background detection UI.
    useEffect(() => {
        const ids = preDetectProjectsKey ? preDetectProjectsKey.split('|').filter(Boolean) : [];
        if (ids.length === 0)
            return;
        const pollProjects = () => {
            ids.forEach(id => loadProjectDetail(id));
        };
        pollProjects();
        const intervalId = setInterval(pollProjects, 1500);
        return () => {
            clearInterval(intervalId);
        };
    }, [preDetectProjectsKey]);
    const loadProjects = async () => {
        setLoadingProjects(true);
        try {
            const res = await apiFetch('/api/projects');
            if (res.ok) {
                const list = await res.json();
                setProjectsList(list);
                if (list.length > 0 && !activeProjectSummary) {
                    setActiveProjectSummary(list[0]);
                    goToStep(2, 'initial-project-load');
                }
            }
        }
        catch (err) {
            console.error('Failed to load projects list:', err);
        }
        finally {
            setLoadingProjects(false);
        }
    };
    const loadGlossary = async () => {
        try {
            const [glossaryRes, librariesRes] = await Promise.all([
                apiFetch('/api/glossary'),
                apiFetch('/api/glossary/libraries')
            ]);
            if (glossaryRes.ok)
                setGlossary(await glossaryRes.json());
            if (librariesRes.ok) {
                const data = await librariesRes.json();
                setGlossaryLibraries(Array.isArray(data?.libraries) ? data.libraries : []);
            }
        }
        catch (err) {
            console.error('Failed to load glossary:', err);
        }
    };
    const handleGlossaryLibrariesChanged = (libraries: GlossaryLibrary[]) => {
        const previousIds = new Set(glossaryLibraries.map(library => library.id));
        const nextIds = new Set(libraries.map(library => library.id));
        const created = libraries.filter(library => !previousIds.has(library.id)).length;
        const deleted = glossaryLibraries.filter(library => !nextIds.has(library.id)).length;
        const updated = libraries.filter(library => {
            const previous = glossaryLibraries.find(item => item.id === library.id);
            return previous && JSON.stringify(previous) !== JSON.stringify(library);
        }).length;
        if (created || deleted || updated) {
        }
        setGlossaryLibraries(libraries);
        const defaultLibrary = libraries.find(library => library.id.startsWith('default_'));
        if (defaultLibrary)
            setGlossary(defaultLibrary.terms);
    };
    const notifyTranslationCompletion = (project: ProjectSummary | ProjectDetail) => {
        if (!project.translationCompletedAt || (project.status !== 'translated' && project.status !== 'completed'))
            return;
        const notificationKey = `translation-completed:${project.id}:${project.translationCompletedAt}`;
        if (window.localStorage.getItem(notificationKey))
            return;
        window.localStorage.setItem(notificationKey, '1');
        setNotificationConfig({
            isOpen: true,
            title: '翻译完成',
            message: '正文翻译、质量检查和术语检查已全部完成。',
            type: 'success'
        });
    };
    const loadProjectDetail = async (id: string) => {
        try {
            const res = await apiFetch(`/api/projects/${id}`);
            if (res.ok) {
                const detail = await res.json();
                notifyTranslationCompletion(detail);
                if (activeProjectIdRef.current === detail.id) {
                    setActiveProjectDetail(detail);
                }
                if (detail.status === 'translating' || detail.status === 'pausing') {
                    setProjectTranslating(detail.id, true);
                }
                else if (shouldStopTrackingTranslation(detail)) {
                    setProjectTranslating(detail.id, false);
                }
                // Dynamic status synchronization back to sidebar and global tracking pointers
                setProjectsList(prev => prev.map(p => p.id === detail.id ? {
                    ...p,
                    status: detail.status,
                    translationProgress: detail.translationProgress,
                    translationStartedAt: detail.translationStartedAt,
                    translationCompletedAt: detail.translationCompletedAt,
                    preDetectStatus: detail.preDetectStatus,
                    preDetectError: detail.preDetectError,
                    preDetectReport: detail.preDetectReport,
                    generationProgress: detail.generationProgress,
                    glossary: detail.glossary,
                    glossaryReviewCandidates: detail.glossaryReviewCandidates
                } : p));
                if (activeProjectIdRef.current === detail.id) {
                    setActiveProjectSummary(prev => prev && prev.id === detail.id ? {
                        ...prev,
                        status: detail.status,
                        translationProgress: detail.translationProgress,
                        translationStartedAt: detail.translationStartedAt,
                        translationCompletedAt: detail.translationCompletedAt,
                        generationProgress: detail.generationProgress,
                        preDetectStatus: detail.preDetectStatus,
                        preDetectError: detail.preDetectError,
                        preDetectReport: detail.preDetectReport,
                        glossary: detail.glossary,
                        glossaryReviewCandidates: detail.glossaryReviewCandidates
                    } : prev);
                }
            }
        }
        catch (err) {
            console.error('Failed to load project details:', err);
        }
    };
    const handleUploadSuccess = (project: ProjectSummary | null) => {
        if (project) {
            // Add to project list and set as active selection
            setProjectsList(prev => [project, ...prev]);
            setActiveProjectSummary(project);
        }
        else {
            setActiveProjectSummary(null);
            setActiveProjectDetail(null);
        }
    };
    const handleDeleteProject = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setModalConfig({
            isOpen: true,
            title: '删除演示文件项目',
            message: '确定要永久删除此项目吗？该操作将永久移除此文件的上传压缩包、项目配置，以及该项目全部原文对应的翻译记忆，已导出的 PPTX 实物不会受到影响。',
            confirmText: '确认删除',
            cancelText: '取消',
            isDanger: true,
            onConfirm: async () => {
                try {
                    const res = await apiFetch(`/api/projects/${id}`, { method: 'DELETE' });
                    if (res.ok) {
                        setProjectsList(prev => prev.filter(p => p.id !== id));
                        if (activeProjectSummary?.id === id) {
                            setActiveProjectSummary(null);
                            setActiveProjectDetail(null);
                            goToStep(1, 'project-deleted');
                        }
                        setNotificationConfig({
                            isOpen: true,
                            title: '操作成功',
                            message: '项目已成功删除。',
                            type: 'success'
                        });
                    }
                    else {
                        throw new Error('Server returned unsaved status');
                    }
                }
                catch (err: any) {
                    setNotificationConfig({
                        isOpen: true,
                        title: '删除失败',
                        message: err.message || '无法删除指定项目，请重试。',
                        type: 'error'
                    });
                }
                finally {
                    setModalConfig(null);
                }
            }
        });
    };
    const [resetting, setResetting] = useState(false);
    const handleSystemReset = () => {
        setModalConfig({
            isOpen: true,
            title: '⚠️ 恢复出厂设置确认',
            message: '【强力重置警告】此操作将彻底洗牌，数据无法恢复！它会执行：\n1. 清空所有已上传的项目及 PPTX 实物数据。\n2. 重置内置的自定义术语词表（Glossary）并恢复 factory 默认值。\n3. 彻底清除所有缓存的翻译记忆（TM）对照表。',
            confirmText: '是的，彻底重置所有数据',
            cancelText: '取消',
            isDanger: true,
            onConfirm: async () => {
                setResetting(true);
                setModalConfig(null);
                try {
                    const res = await apiFetch('/api/system/reset', { method: 'POST' });
                    if (res.ok) {
                        setProjectsList([]);
                        setActiveProjectSummary(null);
                        setActiveProjectDetail(null);
                        goToStep(1, 'system-reset');
                        setNotificationConfig({
                            isOpen: true,
                            title: '重置完成',
                            message: '系统已成功完成一键重置，即将刷新加载默认页面。',
                            type: 'success'
                        });
                        setTimeout(() => {
                            window.location.reload();
                        }, 1500);
                    }
                    else {
                        setNotificationConfig({
                            isOpen: true,
                            title: '重置失败',
                            message: '重置请求未被服务器成功接收。',
                            type: 'error'
                        });
                    }
                }
                catch (err: any) {
                    console.error('System reset error:', err);
                    setNotificationConfig({
                        isOpen: true,
                        title: '内部异常',
                        message: '重置期间发生异常错误: ' + err.message,
                        type: 'error'
                    });
                }
                finally {
                    setResetting(false);
                }
            }
        });
    };
    const handleClearTMOnly = () => {
        setModalConfig({
            isOpen: true,
            title: '⚙️ 清除翻译记忆确认',
            message: '确定要清空全局翻译记忆吗？清除后，之前微调确认的翻译对照将不复存在，再次上传相同文本时无法直接命中的已翻译条款。',
            confirmText: '确定清空',
            cancelText: '取消',
            isDanger: true,
            onConfirm: async () => {
                setModalConfig(null);
                try {
                    const res = await apiFetch('/api/tm/clear', { method: 'POST' });
                    if (res.ok) {
                        setNotificationConfig({
                            isOpen: true,
                            title: '操作成功',
                            message: '全局翻译记忆（TM）缓存已成功清空！',
                            type: 'success'
                        });
                    }
                    else {
                        setNotificationConfig({
                            isOpen: true,
                            title: '操作失败',
                            message: '清除翻译记忆失败，请稍后重试。',
                            type: 'error'
                        });
                    }
                }
                catch (err: any) {
                    console.error('Failed to clear TM:', err);
                    setNotificationConfig({
                        isOpen: true,
                        title: '操作异常',
                        message: '清空 TM 异常: ' + err.message,
                        type: 'error'
                    });
                }
            }
        });
    };
    const handleStartTranslation = async (sourceLang: string, targetLang: string, tone: string, glossaryPreset: string, translationDirection?: TranslationDirection, translationDomain?: TranslationDomain, projectOverride?: ProjectSummary | ProjectDetail) => {
        const project = projectOverride || activeProjectSummary;
        if (!project)
            return;
        setProjectTranslating(project.id, true);
        setActiveProjectSummary(prev => prev && prev.id === project.id ? { ...prev, status: 'translating' } : prev);
        setActiveProjectDetail(prev => prev && prev.id === project.id ? { ...prev, status: 'translating' } : prev);
        setProjectsList(prev => prev.map(item => item.id === project.id ? { ...item, status: 'translating' } : item));
        setRecentChangedKeys([]);
        setErrorMessage(null);
        try {
            const res = await apiFetch(`/api/projects/${project.id}/translate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sourceLang, targetLang, tone, glossaryPreset, translationDirection, translationDomain })
            });
            if (!res.ok) {
                const errorData = await res.json();
                throw new Error(errorData.error || '翻译大模型引擎返回了异常，请检查配置。');
            }
            const updatedDetail = await res.json();
            if (activeProjectIdRef.current === updatedDetail.id) {
                setActiveProjectDetail(updatedDetail);
            }
            // Sync list summary item state
            setActiveProjectSummary(prev => prev && prev.id === updatedDetail.id ? {
                ...prev,
                id: updatedDetail.id,
                originalName: updatedDetail.originalName,
                uploadTime: updatedDetail.uploadTime,
                slideCount: updatedDetail.slideCount,
                uniqueCount: updatedDetail.uniqueCount,
                repeatedCount: updatedDetail.repeatedCount,
                mediaCount: updatedDetail.mediaCount,
                sourceLang: updatedDetail.sourceLang,
                targetLang: updatedDetail.targetLang,
                translationDirection: updatedDetail.translationDirection,
                languagePair: updatedDetail.languagePair,
                translationDomain: updatedDetail.translationDomain,
                tone: updatedDetail.tone,
                glossaryPreset: updatedDetail.glossaryPreset,
                status: updatedDetail.status,
                translationProgress: updatedDetail.translationProgress,
                translationStartedAt: updatedDetail.translationStartedAt,
                translationCompletedAt: updatedDetail.translationCompletedAt,
                preDetectStatus: updatedDetail.preDetectStatus,
                preDetectError: updatedDetail.preDetectError,
                preDetectReport: updatedDetail.preDetectReport,
                glossary: updatedDetail.glossary,
                glossaryReviewCandidates: updatedDetail.glossaryReviewCandidates
            } : prev);
            setProjectsList(prev => prev.map(p => p.id === updatedDetail.id ? {
                ...p,
                sourceLang: updatedDetail.sourceLang,
                targetLang: updatedDetail.targetLang,
                translationDirection: updatedDetail.translationDirection,
                languagePair: updatedDetail.languagePair,
                status: updatedDetail.status,
                translationProgress: updatedDetail.translationProgress,
                translationStartedAt: updatedDetail.translationStartedAt,
                translationCompletedAt: updatedDetail.translationCompletedAt,
                preDetectStatus: updatedDetail.preDetectStatus,
                preDetectError: updatedDetail.preDetectError,
                preDetectReport: updatedDetail.preDetectReport,
                glossary: updatedDetail.glossary,
                glossaryReviewCandidates: updatedDetail.glossaryReviewCandidates
            } : p));
            const remainingPendingCount = updatedDetail.textItems?.filter((item: any) => !item.translatedText || item.status === 'pending').length || 0;
            if (remainingPendingCount > 0) {
                setNotificationConfig({
                    isOpen: true,
                    title: '仍有待补译内容',
                    message: `仍有 ${remainingPendingCount} 条待补译。请在 P3 点击“补译剩余待翻译项”。`,
                    type: 'warning'
                });
            }
            else {
                notifyTranslationCompletion(updatedDetail);
            }
        }
        catch (err: any) {
            setErrorMessage(err.message || 'Translation execution failed.');
        }
        finally {
            setProjectTranslating(project.id, false);
        }
    };
    const handleApplyProjectLanguage = async (forceRedetect = false, targetLangOverride?: string) => {
        const project = activeProjectDetail || activeProjectSummary;
        if (!project || activeProjectIsTranslating || isApplyingLanguageChange)
            return;
        const previousSourceLang = project.sourceLang;
        const previousTargetLang = project.targetLang;
        const shouldRetranslate = hasExistingTranslation(project);
        const nextTargetLang = targetLangOverride || pendingTargetLang;
        setIsApplyingLanguageChange(true);
        setErrorMessage(null);
        try {
            const res = await apiFetch(`/api/projects/${project.id}/language`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetLang: nextTargetLang, forceRedetect })
            });
            const updatedDetail = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(updatedDetail.error || '更新翻译方向失败。');
            }
            setActiveProjectDetail(updatedDetail);
            setActiveProjectSummary(prev => prev && prev.id === updatedDetail.id ? {
                ...prev,
                sourceLang: updatedDetail.sourceLang,
                targetLang: updatedDetail.targetLang,
                translationDirection: updatedDetail.translationDirection,
                languagePair: updatedDetail.languagePair,
                translationDomain: updatedDetail.translationDomain,
                tone: updatedDetail.tone,
                glossaryPreset: updatedDetail.glossaryPreset,
                status: updatedDetail.status,
                translatedFilePath: updatedDetail.translatedFilePath,
                qaReport: updatedDetail.qaReport,
                glossary: updatedDetail.glossary,
                glossaryReviewCandidates: updatedDetail.glossaryReviewCandidates,
                preDetectStatus: updatedDetail.preDetectStatus,
                preDetectError: updatedDetail.preDetectError,
                preDetectReport: updatedDetail.preDetectReport
            } : prev);
            setProjectsList(prev => prev.map(p => p.id === updatedDetail.id ? {
                ...p,
                sourceLang: updatedDetail.sourceLang,
                targetLang: updatedDetail.targetLang,
                translationDirection: updatedDetail.translationDirection,
                languagePair: updatedDetail.languagePair,
                translationDomain: updatedDetail.translationDomain,
                tone: updatedDetail.tone,
                glossaryPreset: updatedDetail.glossaryPreset,
                status: updatedDetail.status,
                translatedFilePath: updatedDetail.translatedFilePath,
                glossary: updatedDetail.glossary,
                glossaryReviewCandidates: updatedDetail.glossaryReviewCandidates,
                preDetectStatus: updatedDetail.preDetectStatus,
                preDetectError: updatedDetail.preDetectError,
                preDetectReport: updatedDetail.preDetectReport
            } : p));
            const languagePairChanged = previousSourceLang !== updatedDetail.sourceLang || previousTargetLang !== updatedDetail.targetLang;
            setNotificationConfig({
                isOpen: true,
                title: forceRedetect ? '源语言检测完成' : '翻译方向已更新',
                message: forceRedetect
                    ? shouldRetranslate && languagePairChanged
                        ? `检测结果：${displayLanguageLabel(updatedDetail.sourceLang)} → ${displayLanguageLabel(updatedDetail.targetLang)}。请在 P2 确认术语后继续重新翻译。`
                        : `检测结果：${displayLanguageLabel(updatedDetail.sourceLang)} → ${displayLanguageLabel(updatedDetail.targetLang)}。`
                    : shouldRetranslate
                        ? `已切换为 ${displayLanguageLabel(updatedDetail.sourceLang)} → ${displayLanguageLabel(updatedDetail.targetLang)}。请在 P2 确认术语后继续重新翻译。`
                        : `已切换为 ${displayLanguageLabel(updatedDetail.sourceLang)} → ${displayLanguageLabel(updatedDetail.targetLang)}。`,
                type: 'info'
            });
            if (shouldRetranslate && languagePairChanged) {
                goToStep(2, 'language-review');
            }
        }
        catch (err: any) {
            setErrorMessage(err.message || '更新翻译方向失败。');
            setNotificationConfig({
                isOpen: true,
                title: '更新失败',
                message: err.message || '更新翻译方向失败。',
                type: 'error'
            });
        }
        finally {
            setIsApplyingLanguageChange(false);
        }
    };
    const handleTranslatePendingItems = async () => {
        const project = activeProjectDetail || activeProjectSummary;
        if (!project)
            return;
        const translationDirection = inferTranslationDirection(project);
        const pair = languagePairForProject(project);
        await handleStartTranslation(project.sourceLang || pair.sourceLang, project.targetLang || pair.targetLang, project.tone || toneStep3 || 'professional training/business Chinese', project.glossaryPreset || 'business', translationDirection, normalizeTranslationDomain(project.translationDomain));
    };
    const handlePauseTranslation = async () => {
        const project = activeProjectDetail || activeProjectSummary;
        if (!project || (project.status !== 'translating' && project.status !== 'pausing'))
            return;
        try {
            const res = await apiFetch(`/api/projects/${project.id}/translation/pause`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok)
                throw new Error(data.error || '暂停翻译失败。');
            handleProjectUpdated(data);
        }
        catch (err: any) {
            setNotificationConfig({
                isOpen: true,
                title: '暂停失败',
                message: err.message || '暂停翻译失败，请稍后重试。',
                type: 'error'
            });
        }
    };
    const handleResumeTranslation = async () => {
        const project = activeProjectDetail || activeProjectSummary;
        if (!project)
            return;
        await handleTranslatePendingItems();
    };
    const handleUpdateItem = async (originalText: string, translatedText: string) => {
        if (!activeProjectDetail)
            return;
        setIsUpdatingTableItem(originalText);
        try {
            const res = await apiFetch(`/api/projects/${activeProjectDetail.id}/items`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ originalText, translatedText })
            });
            if (res.ok) {
                const data = await res.json();
                setActiveProjectDetail(data.project);
                handleProjectUpdated(data.project);
            }
        }
        catch (err) {
            console.error('Failed to sync translation mapping:', err);
        }
        finally {
            setIsUpdatingTableItem(null);
        }
    };
    const handleProjectUpdated = (updatedProj: any) => {
        setProjectsList(prev => prev.map(p => p.id === updatedProj.id ? {
            ...p,
            status: updatedProj.status || p.status,
            translationProgress: updatedProj.translationProgress || p.translationProgress,
            translatedFilePath: updatedProj.translatedFilePath !== undefined ? updatedProj.translatedFilePath : p.translatedFilePath,
            glossary: updatedProj.glossary,
            glossaryReviewCandidates: updatedProj.glossaryReviewCandidates,
            preDetectStatus: updatedProj.preDetectStatus,
            preDetectError: updatedProj.preDetectError,
            preDetectReport: updatedProj.preDetectReport
        } : p));
        setActiveProjectSummary(prev => prev && prev.id === updatedProj.id ? {
            ...prev,
            status: updatedProj.status || prev.status,
            translationProgress: updatedProj.translationProgress || prev.translationProgress,
            translatedFilePath: updatedProj.translatedFilePath !== undefined ? updatedProj.translatedFilePath : prev.translatedFilePath,
            glossary: updatedProj.glossary,
            glossaryReviewCandidates: updatedProj.glossaryReviewCandidates,
            preDetectStatus: updatedProj.preDetectStatus,
            preDetectError: updatedProj.preDetectError,
            preDetectReport: updatedProj.preDetectReport
        } : prev);
        setActiveProjectDetail(prev => prev && prev.id === updatedProj.id ? {
            ...prev,
            status: updatedProj.status || prev.status,
            translationProgress: updatedProj.translationProgress || prev.translationProgress,
            translatedFilePath: updatedProj.translatedFilePath !== undefined ? updatedProj.translatedFilePath : prev.translatedFilePath,
            qaReport: updatedProj.qaReport ?? prev.qaReport,
            glossaryValidationReport: updatedProj.glossaryValidationReport ?? prev.glossaryValidationReport,
            glossary: updatedProj.glossary,
            glossaryReviewCandidates: updatedProj.glossaryReviewCandidates,
            preDetectStatus: updatedProj.preDetectStatus,
            preDetectError: updatedProj.preDetectError,
            preDetectReport: updatedProj.preDetectReport,
            ...(updatedProj.textItems ? { textItems: updatedProj.textItems } : (prev.textItems ? { textItems: prev.textItems } : {}))
        } : prev as any);
    };
    const handleProjectGlossaryChanged = (sources: string[]) => {
        const cleanSources = sources.map(source => source.trim()).filter(Boolean);
        if (cleanSources.length === 0)
            return;
        setProjectGlossaryDirtyKeys(prev => Array.from(new Set([...prev, ...cleanSources])));
    };
    const handleGeneratePPTX = async () => {
        if (!activeProjectDetail)
            return;
        setIsGenerating(true);
        try {
            const res = await apiFetch(`/api/projects/${activeProjectDetail.id}/generate`, {
                method: 'POST'
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || `Failed to generate translated package (${res.status})`);
            }
            const updatedDetail = await res.json();
            setActiveProjectDetail(updatedDetail);
            // Update summary item
            setActiveProjectSummary(prev => prev ? {
                ...prev,
                status: updatedDetail.status,
                generationProgress: updatedDetail.generationProgress,
                preDetectStatus: updatedDetail.preDetectStatus,
                preDetectError: updatedDetail.preDetectError,
                preDetectReport: updatedDetail.preDetectReport,
                glossary: updatedDetail.glossary,
                glossaryReviewCandidates: updatedDetail.glossaryReviewCandidates
            } : null);
            setProjectsList(prev => prev.map(p => p.id === updatedDetail.id ? {
                ...p,
                status: updatedDetail.status,
                generationProgress: updatedDetail.generationProgress,
                preDetectStatus: updatedDetail.preDetectStatus,
                preDetectError: updatedDetail.preDetectError,
                preDetectReport: updatedDetail.preDetectReport,
                glossary: updatedDetail.glossary,
                glossaryReviewCandidates: updatedDetail.glossaryReviewCandidates
            } : p));
        }
        catch (err) {
            console.error('Failed to generate translated package:', err);
            throw err;
        }
        finally {
            setIsGenerating(false);
        }
    };
    const handleAddGlossaryTerm = async (source: string, target: string, category?: string, explanation?: string) => {
        setIsAddingGlossary(true);
        try {
            const res = await apiFetch('/api/glossary', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source, target, category, explanation })
            });
            if (!res.ok) {
                const errorData = await res.json();
                throw new Error(errorData.error || 'Failed to submit term.');
            }
            const data = await res.json();
            setGlossary(data.glossary);
        }
        catch (err: any) {
            setErrorMessage(err.message || 'Failed to add term to global list.');
        }
        finally {
            setIsAddingGlossary(false);
        }
    };
    const handleAddGlobalGlossaryTerms = async (terms: GlossaryTerm[]) => {
        if (terms.length === 0)
            return;
        let latestGlossary: GlossaryTerm[] | null = null;
        for (const term of terms) {
            const res = await apiFetch('/api/glossary', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    source: term.source,
                    target: term.target,
                    category: term.category,
                    explanation: term.explanation
                })
            });
            if (!res.ok) {
                const errorData = await res.json().catch(() => ({}));
                throw new Error(errorData.error || `Failed to add glossary term: ${term.source}`);
            }
            const data = await res.json();
            latestGlossary = data.glossary;
        }
        if (latestGlossary) {
            setGlossary(latestGlossary);
        }
    };
    const glossaryDialogKey = (term: GlossaryTerm): string => `${term.source.trim().toLowerCase()}|||${term.target.trim().toLowerCase()}`;
    const savedGlossaryDialogKeys = new Set(glossary
        .filter(term => term.source?.trim() && term.target?.trim())
        .map(glossaryDialogKey));
    const isGlossaryDialogTermSaved = (term: GlossaryTerm): boolean => savedGlossaryDialogKeys.has(glossaryDialogKey(term));
    const addableGlossaryDialogTerms = glossarySaveDialogTerms.filter(term => !isGlossaryDialogTermSaved(term));
    const openGlossarySaveDialog = (terms: GlossaryTerm[]) => {
        setGlossarySaveDialogTerms(terms);
        setSelectedGlossarySaveKeys(new Set(terms.filter(term => !isGlossaryDialogTermSaved(term)).map(glossaryDialogKey)));
    };
    const toggleGlossarySaveTerm = (term: GlossaryTerm) => {
        const key = glossaryDialogKey(term);
        setSelectedGlossarySaveKeys(prev => {
            const next = new Set(prev);
            if (next.has(key)) {
                next.delete(key);
            }
            else {
                next.add(key);
            }
            return next;
        });
    };
    const setAllGlossarySaveTerms = (checked: boolean) => {
        setSelectedGlossarySaveKeys(checked ? new Set(addableGlossaryDialogTerms.map(glossaryDialogKey)) : new Set());
    };
    const saveSelectedGlossaryDialogTerms = async () => {
        const selectedTerms = glossarySaveDialogTerms.filter(term => selectedGlossarySaveKeys.has(glossaryDialogKey(term)));
        setIsSavingGlossaryDialog(true);
        try {
            if (selectedTerms.length > 0) {
                await handleAddGlobalGlossaryTerms(selectedTerms);
            }
            setGlossarySaveDialogTerms([]);
            setSelectedGlossarySaveKeys(new Set());
        }
        catch (err: any) {
            setErrorMessage(err.message || 'Failed to add selected glossary terms.');
        }
        finally {
            setIsSavingGlossaryDialog(false);
        }
    };
    const handleUpdateGlossaryTerm = async (oldSource: string, oldTarget: string, term: GlossaryTerm) => {
        const previous = glossary.find(item => item.source === oldSource && item.target === oldTarget);
        const changedFields = [
            oldSource !== term.source ? 'source' : null,
            oldTarget !== term.target ? 'target' : null,
            previous && previous.category !== term.category ? 'category' : null,
            previous && previous.explanation !== term.explanation ? 'explanation' : null
        ].filter((field): field is string => Boolean(field));
        const res = await apiFetch(`/api/glossary/${encodeURIComponent(oldSource)}?target=${encodeURIComponent(oldTarget)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                source: term.source,
                target: term.target,
                category: term.category,
                explanation: term.explanation
            })
        });
        if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            throw new Error(errorData.error || 'Failed to update glossary term.');
        }
        const data = await res.json();
        setGlossary(data.glossary);
    };
    const handleDeleteGlossaryTerm = async (source: string, target?: string) => {
        try {
            const query = target ? `?target=${encodeURIComponent(target)}` : '';
            const res = await apiFetch(`/api/glossary/${encodeURIComponent(source)}${query}`, {
                method: 'DELETE'
            });
            if (res.ok) {
                const data = await res.json();
                setGlossary(data.glossary);
            }
        }
        catch (err) {
            console.error('Failed to remove terminology rule:', err);
        }
    };
    const runIncrementalTranslation = async (changedKeys: string[], overwriteEdited: boolean, forceFullRefresh = false) => {
        const project = activeProjectDetail;
        if (!project)
            return;
        // Requirement 2: Local State Rewind (uses precise word-bound glossary detector helper)
        const updatedItems = project.textItems.map(item => {
            const containsKey = forceFullRefresh || changedKeys.some(key => isGlossaryTermMatch(item.originalText, key));
            if (containsKey) {
                if (item.status === 'edited' && !overwriteEdited) {
                    return item; // Keep custom manual edits
                }
                return {
                    ...item,
                    status: 'pending' as const
                };
            }
            return item;
        });
        const rewindedDetail = {
            ...project,
            textItems: updatedItems,
            status: 'translating' as const
        };
        // Immediately set state so Step 3 starts showing progress spinners on those lines
        setActiveProjectDetail(rewindedDetail);
        setActiveProjectSummary(prev => prev && prev.id === project.id ? {
            ...prev,
            status: 'translating',
            glossary: project.glossary
        } : prev);
        setProjectsList(prev => prev.map(p => p.id === project.id ? {
            ...p,
            status: 'translating',
            glossary: project.glossary
        } : p));
        setRecentChangedKeys(changedKeys);
        setProjectTranslating(project.id, true);
        goToStep(3, 'incremental-retranslate');
        try {
            const res = await apiFetch(`/api/projects/${project.id}/retranslate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ changedKeys, overwriteEdited, forceFullRefresh })
            });
            if (!res.ok) {
                const errMsgObj = await res.json();
                throw new Error(errMsgObj.error || '增量翻译请求失败');
            }
            const finalDetail = await res.json();
            if (activeProjectIdRef.current === finalDetail.id) {
                setActiveProjectDetail(finalDetail);
            }
            setActiveProjectSummary(prev => prev && prev.id === finalDetail.id ? {
                ...prev,
                status: finalDetail.status,
                translatedFilePath: finalDetail.translatedFilePath,
                glossary: finalDetail.glossary,
                glossaryReviewCandidates: finalDetail.glossaryReviewCandidates,
                preDetectStatus: finalDetail.preDetectStatus,
                preDetectError: finalDetail.preDetectError,
                preDetectReport: finalDetail.preDetectReport
            } : prev);
            setProjectsList(prev => prev.map(p => p.id === finalDetail.id ? {
                ...p,
                status: finalDetail.status,
                translatedFilePath: finalDetail.translatedFilePath,
                glossary: finalDetail.glossary,
                glossaryReviewCandidates: finalDetail.glossaryReviewCandidates,
                preDetectStatus: finalDetail.preDetectStatus,
                preDetectError: finalDetail.preDetectError,
                preDetectReport: finalDetail.preDetectReport
            } : p));
            // Update local glossary snapshot to synchronize with current saved state
            setGlossarySnapshot(JSON.parse(JSON.stringify(finalDetail.glossary || [])));
            setProjectGlossaryDirtyKeys([]);
            setNotificationConfig({
                isOpen: true,
                title: '翻译已更新',
                message: '已针对变动的术语词条二次翻译并回填',
                type: 'success'
            });
        }
        catch (err: any) {
            console.error(err);
            setErrorMessage(err.message || '增量重翻译执行出错。');
            // reload to restore state
            loadProjectDetail(project.id);
        }
        finally {
            setProjectTranslating(project.id, false);
        }
    };
    const handleGlossaryConfirmNext = async (latestTerms?: any[]) => {
        if (!activeProjectSummary) {
            goToStep(3, 'glossary-confirm');
            return;
        }
        // Capture the most up-to-date glossary from latestTerms if available,
        // and proactively save it to the backend to resolve race conditions
        let currentGlossary = activeProjectDetail?.glossary || [];
        if (latestTerms && activeProjectSummary) {
            const glossaryDirection = inferTranslationDirection(activeProjectSummary);
            const glossaryLanguagePair = languagePairForProject(activeProjectSummary);
            const activeGlossary = latestTerms
                .filter(t => t.checked !== false)
                .map(t => ({
                source: t.source,
                target: t.target,
                category: t.category || (t as any).description || '',
                explanation: t.explanation || (t as any).description || '',
                origin: t.origin,
                status: t.status,
                usageCount: t.usageCount,
                confidence: t.confidence,
                reason: t.reason,
                checked: t.checked !== false,
                sourceLang: t.sourceLang || activeProjectSummary.sourceLang || glossaryLanguagePair.sourceLang,
                targetLang: t.targetLang || activeProjectSummary.targetLang || glossaryLanguagePair.targetLang,
                direction: t.direction || activeProjectSummary.translationDirection || glossaryDirection
            }));
            currentGlossary = activeGlossary;
            try {
                // Force synchronous sync with the backend to ensure the DB is in sync before potential re-translation runs
                const gRes = await apiFetch(`/api/projects/${activeProjectSummary.id}/glossary`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        glossary: activeGlossary,
                        preDetectReport: {
                            ...activeProjectSummary.preDetectReport,
                            recommendedGlossary: latestTerms
                        }
                    })
                });
                if (gRes.ok) {
                    const updatedProj = await gRes.json();
                    // Update the local react state immediately
                    handleProjectUpdated(updatedProj);
                }
            }
            catch (err) {
                console.error('Failed to pre-sync glossary before step transition:', err);
            }
        }
        if (activeProjectDetail && (activeProjectDetail.status === 'paused'
            || activeProjectDetail.status === 'partial'
            || activeProjectDetail.status === 'translated'
            || activeProjectDetail.status === 'completed'
            || activeProjectDetail.status === 'generating')) {
            const changedKeys: string[] = [];
            // Check for added or modified
            for (const cur of currentGlossary) {
                const match = glossarySnapshot.find(snap => snap.source.toLowerCase() === cur.source.toLowerCase());
                if (!match) {
                    changedKeys.push(cur.source);
                }
                else if (normalizeGlossaryValue(match.target) !== normalizeGlossaryValue(cur.target) ||
                    normalizeGlossaryValue(match.category || (match as any).description) !== normalizeGlossaryValue(cur.category || (cur as any).description) ||
                    normalizeGlossaryValue(match.explanation || (match as any).description) !== normalizeGlossaryValue(cur.explanation || (cur as any).description)) {
                    changedKeys.push(cur.source);
                }
            }
            // Check for deleted
            for (const snap of glossarySnapshot) {
                const match = currentGlossary.find(cur => cur.source.toLowerCase() === snap.source.toLowerCase());
                if (!match) {
                    changedKeys.push(snap.source);
                }
            }
            const uniqueChangedKeys = Array.from(new Set([...changedKeys, ...projectGlossaryDirtyKeys].filter(Boolean)));
            if (uniqueChangedKeys.length > 0) {
                console.log("Detected changed glossary keys in dependency tracking:", uniqueChangedKeys);
                // Filter affected items using precise word-bound glossary detector helper
                const affectedItems = activeProjectDetail.textItems.filter(item => {
                    return uniqueChangedKeys.some(key => isGlossaryTermMatch(item.originalText, key));
                });
                {
                    const hasEditedItems = affectedItems.some(item => item.status === 'edited');
                    if (hasEditedItems) {
                        setModalConfig({
                            isOpen: true,
                            title: '术语变更覆盖确认',
                            message: `检测到有 ${affectedItems.length} 个翻译段落受变动术语（如: ${uniqueChangedKeys.slice(0, 3).join(', ')}${uniqueChangedKeys.length > 3 ? '等' : ''}）影响，其中包含您曾手动修改过的精修译文。
              是否由 AI 根据新术语表进行自动重翻并对这些精修译文进行覆盖？（选择“跳过覆盖”将保留您的手工编辑，仅重翻其余段落）`,
                            confirmText: '覆盖并重新翻译',
                            cancelText: '跳过覆盖且重翻',
                            onConfirm: async () => {
                                setModalConfig(null);
                                await runIncrementalTranslation(uniqueChangedKeys, true, false);
                            },
                            onCancel: async () => {
                                setModalConfig(null);
                                await runIncrementalTranslation(uniqueChangedKeys, false, false);
                            }
                        });
                    }
                    else {
                        // No custom edited items, directly run
                        await runIncrementalTranslation(uniqueChangedKeys, false, false);
                    }
                    return;
                }
            }
        }
        // Normal next step
        goToStep(3, 'glossary-confirm');
    };
    // State to hold parameters in Step 3 review
    const [sourceLangStep3, setSourceLangStep3] = useState('English');
    const [targetLangStep3, setTargetLangStep3] = useState('Simplified Chinese');
    const [toneStep3, setToneStep3] = useState('professional training/business Chinese');
    const activeProjectHasTranslation = hasExistingTranslation(activeProjectDetail || activeProjectSummary);
    const projectLanguageSettings = (<div className="grid grid-cols-[minmax(0,1fr)_120px] items-center gap-2 lg:grid-cols-[124px_minmax(0,1fr)_20px_minmax(180px,1fr)_120px]">
      <div className="col-start-1 row-start-1 flex h-9 items-center gap-2 lg:col-auto lg:row-auto">
        <Globe className="h-4 w-4 text-muted-foreground"/>
        <span className="text-sm font-semibold text-foreground">翻译语言</span>
      </div>

      <div className="col-start-1 row-start-2 min-w-0 lg:col-auto lg:row-auto">
        <div className="flex h-9 min-w-0 items-center rounded-lg border border-border bg-background pl-2.5 pr-0.5">
          <span className="mr-2 shrink-0 text-xs font-medium text-muted-foreground">源</span>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
            自动检测 · {activeProjectSummary ? displayLanguageLabel(activeProjectSummary.sourceLang) : '上传后识别'}
          </span>
          <button type="button" onClick={() => handleApplyProjectLanguage(true)} disabled={!activeProjectSummary || activeProjectIsTranslating || isApplyingLanguageChange} aria-label="重新检测源语言" title={activeProjectSummary ? '重新检测源语言' : '导入文件后可重新检测'} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30">
            <RefreshCw className={`h-4 w-4 ${isApplyingLanguageChange ? 'animate-spin' : ''}`}/>
          </button>
        </div>
      </div>

      <div className="hidden h-9 items-center justify-center text-muted-foreground lg:flex">
        <ArrowRight className="h-4 w-4"/>
      </div>

      <label className="relative col-start-2 row-start-2 min-w-0 lg:col-auto lg:row-auto">
        <span className="pointer-events-none absolute left-2.5 top-1/2 z-10 -translate-y-1/2 text-xs font-medium text-muted-foreground">目标</span>
        <select value={pendingTargetLang} onChange={(event) => {
            const nextTargetLang = event.target.value;
            setPendingTargetLang(nextTargetLang);
            if (activeProjectSummary && !activeProjectHasTranslation) {
                void handleApplyProjectLanguage(false, nextTargetLang);
            }
        }} disabled={Boolean(activeProjectSummary) && (activeProjectIsTranslating || isApplyingLanguageChange)} aria-label="目标语言" className="h-9 w-full rounded-lg border border-border bg-background pl-11 pr-2 text-sm font-semibold text-foreground outline-none transition focus:border-primary disabled:cursor-not-allowed disabled:opacity-50">
          {TARGET_LANGUAGE_OPTIONS.map(language => (<option key={language} value={language}>{displayLanguageLabel(language)}</option>))}
        </select>
      </label>

      <div className="col-start-2 row-start-1 flex h-9 w-[120px] items-center justify-end lg:col-auto lg:row-auto">
        {activeProjectSummary && activeProjectHasTranslation && (pendingTargetLang !== activeProjectSummary.targetLang || isApplyingLanguageChange) && (<button type="button" onClick={() => handleApplyProjectLanguage(false)} disabled={activeProjectIsTranslating || isApplyingLanguageChange} className="h-9 w-full rounded-lg bg-primary px-3 text-xs font-bold text-primary-foreground transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40">
            {isApplyingLanguageChange ? '正在应用...' : '应用'}
          </button>)}
      </div>
    </div>);
    return (<div className="min-h-screen bg-background flex flex-col font-sans text-foreground antialiased selection:bg-primary selection:text-primary-foreground">
      {/* Premium Minimal Navigation Banner */}
      <header className="border-b border-border bg-card sticky top-0 z-50">
        <div className="mx-auto h-16 flex max-w-[calc(100vw-2rem)] items-center justify-between px-3">
          <div className="flex items-center gap-2.5-packed">
            <div className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center text-primary-foreground">
              <Languages className="w-5 h-5 animate-pulse"/>
            </div>
          <div className="ml-2">
              <span className="text-sm font-bold tracking-tight text-foreground">AI 文档本地化工作台</span>
              {systemConfig?.hasApiKey ? (<span className="text-[10px] font-sans font-bold px-2.5 py-0.5 rounded-full ml-3 border transition-all bg-blue-50 text-blue-700 border-blue-150" title={`${systemConfig.activeEngine} · ${systemConfig.model}`}>
                  {systemConfig.activeEngine} 已就绪
                </span>) : systemConfig ? (<span className="text-[10px] font-sans font-bold px-2.5 py-0.5 rounded-full ml-3 border border-amber-200 bg-amber-50 text-amber-700">
                  请在 .env 配置 API Key
                </span>) : (<span className="text-[10px] text-muted-foreground font-mono bg-muted border border-border px-1.5 py-0.5 rounded-md ml-3 animate-pulse">
                  正在接入拼装智能引擎...
                </span>)}
            </div>
          </div>

          <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={openPersonalGlossary} className="inline-flex items-center gap-2 rounded-xl border border-border bg-background px-4 py-2 text-xs font-bold text-foreground shadow-sm transition hover:bg-muted">
            <Globe className="h-4 w-4"/>
            个人术语库
          </button>
          </div>

        </div>
      </header>

      {/* Dynamic Navigation Progress Steps */}
      <div className="w-full bg-card px-4 py-5 shadow-sm border-b border-border">
        <div className="mx-auto flex max-w-[calc(100vw-2rem)] items-center justify-between">
          {[
            { id: 1, label: '导入文件', desc: '选择本地文件' },
            { id: 2, label: '术语管理', desc: '预览与添加术语表' },
            { id: 3, label: '智能翻译', desc: '译文对照审校' },
            { id: 4, label: '下载导出', desc: '原格式导出' }
        ].map((step, idx) => {
            const isPassed = currentStep > step.id;
            const isCurrent = currentStep === step.id;
            return (<React.Fragment key={step.id}>
                <div onClick={() => {
                    if (step.id === 1 || activeProjectSummary) {
                        setShowGlobalGlossary(false);
                        goToStep(step.id, 'stepper');
                    }
                }} className={`flex items-center gap-3 cursor-pointer group select-none transition-all ${isCurrent
                    ? 'opacity-100'
                    : isPassed
                        ? 'opacity-80 hover:opacity-100'
                        : 'opacity-40 hover:opacity-75'}`}>
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm transition-all shadow-sm ${isCurrent
                    ? 'bg-primary text-primary-foreground border-2 border-primary ring-4 ring-primary/10'
                    : isPassed
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground border border-border hover:border-muted-foreground'}`}>
                    {isPassed ? '✓' : step.id}
                  </div>
                  <div className="text-left hidden md:block">
                    <p className={`text-sm font-semibold font-sans ${isCurrent ? 'text-foreground' : 'text-muted-foreground'}`}>
                      {step.label}
                    </p>
                    <p className="text-[11px] text-muted-foreground font-sans mt-0.5 leading-tight">
                      {step.desc}
                    </p>
                  </div>
                </div>
                {idx < 3 && (<div className={`flex-1 h-[2px] mx-4 hidden md:block transition-all ${currentStep > step.id ? 'bg-primary' : 'bg-muted'}`}/>)}
              </React.Fragment>);
        })}
        </div>
      </div>

      {/* Main Content Layout with Sticky Left Sidebar */}
      <div className="mx-auto flex w-full max-w-[calc(100vw-2rem)] flex-1 flex-col items-start gap-5 px-2 py-6 md:px-3 md:py-8 lg:flex-row">

        {/* Left Sidebar: Projects History & Custom Finetuning Controls */}
        <aside className="w-full lg:w-72 xl:w-80 shrink-0 bg-card border border-border rounded-3xl p-5 space-y-6 lg:sticky lg:top-20">
          {/* History Decks Section */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-extrabold text-foreground flex items-center gap-2 font-sans uppercase tracking-wider">
                <History className="w-4 h-4 text-muted-foreground animate-pulse"/>
                项目
              </h3>
              <button id="new-project-btn" onClick={handleCreateNewProject} className="px-3.5 py-2 text-xs font-bold text-primary-foreground bg-primary hover:bg-primary-hover rounded-xl border border-primary shadow-sm transition-all cursor-pointer flex items-center gap-1.5" title="新建项目">
                <Plus className="w-4 h-4"/>
                新建
              </button>
            </div>

            {loadingProjects && projectsList.length === 0 ? (<div className="flex flex-col items-center justify-center py-8 space-y-2">
                <div className="w-4 h-4 rounded-full border-2 border-primary border-t-transparent animate-spin"/>
                <p className="text-[10px] text-muted-foreground font-sans text-center">正在扫描项目...</p>
              </div>) : projectsList.length === 0 ? (<div className="text-center py-6 text-muted-foreground/60 space-y-1.5 border border-dashed border-border rounded-2xl bg-muted/20">
                <p className="text-xs font-sans">未发现已导入的幻灯片</p>
              </div>) : (<div className="space-y-2 max-h-[300px] overflow-y-auto pr-1 scrollbar-thin">
                {projectsList.map((p) => {
                const isActive = activeProjectSummary?.id === p.id;
                return (<div id={`project-card-${p.id}`} key={p.id} onClick={() => {
                        setActiveProjectSummary(p);
                        setShowGlobalGlossary(false);
                        if (p.status === 'completed' || p.status === 'generating') {
                            goToStep(4, 'project-card');
                        }
                        else if (p.status === 'translated' || p.status === 'partial' || p.status === 'translating' || p.status === 'pausing' || p.status === 'paused') {
                            goToStep(3, 'project-card');
                        }
                        else {
                            goToStep(2, 'project-card');
                        }
                    }} className={`flex items-start gap-2.5 p-3 rounded-2xl border transition-all cursor-pointer bg-card hover:shadow-xs text-left ${isActive
                        ? 'border-primary ring-2 ring-primary/10 shadow-2xs'
                        : 'border-border'}`}>
                      <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 transition-colors ${isActive ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                        <FileText className="w-4 h-4"/>
                      </div>
                      <div className="flex-1 min-w-0 flex flex-col justify-center">
                        <p className={`text-xs font-extrabold truncate ${isActive ? 'text-primary' : 'text-foreground'}`} title={p.originalName}>
                          {p.originalName}
                        </p>
                        <p className="text-[10px] uppercase font-mono mt-0.5 text-muted-foreground/85 font-semibold">
                          状态: {p.status === 'uploaded' ? '待处理(uploaded)' : p.status === 'translated' ? '已翻译(translated)' : p.status === 'partial' ? '待补译(partial)' : p.status === 'completed' ? '已排版(completed)' : p.status}
                        </p>
                      </div>
                      <button id={`delete-project-${p.id}`} onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteProject(p.id, e);
                    }} className="p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md transition self-center cursor-pointer" title="删除">
                        <Trash2 className="w-3.5 h-3.5"/>
                      </button>
                    </div>);
            })}
              </div>)}
          </div>

          {/* System Action maintenance block */}
          <div className="p-4 rounded-2xl bg-muted/30 border border-border flex flex-col gap-3 text-left">
            <div>
              <h4 className="text-xs font-extrabold text-foreground font-sans uppercase tracking-wider">一键微调与恢复</h4>
              <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                清除翻译对照记忆排查重译故障，或者一键恢复出厂。
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <button id="clear-tm-btn" type="button" onClick={handleClearTMOnly} className="w-full py-2 bg-card hover:bg-muted text-foreground rounded-full text-xs font-bold border border-border transition-colors cursor-pointer text-center">
                仅清除对照映射
              </button>
              <button id="system-factory-reset-btn" type="button" onClick={handleSystemReset} disabled={resetting} className="w-full py-2 bg-destructive text-white hover:bg-destructive/90 rounded-full text-xs font-bold transition-colors cursor-pointer flex items-center justify-center gap-1.5">
                {resetting ? '正在重置...' : '一键恢复出厂设置'}
              </button>
            </div>
          </div>
        </aside>

        {/* Right Side: Main Dashboard Area */}
        <main className="flex-1 w-full min-w-0 space-y-6">

          {/* Translation pipelines status helper banners */}
          <AnimatePresence>
            {errorMessage && (<motion.div id="global-error-banner" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="flex items-start gap-3.5 rounded-lg border border-destructive/30 bg-destructive-muted p-4">
                <AlertCircle className="w-5 h-5 text-destructive mt-0.5 shrink-0"/>
                <div className="flex-1 text-left font-sans">
                  <p className="text-xs font-bold text-destructive">任务处理执行失败</p>
                  <p className="text-xs text-destructive mt-1 leading-relaxed">{errorMessage}</p>
                </div>
              </motion.div>)}


          </AnimatePresence>

          {/* Active Wizard View rendering */}
          <div className="focus-container">
            {showGlobalGlossary && (<div className="animate-fade space-y-6 font-sans">
                <div className="flex flex-col gap-4 px-1 text-left md:flex-row md:items-center md:justify-between">
                  <div>
                    <h2 className="text-2xl font-bold text-foreground">个人术语库</h2>
                    <p className="mt-2 text-xs font-medium leading-relaxed text-muted-foreground">
                      按客户、产品或行业维护多套可复用术语；项目可在 P2 同时加载多套术语库。
                    </p>
                  </div>
                  <button type="button" onClick={closePersonalGlossary} aria-label="Back to project" title="Back to project" className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-background text-xs font-bold text-foreground transition hover:bg-muted">
                    <ChevronLeft className="h-5 w-5"/>
                  </button>
                </div>
                <GlossaryManager glossary={glossary} libraries={glossaryLibraries} onAddTerm={handleAddGlossaryTerm} onUpdateTerm={handleUpdateGlossaryTerm} onDeleteTerm={handleDeleteGlossaryTerm} onGlossaryImported={setGlossary} onLibrariesChanged={handleGlossaryLibrariesChanged} isAdding={isAddingGlossary}/>
              </div>)}

            {/* Step 1 & Step 2 rendered inside UploadView */}
            {!showGlobalGlossary && (currentStep === 1 || currentStep === 2) && (<div className="space-y-6">
                <UploadView onUploadSuccess={handleUploadSuccess} activeProject={activeProjectSummary} onStartTranslation={handleStartTranslation} isTranslating={activeProjectIsTranslating} onProjectUpdated={handleProjectUpdated} currentStep={currentStep} onNextStep={handleGlossaryConfirmNext} onStepChange={(step) => goToStep(step, 'upload-view')} onOpenGlobalGlossary={openPersonalGlossary} onProjectGlossaryChanged={handleProjectGlossaryChanged} personalGlossary={glossary} glossaryLibraries={glossaryLibraries} targetLanguage={pendingTargetLang} languageSettings={projectLanguageSettings}/>
              </div>)}

            {/* Step 3: Translating & Interactive Review Database Table mapping */}
            {!showGlobalGlossary && currentStep === 3 && (<div className="space-y-6 font-sans">
                {activeProjectSummary ? (<div className="animate-fade text-left">
                    {/* Table Render (Handles progress indicators, global switches, find & replace, and text highlighting) */}
                    {activeProjectDetail ? (<ReviewTable projectId={activeProjectDetail.id} textItems={activeProjectDetail.textItems} onUpdateItem={handleUpdateItem} isUpdatingItem={isUpdatingTableItem} isTranslating={activeProjectIsTranslating} translationProgress={activeProjectDetail.translationProgress} translationStatus={activeProjectDetail.status} onPauseTranslation={handlePauseTranslation} onResumeTranslation={handleResumeTranslation} onNextStep={() => goToStep(4, 'review-next')} onPrevStep={() => goToStep(2, 'review-prev')} onTranslatePending={handleTranslatePendingItems} glossary={activeProjectDetail.glossary} recentChangedKeys={recentChangedKeys} sourceLang={activeProjectDetail.sourceLang} targetLang={activeProjectDetail.targetLang} documentType={activeProjectDetail.documentType}/>) : (<div className="flex flex-col items-center justify-center py-20 bg-card border border-border rounded-3xl">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"/>
                        <p className="text-xs text-muted-foreground mt-3 font-medium">载入待翻译文段对照表中...</p>
                      </div>)}
                  </div>) : (<div className="bg-card border border-dashed border-border rounded-3xl p-12 text-center text-muted-foreground text-xs font-semibold">
                    请先在第一步中上传 PPT 演示文稿文件，以备极速获取分析出的翻译句段对照。
                  </div>)}
              </div>)}

            {/* Step 4: Quality Checks & Assemble One-Click Download Trigger */}
            {!showGlobalGlossary && currentStep === 4 && (<div className="animate-fade font-sans">
                {activeProjectDetail ? (<QAView qaReport={activeProjectDetail.qaReport} project={activeProjectSummary} projectDetail={activeProjectDetail} onGeneratePPTX={handleGeneratePPTX} isGenerating={isGenerating} globalGlossary={glossary} onAddGlobalGlossaryTerms={handleAddGlobalGlossaryTerms} onOpenGlossarySaveDialog={openGlossarySaveDialog} onPrevStep={() => goToStep(3, 'qa-prev')} onBackToHome={() => {
                    setActiveProjectSummary(null);
                    setActiveProjectDetail(null);
                    goToStep(1, 'back-home');
                }}/>) : (<div className="bg-card border border-dashed border-border rounded-3xl p-12 text-center text-muted-foreground text-xs">
                    排版自动校验及封包下载工具正在加载中...
                  </div>)}
              </div>)}

          </div>
        </main>
      </div>

      {glossarySaveDialogTerms.length > 0 && (<div className="fixed inset-0 z-[120] flex items-center justify-center bg-neutral-900/60 p-4 backdrop-blur-xs font-sans">
          <div className="w-full max-w-2xl rounded-2xl border border-border bg-background p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-base font-bold text-foreground">是否把以下术语添加到术语库？</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  选择需要沉淀到个人术语库的本文术语；未选择的术语不会添加。
                </p>
              </div>
              <span className="rounded-full bg-muted px-3 py-1 text-xs font-bold text-muted-foreground">
                已选 {selectedGlossarySaveKeys.size} / 可添加 {addableGlossaryDialogTerms.length}
              </span>
            </div>

            <div className="mt-5 max-h-72 overflow-y-auto rounded-xl border border-border">
              <table className="w-full border-collapse text-left text-xs">
                <thead className="sticky top-0 bg-muted text-muted-foreground">
                  <tr>
                    <th className="w-10 px-3 py-2">
                      <input type="checkbox" checked={addableGlossaryDialogTerms.length > 0 && selectedGlossarySaveKeys.size === addableGlossaryDialogTerms.length} disabled={addableGlossaryDialogTerms.length === 0} ref={input => {
                if (input) {
                    input.indeterminate = selectedGlossarySaveKeys.size > 0 && selectedGlossarySaveKeys.size < addableGlossaryDialogTerms.length;
                }
            }} onChange={e => setAllGlossarySaveTerms(e.target.checked)} aria-label="Select all glossary terms" className="h-4 w-4 rounded border-border"/>
                    </th>
                    <th className="px-3 py-2 font-bold">Source</th>
                    <th className="px-3 py-2 font-bold">Target</th>
                    <th className="px-3 py-2 font-bold">Explanation</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {glossarySaveDialogTerms.map(term => {
                const isSaved = isGlossaryDialogTermSaved(term);
                return (<tr key={`${term.source}-${term.target}`} className={isSaved ? 'bg-muted/30' : undefined}>
                      <td className="px-3 py-2">
                        <input type="checkbox" checked={selectedGlossarySaveKeys.has(glossaryDialogKey(term))} disabled={isSaved} onChange={() => toggleGlossarySaveTerm(term)} aria-label={`Select ${term.source}`} className="h-4 w-4 rounded border-border disabled:cursor-not-allowed disabled:opacity-40"/>
                      </td>
                      <td className="px-3 py-2 font-mono font-semibold text-foreground">{term.source}</td>
                      <td className="px-3 py-2 font-semibold text-green-700">
                        <div className="flex items-center gap-2">
                          <span>{term.target}</span>
                          {isSaved && (<span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold text-muted-foreground">已添加</span>)}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{term.explanation || term.category || '-'}</td>
                    </tr>);
            })}
                </tbody>
              </table>
            </div>

            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <button type="button" disabled={isSavingGlossaryDialog} onClick={() => {
                setGlossarySaveDialogTerms([]);
                setSelectedGlossarySaveKeys(new Set());
            }} className="rounded-xl border border-border px-4 py-2 text-xs font-bold text-muted-foreground hover:bg-muted disabled:opacity-50">
                暂不
              </button>
              <button type="button" disabled={isSavingGlossaryDialog || selectedGlossarySaveKeys.size === 0} onClick={saveSelectedGlossaryDialogTerms} className="rounded-xl bg-primary px-4 py-2 text-xs font-bold text-primary-foreground hover:bg-primary-hover disabled:opacity-50">
                {isSavingGlossaryDialog ? '正在添加...' : '添加'}
              </button>
            </div>
          </div>
        </div>)}

      {/* Dynamic Confirmation Dialog Backdrop Overlay */}
      <AnimatePresence>
        {modalConfig && modalConfig.isOpen && (<motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-neutral-900/60 backdrop-blur-xs z-[100] flex items-center justify-center p-4 font-sans" onClick={() => setModalConfig(null)}>
            <motion.div initial={{ scale: 0.95, y: 15 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, y: 15 }} onClick={(e) => e.stopPropagation()} className="w-full max-w-md space-y-4 rounded-lg border border-border bg-card p-6 text-left shadow-2xl">
              <div className={`flex items-center gap-3 ${modalConfig.isDanger ? 'text-destructive' : 'text-primary'}`}>
                {modalConfig.isDanger ? <AlertCircle className="h-6 w-6 shrink-0"/> : <Info className="h-6 w-6 shrink-0"/>}
                <h3 className="text-sm font-bold tracking-tight text-foreground">{modalConfig.title}</h3>
              </div>
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                {modalConfig.message}
              </p>
              <div className="flex items-center justify-end gap-3 pt-2">
                {!modalConfig.hideCancel && <button type="button" onClick={async () => {
                    if (modalConfig.onCancel) {
                        await modalConfig.onCancel();
                    }
                    setModalConfig(null);
                }} className="cursor-pointer rounded-lg border border-border bg-background px-4 py-2 text-xs font-semibold tracking-tight text-foreground transition hover:bg-muted">
                  {modalConfig.cancelText}
                </button>}
                <button type="button" onClick={() => {
                modalConfig.onConfirm();
            }} className={`cursor-pointer rounded-lg px-4 py-2 text-xs font-semibold tracking-tight text-white transition ${modalConfig.isDanger ? 'bg-destructive hover:bg-destructive/90' : 'bg-primary hover:bg-primary-hover'}`}>
                  {modalConfig.confirmText}
                </button>
              </div>
            </motion.div>
          </motion.div>)}
      </AnimatePresence>

      {/* Dynamic Floating Toast Notifications */}
      <AnimatePresence>
        {notificationConfig && notificationConfig.isOpen && (<motion.div initial={{ opacity: 0, y: 50, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 20, scale: 0.95 }} className="fixed bottom-6 right-6 z-[100] max-w-sm w-full font-sans">
            <div className={`flex items-start gap-3 rounded-lg border p-4 text-left shadow-lg ${notificationConfig.type === 'success'
                ? 'border-success/30 bg-success-muted'
                : notificationConfig.type === 'error'
                    ? 'border-destructive/30 bg-destructive-muted'
                    : notificationConfig.type === 'warning'
                        ? 'border-warning/30 bg-warning-muted'
                        : 'border-primary/25 bg-card'}`}>
              <div className={`shrink-0 rounded-lg p-1.5 ${notificationConfig.type === 'success'
                ? 'bg-success/10 text-success'
                : notificationConfig.type === 'error'
                    ? 'bg-destructive/10 text-destructive'
                    : notificationConfig.type === 'warning'
                        ? 'bg-warning/10 text-warning-foreground'
                        : 'bg-primary/10 text-primary'}`}>
                {notificationConfig.type === 'success' ? (<CheckCircle2 className="h-4 w-4"/>) : notificationConfig.type === 'error' ? (<XCircle className="h-4 w-4"/>) : notificationConfig.type === 'warning' ? (<AlertTriangle className="h-4 w-4"/>) : (<Info className="h-4 w-4"/>)}
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="text-xs font-bold text-foreground">{notificationConfig.title}</h4>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{notificationConfig.message}</p>
              </div>
              <button type="button" onClick={() => setNotificationConfig(null)} aria-label="关闭提示" title="关闭提示" className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-background/70 hover:text-foreground">
                <X className="h-3.5 w-3.5"/>
              </button>
            </div>
          </motion.div>)}
      </AnimatePresence>
    </div>);
}
