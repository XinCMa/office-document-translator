import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import multer from 'multer';
import JSZip from 'jszip';
import { db, Project, ExtractedTextItem, GlossaryTerm, GlossaryLibrary, QAStatus, SourceContainer, TranslationSegment, SegmentTermHint } from './server/db.js';
import { extractPPTXText, writePPTXTranslations, PPTXStats } from './server/pptx.js';
import { extractDOCXText, writeDOCXTranslations, collectDOCXParagraphTextsFromXml, isDocxTextPart, hasDOCXFixedLayoutFlyerRisk, DOCXStats } from './server/docx.js';
import { extractPDFText, writePDFTranslations, PDFStats } from './server/pdf.js';
import { extractXLSXText, writeXLSXTranslations, collectXLSXCellTextsFromXml, XLSXStats } from './server/xlsx.js';
import { getModelApiConfig, translateStrings, translateSegments, runPreDetection, resolveGlossaryConflicts, type TranslationContextMap, type TranslationSegmentRequest } from './server/translator.js';
import { buildGlossaryImportPreview, linkGlobalGlossaryToProject, mergeGlossaryTerms, mergeProjectGlossaryTerms, parseGlossaryFile, validateGlossaryUsage, buildSegmentTermHints, validateSegmentTermHints, orientGlossaryForLanguagePair, type GlossaryConflictDecisionMap } from './server/glossary.js';
import type { ProjectGlossaryReviewCandidate } from './server/glossary.js';
import { createServer as createViteServer } from 'vite';
import { detectSourceLanguageFromTexts, getLanguageEvidence, hasLikelyResidualLanguage, normalizeLanguage, type SupportedLanguage } from './server/language-detection.js';
import { resolveUploadedFileName, sanitizeOriginalFileName } from './server/file-name.js';
const upload = multer({ dest: 'uploads/', defParamCharset: 'utf8' });
async function startServer() {
    const PROJECT_GLOSSARY_LANGUAGE_VERSION = 3;
    const app = express();
    const PORT = Number(process.env.PORT || 8080);
    const GENERATION_PIPELINE_VERSION = 2;
    const activeTranslationJobs = new Set<string>();
    const translationJobControls = new Map<string, {
        pauseRequested: boolean;
    }>();
    const queuedPreDetections = new Set<string>();
    app.use(express.json({ limit: '100mb' }));
    app.use(express.urlencoded({ extended: true, limit: '100mb' }));
    // Helper to extract client ID from Header, Query, or Cookie
    function getClientId(req: express.Request): string | undefined {
        let clientId = req.get('X-Client-ID');
        if (!clientId && req.query.clientId) {
            clientId = req.query.clientId as string;
        }
        if (!clientId && req.headers.cookie) {
            try {
                const cookies = req.headers.cookie.split(';').reduce((acc: Record<string, string>, cookie) => {
                    const parts = cookie.trim().split('=');
                    const key = parts[0];
                    const value = parts.slice(1).join('=');
                    if (key && value) {
                        acc[key] = decodeURIComponent(value);
                    }
                    return acc;
                }, {});
                if (cookies.clientId) {
                    clientId = cookies.clientId;
                }
            }
            catch (e) {
                // ignore
            }
        }
        return clientId || undefined;
    }
    const cjkReg = /[\u3400-\u9fff]/;
    const normalizeQaText = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();
    const stripGlossaryTargets = (text: string, activeGlossary: GlossaryTerm[]): string => {
        let stripped = text;
        for (const term of activeGlossary) {
            if (!term.target || !/[a-zA-Z]{4,}/.test(term.target))
                continue;
            const escapedTarget = term.target.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
            stripped = stripped.replace(new RegExp(escapedTarget, 'gi'), ' ');
        }
        return stripped;
    };
    const isProjectTargetEnglish = (project: Project): boolean => project.translationDirection === 'zh-en' || String(project.targetLang || '').toLowerCase().includes('english');
    const hasUnexpectedResidualSourceLanguage = (text: string, activeGlossary: GlossaryTerm[], project: Project): boolean => {
        const sourceLang = normalizeLanguage(project.sourceLang, 'English');
        const targetLang = normalizeLanguage(project.targetLang, 'Simplified Chinese');
        return hasLikelyResidualLanguage(stripGlossaryTargets(text, activeGlossary), sourceLang, targetLang);
    };
    const isQaTranslationWarning = (source: string, translation: string | undefined, activeGlossary: GlossaryTerm[], project: Project): boolean => {
        if (!translation || !translation.trim())
            return true;
        const targetEnglish = isProjectTargetEnglish(project);
        const sourceIsSentence = source.trim().length > (targetEnglish ? 6 : 12);
        if (!sourceIsSentence)
            return false;
        const sameAsOriginal = normalizeQaText(source) === normalizeQaText(translation)
            && source.trim().length > (targetEnglish ? 6 : 12);
        const hasResidualSourceLanguage = hasUnexpectedResidualSourceLanguage(translation, activeGlossary, project);
        if (!sameAsOriginal && !hasResidualSourceLanguage)
            return false;
        return true;
    };
    function safeIdPart(value: unknown): string {
        return String(value || '')
            .replace(/[^a-zA-Z0-9_-]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 80) || 'x';
    }
    function getItemSegmentId(project: Project, item: ExtractedTextItem): string {
        if (item.segmentId)
            return item.segmentId;
        const documentType = project.documentType || 'pptx';
        return `${documentType}:${safeIdPart(item.id)}`;
    }
    function getContainerType(project: Project, item: ExtractedTextItem): SourceContainer['containerType'] {
        const documentType = project.documentType || 'pptx';
        const partPath = String(item.partPath || item.slidePath || '').toLowerCase();
        if (item.partType === 'diagram')
            return 'smartart';
        if (documentType === 'xlsx')
            return 'spreadsheet_cell';
        if (documentType === 'pptx')
            return 'shape';
        if (partPath.includes('/header'))
            return 'header';
        if (partPath.includes('/footer'))
            return 'footer';
        return 'paragraph';
    }
    function getItemContainerId(project: Project, item: ExtractedTextItem): string {
        if (item.containerId)
            return item.containerId;
        const documentType = project.documentType || 'pptx';
        return `${documentType}:${getContainerType(project, item)}:${safeIdPart(item.id)}`;
    }
    function basicLocationLabel(project: Project, item: ExtractedTextItem): string {
        const documentType = project.documentType || 'pptx';
        const partPath = String(item.partPath || item.slidePath || '');
        if (documentType === 'pptx')
            return item.partType === 'diagram' ? `Slide ${item.slideNum} SmartArt` : `Slide ${item.slideNum}`;
        if (documentType === 'xlsx')
            return `Excel sheet ${item.slideNum || 1}`;
        if (item.partType === 'diagram')
            return 'Word SmartArt';
        if (partPath.includes('/header'))
            return 'Word header';
        if (partPath.includes('/footer'))
            return 'Word footer';
        const pageMarker = item.slideNum > 0 ? `, page marker ${item.slideNum}` : '';
        return `Word paragraph ${(item.pIdx ?? 0) + 1}${pageMarker}`;
    }
    function ensureProjectTranslationStructure(project: Project): void {
        const documentType = project.documentType || 'pptx';
        const translationBySegmentId = project.translationBySegmentId || {};
        const existingSegments = new Map((project.translationSegments || []).map(segment => [segment.segmentId, segment]));
        const containers = new Map<string, SourceContainer>();
        const segments: TranslationSegment[] = [];
        for (const item of project.textItems || []) {
            const segmentId = getItemSegmentId(project, item);
            const containerId = getItemContainerId(project, item);
            item.segmentId = segmentId;
            item.containerId = containerId;
            if (!translationBySegmentId[segmentId]) {
                if (item.translatedText) {
                    translationBySegmentId[segmentId] = item.translatedText;
                }
                else if (project.translationMap?.[item.originalText]) {
                    translationBySegmentId[segmentId] = project.translationMap[item.originalText];
                    item.translatedText = project.translationMap[item.originalText];
                    item.status = item.translatedText === item.originalText ? 'preserved' : 'translated';
                }
            }
            else if (!item.translatedText) {
                item.translatedText = translationBySegmentId[segmentId];
                item.status = item.translatedText === item.originalText ? 'preserved' : 'translated';
            }
            const container = containers.get(containerId) || {
                containerId,
                documentType,
                containerType: getContainerType(project, item),
                sourceLocation: {
                    slideNum: item.slideNum,
                    slidePath: item.slidePath,
                    partPath: item.partPath,
                    partType: item.partType,
                    pIdx: item.pIdx
                },
                rawText: item.originalText,
                segmentIds: []
            };
            if (!container.segmentIds.includes(segmentId))
                container.segmentIds.push(segmentId);
            containers.set(containerId, container);
            const existing = existingSegments.get(segmentId);
            segments.push({
                segmentId,
                containerId,
                sourceText: item.originalText,
                translatedText: translationBySegmentId[segmentId] || item.translatedText || undefined,
                documentType,
                location: existing?.location || {
                    locationLabel: basicLocationLabel(project, item),
                    slideNumber: item.slideNum,
                    paragraphIndex: item.pIdx,
                    partName: item.partPath || item.slidePath
                },
                context: existing?.context || {},
                status: item.status === 'edited' ? 'edited' : (item.translatedText ? 'translated' : 'pending')
            });
        }
        project.sourceContainers = Array.from(containers.values());
        project.translationSegments = segments;
        project.translationBySegmentId = translationBySegmentId;
    }
    function getEffectiveGlossary(project: Project, fallback?: GlossaryTerm[]): GlossaryTerm[] {
        if (fallback && fallback.length > 0)
            return fallback;
        if (project.effectiveGlossarySnapshot && project.effectiveGlossarySnapshot.length > 0) {
            return project.effectiveGlossarySnapshot;
        }
        if (project.glossary && project.glossary.length > 0)
            return project.glossary;
        return db.getGlossary(project.clientId);
    }
    function refreshProjectSegmentTermHints(project: Project, glossary?: GlossaryTerm[]): Record<string, SegmentTermHint[]> {
        ensureProjectTranslationStructure(project);
        const effectiveGlossary = getEffectiveGlossary(project, glossary);
        // Keep a project-local snapshot so later library edits do not silently
        // change an active or historical translation job.
        project.effectiveGlossarySnapshot = effectiveGlossary.map(term => ({ ...term }));
        const segmentInputs = (project.textItems || []).map(item => ({
            segmentId: getItemSegmentId(project, item),
            sourceText: item.originalText
        }));
        const decisions = (project.glossaryConflictDecisions || {}) as GlossaryConflictDecisionMap;
        const hints = buildSegmentTermHints(segmentInputs, project.effectiveGlossarySnapshot, decisions);
        project.segmentTermHints = hints;
        for (const segment of project.translationSegments || []) {
            segment.termHints = hints[segment.segmentId] || [];
        }
        return hints;
    }
    function projectGlossaryValidationReport(project: Project, glossary?: GlossaryTerm[]) {
        const hints = project.segmentTermHints || refreshProjectSegmentTermHints(project, glossary);
        return validateSegmentTermHints(project.textItems || [], project.translationBySegmentId || {}, hints);
    }
    function applySegmentTranslations(project: Project, translatedBySegmentId: Record<string, string>, protectEdited = true): void {
        ensureProjectTranslationStructure(project);
        const editedSegmentIds = new Set((project.textItems || [])
            .filter(item => item.status === 'edited')
            .map(item => getItemSegmentId(project, item)));
        const acceptedTranslations = Object.fromEntries(Object.entries(translatedBySegmentId).filter(([segmentId]) => !(protectEdited && editedSegmentIds.has(segmentId))));
        project.translationBySegmentId = { ...(project.translationBySegmentId || {}), ...acceptedTranslations };
        for (const item of project.textItems || []) {
            const segmentId = getItemSegmentId(project, item);
            if (protectEdited && item.status === 'edited' && translatedBySegmentId[segmentId] !== undefined)
                continue;
            const transValue = project.translationBySegmentId[segmentId];
            if (!transValue)
                continue;
            item.translatedText = transValue;
            item.status = transValue === item.originalText ? 'preserved' : 'translated';
            project.translationMap[item.originalText] = transValue;
        }
        for (const segment of project.translationSegments || []) {
            const transValue = project.translationBySegmentId[segment.segmentId];
            if (!transValue)
                continue;
            segment.translatedText = transValue;
            if (segment.status !== 'edited')
                segment.status = 'translated';
        }
    }
    function clearSegmentTranslations(project: Project, segmentIds: string[]): void {
        ensureProjectTranslationStructure(project);
        const targetIds = new Set(segmentIds);
        for (const segmentId of targetIds) {
            delete project.translationBySegmentId?.[segmentId];
        }
        for (const item of project.textItems || []) {
            const segmentId = getItemSegmentId(project, item);
            if (!targetIds.has(segmentId))
                continue;
            item.translatedText = '';
            item.status = 'pending';
        }
        for (const segment of project.translationSegments || []) {
            if (!targetIds.has(segment.segmentId))
                continue;
            segment.translatedText = undefined;
            segment.status = 'pending';
        }
        project.translatedFilePath = null;
        project.qaReport = null;
        project.generationProgress = undefined;
    }
    function collectPendingTranslationSegmentIds(project: Project): string[] {
        ensureProjectTranslationStructure(project);
        const pending: string[] = [];
        for (const item of project.textItems || []) {
            if (item.status === 'edited')
                continue;
            const segmentId = getItemSegmentId(project, item);
            const translated = project.translationBySegmentId?.[segmentId] || item.translatedText;
            if (!translated || !translated.trim() || item.status === 'pending') {
                pending.push(segmentId);
            }
        }
        return pending;
    }
    async function retryQaWarningTranslationsOnce(project: Project, activeGlossary: GlossaryTerm[]): Promise<number> {
        const retrySegmentIds = new Set<string>();
        for (const item of project.textItems) {
            if (item.status === 'edited')
                continue;
            if (isQaTranslationWarning(item.originalText, item.translatedText, activeGlossary, project)) {
                retrySegmentIds.add(getItemSegmentId(project, item));
                item.status = 'pending';
            }
        }
        const segmentIdsToRequest = Array.from(retrySegmentIds);
        if (segmentIdsToRequest.length === 0)
            return 0;
        clearSegmentTranslations(project, segmentIdsToRequest);
        project.status = 'translating';
        db.saveProject(project);
        const newlyTranslatedBySegmentId = await translateSegments(buildTranslationSegmentInputs(project, segmentIdsToRequest), project.sourceLang, project.targetLang, project.tone, activeGlossary, project.preDetectReport?.topic || undefined, undefined, true, project.translationDomain);
        applySegmentTranslations(project, newlyTranslatedBySegmentId);
        db.saveProject(project);
        return segmentIdsToRequest.length;
    }
    async function retryGlossaryMissTranslationsOnce(project: Project, activeGlossary: GlossaryTerm[]): Promise<number> {
        const validationReport = projectGlossaryValidationReport(project, activeGlossary);
        const retrySegmentIds = new Set<string>();
        for (const finding of validationReport.findings) {
            if (finding.status !== 'GLOSSARY_MISS')
                continue;
            const item = project.textItems.find(textItem => textItem.id === finding.itemId);
            if (!item || item.status === 'edited')
                continue;
            retrySegmentIds.add(getItemSegmentId(project, item));
            item.status = 'pending';
        }
        const segmentIdsToRequest = Array.from(retrySegmentIds);
        if (segmentIdsToRequest.length === 0) {
            project.glossaryValidationReport = validationReport;
            return 0;
        }
        clearSegmentTranslations(project, segmentIdsToRequest);
        project.status = 'translating';
        db.saveProject(project);
        const newlyTranslatedBySegmentId = await translateSegments(buildTranslationSegmentInputs(project, segmentIdsToRequest), project.sourceLang, project.targetLang, project.tone, activeGlossary, project.preDetectReport?.topic || undefined, undefined, true, project.translationDomain);
        applySegmentTranslations(project, newlyTranslatedBySegmentId);
        project.glossaryValidationReport = projectGlossaryValidationReport(project, activeGlossary);
        project.status = 'translated';
        db.saveProject(project);
        return segmentIdsToRequest.length;
    }
    const collectPendingTranslationOriginals = (project: Project): string[] => {
        return collectPendingTranslationSegmentIds(project);
    };
    async function backfillPendingTranslations(project: Project, activeGlossary: GlossaryTerm[], maxRounds = 3): Promise<number> {
        let totalBackfilled = 0;
        for (let round = 1; round <= maxRounds; round++) {
            const segmentIdsToRequest = collectPendingTranslationSegmentIds(project);
            if (segmentIdsToRequest.length === 0)
                break;
            console.log(`[PENDING BACKFILL] Project ${project.id}: round ${round}/${maxRounds}, ${segmentIdsToRequest.length} pending segment(s).`);
            project.status = 'translating';
            project.translationProgress = {
                total: segmentIdsToRequest.length,
                completed: 0,
                percent: 0,
                phase: 'backfilling',
                message: `正在补全遗漏译文（第 ${round}/${maxRounds} 轮）...`
            };
            db.saveProject(project);
            try {
                const newlyTranslatedBySegmentId = await translateSegments(buildTranslationSegmentInputs(project, segmentIdsToRequest), project.sourceLang, project.targetLang, project.tone, activeGlossary, project.preDetectReport?.topic || undefined, (batchIndex, totalBatches, batchCount, newlyTranslated) => {
                    applySegmentTranslations(project, newlyTranslated);
                    const completedCount = segmentIdsToRequest.filter(segmentId => project.translationBySegmentId?.[segmentId]).length;
                    project.translationProgress = {
                        total: segmentIdsToRequest.length,
                        completed: completedCount,
                        percent: Math.min(100, Math.round((completedCount / Math.max(1, segmentIdsToRequest.length)) * 100)),
                        phase: 'backfilling',
                        message: `正在补全遗漏译文（第 ${round}/${maxRounds} 轮）...`
                    };
                    db.saveProject(project);
                }, true, project.translationDomain);
                applySegmentTranslations(project, newlyTranslatedBySegmentId);
                totalBackfilled += Object.keys(newlyTranslatedBySegmentId).length;
                db.saveProject(project);
            }
            catch (err) {
                console.error(`[PENDING BACKFILL] Project ${project.id}: round ${round} failed.`, err);
                if (round >= maxRounds)
                    break;
            }
        }
        return totalBackfilled;
    }
    const finalizeTranslationStatus = (project: Project) => {
        const wasTranslationActive = project.status === 'translating' || project.status === 'partial';
        const remaining = collectPendingTranslationOriginals(project);
        if (remaining.length > 0) {
            project.status = 'partial';
            project.errorMsg = `仍有 ${remaining.length} 条待补译。请在 P3 点击“补译剩余待翻译项”。`;
        }
        else {
            project.status = 'translated';
            project.errorMsg = undefined;
            if (wasTranslationActive) {
                project.translationCompletedAt = new Date().toISOString();
            }
        }
        if (project.translationProgress) {
            project.translationProgress.completed = project.translationProgress.total;
            project.translationProgress.percent = remaining.length > 0 ? Math.min(project.translationProgress.percent, 99) : 100;
            project.translationProgress.phase = 'completed';
            project.translationProgress.message = remaining.length > 0 ? '翻译流程结束，仍有内容需要补译。' : '翻译与检查已全部完成。';
        }
    };
    const glossaryToPreDetectTerms = (glossary: GlossaryTerm[]) => glossary.map(term => ({
        source: term.source,
        target: term.target,
        category: term.category || (term as any).description,
        explanation: term.explanation || (term as any).description,
        checked: term.checked !== false,
        origin: term.origin,
        status: term.status,
        usageCount: term.usageCount,
        confidence: term.confidence,
        reason: term.reason,
        sourceLang: term.sourceLang,
        targetLang: term.targetLang,
        direction: term.direction
    } as any));
    function languagePairForLangs(sourceLang: string, targetLang: string): string {
        return `${sourceLang}-${targetLang}`;
    }
    function normalizeTranslationDirection(raw: any, sourceLang?: string, targetLang?: string): string {
        if (raw === 'auto' || !raw)
            return languagePairForLangs(sourceLang || 'English', targetLang || 'Simplified Chinese');
        if (raw === 'en-zh' || raw === 'zh-en')
            return raw;
        return String(raw);
    }
    function normalizeTranslationDomain(_raw: any): 'business' {
        return 'business';
    }
    function defaultToneForTargetLanguage(targetLang: string): string {
        return `professional business/training ${targetLang}`;
    }
    function defaultGlossaryPresetForDomain(): string {
        return 'business';
    }
    function projectPreDetectionContext(project: Project): string {
        return [
            project.sourceLang,
            project.targetLang,
            project.translationDomain
        ].join('::');
    }
    function inferLegacyGlossaryTargetLanguage(term: GlossaryTerm): SupportedLanguage | null {
        const sample = [term.target, term.explanation].filter(Boolean).join('\n');
        if (!sample.trim())
            return null;
        const evidence = getLanguageEvidence(sample);
        if (evidence.japaneseCount >= 4)
            return 'Japanese';
        if (evidence.arabicCount >= 4)
            return 'Arabic';
        if (evidence.cjkCount >= 4 && evidence.japaneseCount === 0)
            return 'Simplified Chinese';
        const rankedLatin = (Object.entries(evidence.scores) as Array<[
            'English' | 'French' | 'Italian',
            number
        ]>)
            .sort((a, b) => b[1] - a[1]);
        const [bestLanguage, bestScore] = rankedLatin[0];
        const secondScore = rankedLatin[1]?.[1] || 0;
        if (evidence.latinWordCount >= 4 && bestScore >= 3 && bestScore >= secondScore + 1) {
            return bestLanguage;
        }
        return null;
    }
    function normalizePersonalGlossaryTerm(term: GlossaryTerm): GlossaryTerm {
        return {
            ...term,
            source: String(term.source || '').trim(),
            target: String(term.target || '').trim(),
            direction: term.direction || (term.sourceLang && term.targetLang ? languagePairForLangs(term.sourceLang, term.targetLang) : 'bidirectional')
        };
    }
    function normalizePersonalGlossary(terms: GlossaryTerm[]): GlossaryTerm[] {
        return terms
            .map(normalizePersonalGlossaryTerm)
            .filter(term => term.source && term.target);
    }
    function getPersonalGlossary(clientId?: string): GlossaryTerm[] {
        const normalized = normalizePersonalGlossary(db.getGlossary(clientId));
        db.saveGlossary(normalized, clientId);
        return normalized;
    }
    function buildTranslationSettings(body: any, detectedSourceLang: SupportedLanguage = 'English') {
        const translationDomain = normalizeTranslationDomain(body?.translationDomain);
        const targetLang = normalizeLanguage(body?.targetLang, 'Simplified Chinese');
        const sourceLang = normalizeLanguage(body?.sourceLang, detectedSourceLang);
        const languagePair = languagePairForLangs(sourceLang, targetLang);
        const translationDirection = normalizeTranslationDirection(body?.translationDirection, sourceLang, targetLang);
        return {
            translationDirection,
            languagePair,
            translationDomain,
            sourceLang,
            targetLang,
            tone: body?.tone || defaultToneForTargetLanguage(targetLang),
            glossaryPreset: 'business'
        };
    }
    function rebuildProjectGlossary(project: Project, sourceLang: SupportedLanguage, targetLang: SupportedLanguage) {
        const rebuiltGlossary = buildLocalProjectGlossary(project.textItems || [], project.clientId, sourceLang, targetLang);
        project.glossary = rebuiltGlossary.initialGlossary;
        project.glossaryReviewCandidates = rebuiltGlossary.glossaryReviewCandidates;
        project.preDetectReport = rebuiltGlossary.preDetectReport || null;
        project.preDetectStatus = 'pending';
        project.preDetectError = undefined;
        project.glossaryLanguageVersion = PROJECT_GLOSSARY_LANGUAGE_VERSION;
    }
    function resetProjectForLanguageChange(project: Project, sourceLang: SupportedLanguage, targetLang: SupportedLanguage) {
        project.sourceLang = sourceLang;
        project.targetLang = targetLang;
        project.translationDirection = languagePairForLangs(sourceLang, targetLang);
        project.languagePair = languagePairForLangs(sourceLang, targetLang);
        project.tone = defaultToneForTargetLanguage(targetLang);
        project.glossaryPreset = defaultGlossaryPresetForDomain();
        project.translationDomain = 'business';
        project.translationMap = {};
        project.translationBySegmentId = {};
        project.sourceContainers = [];
        project.translationSegments = [];
        project.translatedFilePath = null;
        project.qaReport = null;
        project.glossaryValidationReport = null;
        project.generationProgress = undefined;
        for (const item of project.textItems || []) {
            item.translatedText = '';
            item.status = 'pending';
        }
        rebuildProjectGlossary(project, sourceLang, targetLang);
        project.status = 'uploaded';
        ensureProjectTranslationStructure(project);
    }
    function buildLocalProjectGlossary(textItems: ExtractedTextItem[], clientId?: string, sourceLang = 'English', targetLang = 'Simplified Chinese'): {
        preDetectReport: Project['preDetectReport'];
        initialGlossary: GlossaryTerm[];
        glossaryReviewCandidates: ProjectGlossaryReviewCandidate[];
    } {
        const globalLink = linkGlobalGlossaryToProject(textItems, db.getGlossary(clientId), sourceLang, targetLang);
        const initialGlossary = mergeProjectGlossaryTerms(globalLink.terms);
        const preDetectReport: Project['preDetectReport'] = {
            topic: 'Detecting terminology...',
            topic_keywords: [],
            description: 'AI terminology pre-detection is running in the background.',
            recommendedGlossary: glossaryToPreDetectTerms(initialGlossary)
        };
        return {
            preDetectReport,
            initialGlossary,
            glossaryReviewCandidates: globalLink.reviewCandidates
        };
    }
    function buildTranslationContextMap(project: Project, requestedTexts?: string[]): TranslationContextMap {
        const requestedSet = requestedTexts ? new Set(requestedTexts) : null;
        const contextMap: TranslationContextMap = {};
        const itemsBySlide = new Map<number, ExtractedTextItem[]>();
        const itemsByPart = new Map<string, ExtractedTextItem[]>();
        const normalizeContextText = (value: string | undefined): string => String(value || '').replace(/\s+/g, ' ').trim();
        const isSentenceLike = (text: string): boolean => /[.!?。！？；;]$/.test(text.trim());
        const isLikelyHeading = (text: string): boolean => {
            const clean = normalizeContextText(text);
            if (clean.length < 3 || clean.length > 120)
                return false;
            if (isSentenceLike(clean) && clean.length > 45)
                return false;
            return true;
        };
        for (const item of project.textItems) {
            if (!itemsBySlide.has(item.slideNum))
                itemsBySlide.set(item.slideNum, []);
            itemsBySlide.get(item.slideNum)!.push(item);
            const partKey = item.partPath || item.slidePath || `slide:${item.slideNum}`;
            if (!itemsByPart.has(partKey))
                itemsByPart.set(partKey, []);
            itemsByPart.get(partKey)!.push(item);
        }
        for (const list of [...itemsBySlide.values(), ...itemsByPart.values()]) {
            list.sort((a, b) => (a.pIdx ?? 0) - (b.pIdx ?? 0));
        }
        const slideTitleBySlide = new Map<number, string>();
        for (const [slideNum, slideItems] of itemsBySlide.entries()) {
            const titleCandidate = slideItems.find(item => item.partType !== 'diagram'
                && isLikelyHeading(item.originalText));
            if (titleCandidate) {
                slideTitleBySlide.set(slideNum, normalizeContextText(titleCandidate.originalText));
            }
        }
        const roleForItem = (item: ExtractedTextItem): string => {
            const partPath = String(item.partPath || item.slidePath || '').toLowerCase();
            const text = normalizeContextText(item.originalText);
            if (item.partType === 'diagram')
                return 'smartart_label';
            if (project.documentType === 'pdf') {
                return text.length <= 80 ? 'pdf_text_label' : 'pdf_paragraph';
            }
            if (project.documentType === 'xlsx') {
                return text.length <= 80 ? 'spreadsheet_cell_label' : 'spreadsheet_cell_text';
            }
            if (project.documentType === 'docx') {
                if (partPath.includes('/header'))
                    return 'header';
                if (partPath.includes('/footer'))
                    return 'footer';
                if (partPath.includes('/footnotes'))
                    return 'footnote';
                if (partPath.includes('/endnotes'))
                    return 'endnote';
                if (partPath.includes('/comments'))
                    return 'comment';
                if (isLikelyHeading(text))
                    return 'heading_or_label';
                return 'paragraph';
            }
            const slideTitle = slideTitleBySlide.get(item.slideNum);
            if (slideTitle && slideTitle === text)
                return 'slide_title';
            return text.length <= 80 ? 'shape_label' : 'body_text';
        };
        const locationLabelForItem = (item: ExtractedTextItem): string => {
            const partPath = String(item.partPath || item.slidePath || '');
            if (project.documentType === 'pptx') {
                return item.partType === 'diagram' ? `Slide ${item.slideNum} SmartArt` : `Slide ${item.slideNum}`;
            }
            if (project.documentType === 'pdf')
                return `PDF page ${item.slideNum || 1}`;
            if (project.documentType === 'xlsx')
                return `Excel sheet ${item.slideNum || 1}`;
            if (item.partType === 'diagram')
                return 'Word SmartArt';
            if (partPath.includes('/header'))
                return 'Word header';
            if (partPath.includes('/footer'))
                return 'Word footer';
            if (partPath.includes('/footnotes'))
                return 'Word footnote';
            if (partPath.includes('/endnotes'))
                return 'Word endnote';
            if (partPath.includes('/comments'))
                return 'Word comment';
            const pageMarker = item.slideNum > 0 ? `, page marker ${item.slideNum}` : '';
            return `Word paragraph ${(item.pIdx ?? 0) + 1}${pageMarker}`;
        };
        const containerTitleForItem = (item: ExtractedTextItem): string | undefined => {
            if (project.documentType === 'pptx') {
                const slideTitle = slideTitleBySlide.get(item.slideNum);
                return slideTitle && slideTitle !== normalizeContextText(item.originalText) ? slideTitle : undefined;
            }
            if (project.documentType === 'pdf')
                return undefined;
            if (project.documentType === 'xlsx')
                return undefined;
            const partKey = item.partPath || item.slidePath || `slide:${item.slideNum}`;
            const partItems = itemsByPart.get(partKey) || [];
            const currentIndex = partItems.findIndex(candidate => candidate.id === item.id);
            for (let index = currentIndex - 1; index >= 0 && index >= currentIndex - 12; index--) {
                const candidate = normalizeContextText(partItems[index]?.originalText);
                if (candidate && candidate !== normalizeContextText(item.originalText) && isLikelyHeading(candidate)) {
                    return candidate;
                }
            }
            return undefined;
        };
        const nearbyTextsForItem = (item: ExtractedTextItem): string[] => {
            const source = normalizeContextText(item.originalText);
            const group = project.documentType === 'pptx' || project.documentType === 'pdf' || project.documentType === 'xlsx'
                ? (itemsBySlide.get(item.slideNum) || [])
                : (itemsByPart.get(item.partPath || item.slidePath || `slide:${item.slideNum}`) || []);
            const currentIndex = group.findIndex(candidate => candidate.id === item.id);
            if (currentIndex < 0)
                return [];
            const nearby: string[] = [];
            const start = Math.max(0, currentIndex - 4);
            const end = Math.min(group.length - 1, currentIndex + 4);
            for (let index = start; index <= end; index++) {
                const candidate = group[index];
                if (!candidate || candidate.id === item.id)
                    continue;
                const text = normalizeContextText(candidate.originalText);
                if (!text || text === source || nearby.includes(text))
                    continue;
                nearby.push(text);
                if (nearby.length >= 6)
                    break;
            }
            return nearby;
        };
        for (const item of project.textItems) {
            const source = normalizeContextText(item.originalText);
            if (!source || (requestedSet && !requestedSet.has(source)))
                continue;
            if (!contextMap[source]) {
                contextMap[source] = {
                    documentType: project.documentType,
                    occurrences: []
                };
            }
            if (contextMap[source].occurrences.length >= 6)
                continue;
            contextMap[source].occurrences.push({
                locationLabel: locationLabelForItem(item),
                containerTitle: containerTitleForItem(item),
                nearbyTexts: nearbyTextsForItem(item),
                role: roleForItem(item)
            });
        }
        return contextMap;
    }
    function buildTranslationSegmentInputs(project: Project, requestedSegmentIds?: string[]): TranslationSegmentRequest[] {
        ensureProjectTranslationStructure(project);
        const segmentTermHints = refreshProjectSegmentTermHints(project);
        const requestedSet = requestedSegmentIds ? new Set(requestedSegmentIds) : null;
        const itemsBySlide = new Map<number, ExtractedTextItem[]>();
        const itemsByPart = new Map<string, ExtractedTextItem[]>();
        const normalizeContextText = (value: string | undefined): string => String(value || '').replace(/\s+/g, ' ').trim();
        const isSentenceLike = (text: string): boolean => /[.!?\u3002\uff01\uff1f\uff1b;]$/.test(text.trim());
        const isLikelyHeading = (text: string): boolean => {
            const clean = normalizeContextText(text);
            if (clean.length < 3 || clean.length > 120)
                return false;
            if (isSentenceLike(clean) && clean.length > 45)
                return false;
            return true;
        };
        for (const item of project.textItems || []) {
            if (!itemsBySlide.has(item.slideNum))
                itemsBySlide.set(item.slideNum, []);
            itemsBySlide.get(item.slideNum)!.push(item);
            const partKey = item.partPath || item.slidePath || `slide:${item.slideNum}`;
            if (!itemsByPart.has(partKey))
                itemsByPart.set(partKey, []);
            itemsByPart.get(partKey)!.push(item);
        }
        for (const list of [...itemsBySlide.values(), ...itemsByPart.values()]) {
            list.sort((a, b) => (a.pIdx ?? 0) - (b.pIdx ?? 0));
        }
        const slideTitleBySlide = new Map<number, string>();
        for (const [slideNum, slideItems] of itemsBySlide.entries()) {
            const titleCandidate = slideItems.find(item => item.partType !== 'diagram'
                && isLikelyHeading(item.originalText));
            if (titleCandidate) {
                slideTitleBySlide.set(slideNum, normalizeContextText(titleCandidate.originalText));
            }
        }
        const groupForItem = (item: ExtractedTextItem): ExtractedTextItem[] => {
            return project.documentType === 'pptx' || project.documentType === 'pdf' || project.documentType === 'xlsx'
                ? (itemsBySlide.get(item.slideNum) || [])
                : (itemsByPart.get(item.partPath || item.slidePath || `slide:${item.slideNum}`) || []);
        };
        const roleForItem = (item: ExtractedTextItem): string => {
            const partPath = String(item.partPath || item.slidePath || '').toLowerCase();
            const text = normalizeContextText(item.originalText);
            if (item.partType === 'diagram')
                return 'smartart_label';
            if (project.documentType === 'pdf')
                return text.length <= 80 ? 'pdf_text_label' : 'pdf_paragraph';
            if (project.documentType === 'xlsx')
                return text.length <= 80 ? 'spreadsheet_cell_label' : 'spreadsheet_cell_text';
            if (project.documentType === 'docx') {
                if (partPath.includes('/header'))
                    return 'header';
                if (partPath.includes('/footer'))
                    return 'footer';
                if (partPath.includes('/footnotes'))
                    return 'footnote';
                if (partPath.includes('/endnotes'))
                    return 'endnote';
                if (partPath.includes('/comments'))
                    return 'comment';
                if (isLikelyHeading(text))
                    return 'heading_or_label';
                return 'paragraph';
            }
            const slideTitle = slideTitleBySlide.get(item.slideNum);
            if (slideTitle && slideTitle === text)
                return 'slide_title';
            return text.length <= 80 ? 'shape_label' : 'body_text';
        };
        const locationLabelForItem = (item: ExtractedTextItem): string => {
            const partPath = String(item.partPath || item.slidePath || '');
            if (project.documentType === 'pptx')
                return item.partType === 'diagram' ? `Slide ${item.slideNum} SmartArt` : `Slide ${item.slideNum}`;
            if (project.documentType === 'pdf')
                return `PDF page ${item.slideNum || 1}`;
            if (project.documentType === 'xlsx')
                return `Excel sheet ${item.slideNum || 1}`;
            if (item.partType === 'diagram')
                return 'Word SmartArt';
            if (partPath.includes('/header'))
                return 'Word header';
            if (partPath.includes('/footer'))
                return 'Word footer';
            if (partPath.includes('/footnotes'))
                return 'Word footnote';
            if (partPath.includes('/endnotes'))
                return 'Word endnote';
            if (partPath.includes('/comments'))
                return 'Word comment';
            const pageMarker = item.slideNum > 0 ? `, page marker ${item.slideNum}` : '';
            return `Word paragraph ${(item.pIdx ?? 0) + 1}${pageMarker}`;
        };
        const containerTitleForItem = (item: ExtractedTextItem): string | undefined => {
            if (project.documentType === 'pptx') {
                const slideTitle = slideTitleBySlide.get(item.slideNum);
                return slideTitle && slideTitle !== normalizeContextText(item.originalText) ? slideTitle : undefined;
            }
            if (project.documentType === 'pdf' || project.documentType === 'xlsx')
                return undefined;
            const partItems = itemsByPart.get(item.partPath || item.slidePath || `slide:${item.slideNum}`) || [];
            const currentIndex = partItems.findIndex(candidate => candidate.id === item.id);
            for (let index = currentIndex - 1; index >= 0 && index >= currentIndex - 12; index--) {
                const candidate = normalizeContextText(partItems[index]?.originalText);
                if (candidate && candidate !== normalizeContextText(item.originalText) && isLikelyHeading(candidate)) {
                    return candidate;
                }
            }
            return undefined;
        };
        const nearbyTextsForItem = (item: ExtractedTextItem): string[] => {
            const source = normalizeContextText(item.originalText);
            const group = groupForItem(item);
            const currentIndex = group.findIndex(candidate => candidate.id === item.id);
            if (currentIndex < 0)
                return [];
            const nearby: string[] = [];
            const start = Math.max(0, currentIndex - 4);
            const end = Math.min(group.length - 1, currentIndex + 4);
            for (let index = start; index <= end; index++) {
                const candidate = group[index];
                if (!candidate || candidate.id === item.id)
                    continue;
                const text = normalizeContextText(candidate.originalText);
                if (!text || text === source || nearby.includes(text))
                    continue;
                nearby.push(text);
                if (nearby.length >= 6)
                    break;
            }
            return nearby;
        };
        const segmentMap = new Map((project.translationSegments || []).map(segment => [segment.segmentId, segment]));
        const inputs: TranslationSegmentRequest[] = [];
        for (const item of project.textItems || []) {
            const segmentId = getItemSegmentId(project, item);
            if (requestedSet && !requestedSet.has(segmentId))
                continue;
            const sourceText = normalizeContextText(item.originalText);
            if (!sourceText)
                continue;
            const group = groupForItem(item);
            const currentIndex = group.findIndex(candidate => candidate.id === item.id);
            const previousSegmentText = currentIndex > 0 ? normalizeContextText(group[currentIndex - 1]?.originalText) : undefined;
            const nextSegmentText = currentIndex >= 0 && currentIndex < group.length - 1 ? normalizeContextText(group[currentIndex + 1]?.originalText) : undefined;
            const locationLabel = locationLabelForItem(item);
            const containerTitle = containerTitleForItem(item);
            const nearbyTexts = nearbyTextsForItem(item);
            const role = roleForItem(item);
            const occurrence = {
                locationLabel,
                containerTitle,
                nearbyTexts,
                role,
                previousSegmentText,
                nextSegmentText
            };
            const segment = segmentMap.get(segmentId);
            if (segment) {
                segment.location = {
                    ...segment.location,
                    locationLabel,
                    slideNumber: item.slideNum,
                    paragraphIndex: item.pIdx,
                    partName: item.partPath || item.slidePath
                };
                segment.context = {
                    containerTitle,
                    nearbyTexts,
                    role,
                    previousSegmentText,
                    nextSegmentText
                };
                segment.termHints = segmentTermHints[segmentId] || [];
            }
            inputs.push({
                segmentId,
                sourceText: item.originalText,
                context: {
                    documentType: project.documentType,
                    occurrences: [occurrence]
                },
                termHints: segmentTermHints[segmentId] || []
            });
        }
        return inputs;
    }
    async function runProjectPreDetection(projectId: string): Promise<void> {
        let project = db.getProject(projectId);
        if (!project)
            return;
        const startMs = Date.now();
        const sourceLang = project.sourceLang;
        const targetLang = project.targetLang;
        const translationDomain = project.translationDomain;
        const expectedContext = projectPreDetectionContext(project);
        project.preDetectStatus = 'running';
        project.preDetectError = undefined;
        db.saveProject(project);
        try {
            const uniqueStringsSet = new Set(project.textItems.map(item => item.originalText));
            const textSample = Array.from(uniqueStringsSet).filter(str => !project!.translationMap[str]);
            const rawReport = await runPreDetection(textSample, sourceLang, targetLang, translationDomain);
            const aiPreDetectReport: Project['preDetectReport'] = {
                topic: rawReport.topic_keywords?.join(', ') || 'Presentation Slides',
                topic_keywords: rawReport.topic_keywords || [],
                description: rawReport.description || 'Presentation slides with structured context.',
                recommendedGlossary: (rawReport.recommendedGlossary || []).map((term: any) => ({
                    source: term.source,
                    target: term.target,
                    category: term.category || term.description,
                    explanation: term.explanation || term.description,
                    origin: 'ai' as const,
                    status: 'active' as const,
                    checked: true,
                    sourceLang,
                    targetLang,
                    direction: languagePairForLangs(sourceLang, targetLang)
                }))
            };
            const aiGlossary: GlossaryTerm[] = aiPreDetectReport.recommendedGlossary
                .filter((t: any) => t.checked !== false)
                .map((t: any) => ({
                source: t.source,
                target: t.target,
                category: t.category,
                explanation: t.explanation,
                origin: 'ai' as const,
                status: 'active' as const,
                checked: true,
                sourceLang,
                targetLang,
                direction: languagePairForLangs(sourceLang, targetLang)
            }));
            project = db.getProject(projectId);
            if (!project)
                return;
            if (projectPreDetectionContext(project) !== expectedContext)
                return;
            let glossaryReviewCandidates = project.glossaryReviewCandidates || [];
            const decisions = glossaryReviewCandidates.length > 0
                ? await resolveGlossaryConflicts(glossaryReviewCandidates, aiPreDetectReport.topic || undefined)
                : [];
            project = db.getProject(projectId);
            if (!project)
                return;
            if (projectPreDetectionContext(project) !== expectedContext)
                return;
            const currentGlossary = project.glossary || [];
            glossaryReviewCandidates = project.glossaryReviewCandidates || glossaryReviewCandidates;
            if (decisions.length > 0) {
                for (const decision of decisions) {
                    const candidate = glossaryReviewCandidates.find(c => c.source.toLowerCase() === decision.source.toLowerCase());
                    if (!candidate)
                        continue;
                    candidate.selectedTarget = decision.selectedTarget;
                    candidate.confidence = decision.confidence;
                    candidate.reason = decision.reason;
                    candidate.status = decision.confidence >= 0.85 ? 'ai_selected' : 'needs_review';
                    for (const term of currentGlossary) {
                        if (term.source.toLowerCase() !== decision.source.toLowerCase())
                            continue;
                        term.confidence = decision.confidence;
                        term.reason = decision.reason;
                        if (term.target.toLowerCase() === decision.selectedTarget.toLowerCase()) {
                            term.status = decision.confidence >= 0.85 ? 'ai_selected' : 'needs_review';
                            term.checked = decision.confidence >= 0.85;
                        }
                        else {
                            term.status = 'candidate';
                            term.checked = false;
                        }
                    }
                }
            }
            const finalGlossary = mergeProjectGlossaryTerms(currentGlossary, aiGlossary);
            aiPreDetectReport.recommendedGlossary = glossaryToPreDetectTerms(finalGlossary);
            project.glossary = finalGlossary;
            project.glossaryReviewCandidates = glossaryReviewCandidates;
            project.preDetectReport = aiPreDetectReport;
            project.preDetectStatus = 'completed';
            project.preDetectError = undefined;
            db.saveProject(project);
        }
        catch (detectErr: any) {
            console.error('Failed to run background AI pre-detection:', detectErr);
            const latest = db.getProject(projectId);
            if (latest && projectPreDetectionContext(latest) === expectedContext) {
                latest.preDetectStatus = 'failed';
                latest.preDetectError = detectErr?.message || 'AI terminology pre-detection failed.';
                db.saveProject(latest);
            }
        }
    }
    const pendingPreDetectionReruns = new Set<string>();
    function queueProjectPreDetection(projectId: string): void {
        if (queuedPreDetections.has(projectId)) {
            pendingPreDetectionReruns.add(projectId);
            return;
        }
        queuedPreDetections.add(projectId);
        setTimeout(() => {
            runProjectPreDetection(projectId).catch(err => {
                console.error('Unhandled background pre-detection failure:', err);
            }).finally(() => {
                queuedPreDetections.delete(projectId);
                if (pendingPreDetectionReruns.delete(projectId)) {
                    queueProjectPreDetection(projectId);
                }
            });
        }, 0);
    }
    function recoverProjectBackgroundJobs(project: Project): Project {
        let changed = false;
        const hasLegacyUnscopedAiTerms = (project.glossary || []).some(term => term.origin === 'ai' && (!term.sourceLang || !term.targetLang));
        const needsGlossaryLanguageMigration = project.glossaryLanguageVersion !== PROJECT_GLOSSARY_LANGUAGE_VERSION;
        if (needsGlossaryLanguageMigration || hasLegacyUnscopedAiTerms) {
            rebuildProjectGlossary(project, normalizeLanguage(project.sourceLang, 'English'), normalizeLanguage(project.targetLang, 'Simplified Chinese'));
            queueProjectPreDetection(project.id);
            changed = true;
        }
        if ((project.preDetectStatus === 'pending' || project.preDetectStatus === 'running') && !queuedPreDetections.has(project.id)) {
            project.preDetectStatus = 'pending';
            project.preDetectError = undefined;
            queueProjectPreDetection(project.id);
            changed = true;
        }
        if ((project.status === 'translating' || project.status === 'pausing') && !activeTranslationJobs.has(project.id)) {
            project.status = 'paused';
            project.errorMsg = undefined;
            project.translationProgress = {
                total: project.translationProgress?.total || project.textItems.length,
                completed: project.textItems.filter(item => Boolean(item.translatedText)).length,
                percent: project.translationProgress?.percent || 0,
                phase: 'paused',
                message: '翻译已暂停。'
            };
            changed = true;
        }
        if (changed) {
            db.saveProject(project);
        }
        return project;
    }
    const allProjects = db.getAllProjects();
    const clientIds = new Set(allProjects.map(project => project.clientId).filter((clientId): clientId is string => Boolean(clientId)));
    for (const clientId of clientIds) {
        const personalGlossary = db.getGlossary(clientId);
        let changed = false;
        const migratedGlossary = personalGlossary.map(term => {
            const inferredTargetLang = inferLegacyGlossaryTargetLanguage(term);
            const declaredTargetLang = normalizeLanguage(term.targetLang, 'Simplified Chinese');
            if (!inferredTargetLang || inferredTargetLang === declaredTargetLang)
                return term;
            changed = true;
            const sourceLang = normalizeLanguage(term.sourceLang, 'English');
            return {
                ...term,
                sourceLang,
                targetLang: inferredTargetLang,
                direction: languagePairForLangs(sourceLang, inferredTargetLang)
            };
        });
        if (changed)
            db.saveGlossary(migratedGlossary, clientId);
    }
    for (const project of allProjects) {
        if (project.glossaryLanguageVersion === PROJECT_GLOSSARY_LANGUAGE_VERSION)
            continue;
        rebuildProjectGlossary(project, normalizeLanguage(project.sourceLang, 'English'), normalizeLanguage(project.targetLang, 'Simplified Chinese'));
        db.saveProject(project);
    }
    // Local project APIs
    app.get('/api/projects', (req, res) => {
        try {
            const clientId = getClientId(req);
            const projects = db.getProjects(clientId).map(project => recoverProjectBackgroundJobs(project));
            const summaries = projects.map(({ textItems, translationMap, sourceContainers, translationSegments, translationBySegmentId, ...rest }) => rest);
            res.json(summaries);
        }
        catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });
    // API: Get single project details (including texts)
    app.get('/api/projects/:id', (req, res) => {
        try {
            const project = db.getProject(req.params.id);
            if (!project) {
                return res.status(404).json({ error: 'Project not found' });
            }
            const clientId = getClientId(req);
            if (project.clientId && project.clientId !== clientId) {
                return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
            }
            res.json(recoverProjectBackgroundJobs(project));
        }
        catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });
    // API: Upload Office file
    app.post('/api/projects/upload', upload.single('file'), async (req, res) => {
        const uploadStartMs = Date.now();
        const clientId = getClientId(req);
        let uploadDocumentType: 'pptx' | 'docx' | 'pdf' | 'xlsx' | undefined;
        let uploadFileSizeBytes = 0;
        try {
            if (!req.file) {
                return res.status(400).json({ error: 'No file uploaded' });
            }
            const filePath = req.file.path;
            const originalCacheKey = req.body.originalCacheKey || null;
            const originalName = resolveUploadedFileName({
                explicitName: req.body.originalName,
                multerName: req.file.originalname,
                cacheKey: originalCacheKey
            });
            uploadFileSizeBytes = req.file.size;
            uploadDocumentType = getDocumentTypeFromName(originalName);
            if (!uploadDocumentType) {
                fs.unlinkSync(filePath);
                return res.status(400).json({ error: 'Unsupported file type. Please upload a .pptx, .docx, or .xlsx file.' });
            }
            // Read Office package & extract visible text
            const buffer = fs.readFileSync(filePath);
            let stats: OfficeStats;
            try {
                stats = await extractOfficeText(buffer, uploadDocumentType);
            }
            catch (extractErr: any) {
                fs.unlinkSync(filePath);
                return res.status(400).json({ error: `Failed to extract ${uploadDocumentType.toUpperCase()} text. Please verify file integrity.` });
            }
            // Compute statistics
            const allOriginalTexts: string[] = stats.paragraphs.map((p: any) => p.originalText);
            const uniqueStringsSet = new Set<string>(allOriginalTexts);
            const uniqueCount = uniqueStringsSet.size;
            const totalCount = allOriginalTexts.length;
            const repeatedCount = totalCount - uniqueCount;
            const textItems = buildTextItemsFromStats(stats);
            const requestedTargetLang = normalizeLanguage(req.body?.targetLang, 'Simplified Chinese');
            const detectedSourceLang = detectSourceLanguageFromTexts(allOriginalTexts, requestedTargetLang, originalName);
            const translationSettings = buildTranslationSettings({ ...req.body, targetLang: requestedTargetLang }, detectedSourceLang);
            // Pre-fill from Translation Memory
            const tm = db.getTranslationMemory(clientId);
            const translationMap: Record<string, string> = {};
            for (const str of Array.from(uniqueStringsSet)) {
                const strKey = str as string;
                if (tm[strKey]) {
                    translationMap[strKey] = tm[strKey];
                }
            }
            // Update textItems statuses if TM exists
            for (const item of textItems) {
                if (translationMap[item.originalText]) {
                    item.translatedText = translationMap[item.originalText];
                    item.status = 'translated';
                }
            }
            const { preDetectReport, initialGlossary, glossaryReviewCandidates } = buildLocalProjectGlossary(textItems, clientId, translationSettings.sourceLang, translationSettings.targetLang);
            // Create Project
            const projectId = `proj_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
            const fileSizeBytes = req.file.size;
            const fileSize = parseFloat((fileSizeBytes / (1024 * 1024)).toFixed(2));
            const estimatedChars = allOriginalTexts.reduce((acc, str) => acc + (str || '').length, 0);
            const project: Project = {
                id: projectId,
                clientId,
                originalName,
                documentType: uploadDocumentType,
                uploadTime: new Date().toISOString(),
                slideCount: stats.slideCount,
                uniqueCount,
                repeatedCount,
                mediaCount: stats.mediaCount,
                fileSize,
                fileSizeBytes,
                estimatedChars,
                originalFilePath: filePath,
                translatedFilePath: null,
                originalCacheKey: originalCacheKey || undefined,
                sourceLang: translationSettings.sourceLang,
                targetLang: translationSettings.targetLang,
                translationDirection: translationSettings.translationDirection,
                languagePair: translationSettings.languagePair,
                translationDomain: translationSettings.translationDomain,
                tone: translationSettings.tone,
                glossaryPreset: translationSettings.glossaryPreset,
                status: 'uploaded',
                textItems,
                translationMap,
                qaReport: null,
                glossary: initialGlossary,
                glossaryLanguageVersion: PROJECT_GLOSSARY_LANGUAGE_VERSION,
                glossaryReviewCandidates,
                preDetectStatus: 'pending',
                preDetectReport
            };
            ensureProjectTranslationStructure(project);
            db.saveProject(project);
            queueProjectPreDetection(project.id);
            res.json({
                id: project.id,
                originalName: project.originalName,
                documentType: project.documentType,
                uploadTime: project.uploadTime,
                slideCount: project.slideCount,
                uniqueCount: project.uniqueCount,
                repeatedCount: project.repeatedCount,
                mediaCount: project.mediaCount,
                fileSize: project.fileSize,
                fileSizeBytes: project.fileSizeBytes,
                estimatedChars: project.estimatedChars,
                sourceLang: project.sourceLang,
                targetLang: project.targetLang,
                translationDirection: project.translationDirection,
                languagePair: project.languagePair,
                translationDomain: project.translationDomain,
                tone: project.tone,
                glossaryPreset: project.glossaryPreset,
                status: project.status,
                originalCacheKey: project.originalCacheKey,
                preDetectStatus: project.preDetectStatus,
                preDetectError: project.preDetectError,
                preDetectReport: project.preDetectReport,
                glossary: project.glossary,
                glossaryReviewCandidates: project.glossaryReviewCandidates
            });
        }
        catch (err: any) {
            console.error(err);
            res.status(500).json({ error: err.message });
        }
    });
    // API: Initialize Demo presentation project
    app.post('/api/projects/demo', (req, res) => {
        try {
            const projectId = `proj_demo_${Date.now()}`;
            const clientId = getClientId(req);
            const textItems: ExtractedTextItem[] = [
                { id: '1_0', slideNum: 1, originalText: 'Introduction to Artificial Intelligence', translatedText: '', status: 'pending' },
                { id: '1_1', slideNum: 1, originalText: 'A high-level overview of deep learning and model orchestration.', translatedText: '', status: 'pending' },
                { id: '2_0', slideNum: 2, originalText: 'What is a Large Language Model?', translatedText: '', status: 'pending' },
                { id: '2_1', slideNum: 2, originalText: 'LLMs are trained on massive datasets to predict the next word.', translatedText: '', status: 'pending' },
                { id: '2_2', slideNum: 2, originalText: 'Popular examples include Gemini, GPT, and Claude.', translatedText: '', status: 'pending' },
                { id: '3_0', slideNum: 3, originalText: 'Best Practices for Corporate PPT Translation', translatedText: '', status: 'pending' },
                { id: '3_1', slideNum: 3, originalText: 'Maintain visual formatting and layout integrity.', translatedText: '', status: 'pending' },
                { id: '3_2', slideNum: 3, originalText: 'Use corporate glossary databases to ensure term consistency.', translatedText: '', status: 'pending' }
            ];
            const recommendedGlossary = [
                { source: 'Artificial Intelligence', target: '\u4eba\u5de5\u667a\u80fd', category: 'Industry Domain', explanation: 'Core AI terminology', checked: true },
                { source: 'Deep Learning', target: '\u6df1\u5ea6\u5b66\u4e60', category: 'Industry Domain', explanation: 'Machine learning method based on neural networks', checked: true },
                { source: 'Model Orchestration', target: '模型编排', category: 'Industry Domain', explanation: 'Coordinating multiple AI models or model calls in a workflow', checked: true },
                { source: 'Large Language Model', target: '大语言模型', category: 'Industry Domain', explanation: 'LLM = Large Language Model', checked: true }
            ];
            const project: Project = {
                id: projectId,
                clientId,
                originalName: 'Presentation-2024.pptx',
                documentType: 'pptx',
                uploadTime: new Date().toISOString(),
                slideCount: 18,
                uniqueCount: 8,
                repeatedCount: 0,
                mediaCount: 2,
                fileSize: 4.52,
                fileSizeBytes: Math.round(4.52 * 1024 * 1024),
                estimatedChars: 8420,
                originalFilePath: '',
                translatedFilePath: null,
                sourceLang: 'English',
                targetLang: 'Simplified Chinese',
                translationDirection: 'en-zh',
                languagePair: 'English-Simplified Chinese',
                translationDomain: 'business',
                tone: 'professional training/business Chinese',
                glossaryPreset: 'business',
                status: 'uploaded',
                textItems,
                translationMap: {},
                qaReport: null,
                glossary: recommendedGlossary.map(g => ({ source: g.source, target: g.target, category: g.category, explanation: g.explanation })),
                glossaryLanguageVersion: PROJECT_GLOSSARY_LANGUAGE_VERSION,
                preDetectReport: {
                    topic: 'Artificial Intelligence & Deep Learning',
                    topic_keywords: ['Artificial Intelligence', 'Deep Learning'],
                    description: 'This presentation covers a high level introduction to Large Language Models and deep learning pipelines. Tone should be professional and informative.',
                    recommendedGlossary
                }
            };
            ensureProjectTranslationStructure(project);
            db.saveProject(project);
            res.json({
                id: project.id,
                originalName: project.originalName,
                uploadTime: project.uploadTime,
                slideCount: project.slideCount,
                uniqueCount: project.uniqueCount,
                repeatedCount: project.repeatedCount,
                mediaCount: project.mediaCount,
                fileSize: project.fileSize,
                fileSizeBytes: project.fileSizeBytes,
                estimatedChars: project.estimatedChars,
                sourceLang: project.sourceLang,
                targetLang: project.targetLang,
                translationDirection: project.translationDirection,
                languagePair: project.languagePair,
                status: project.status,
                originalCacheKey: project.originalCacheKey,
                preDetectReport: project.preDetectReport,
                glossary: project.glossary
            });
        }
        catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });
    // Safe Index creator
    function p_idx_safe(idx: number, fallback: number): number {
        return isNaN(idx) ? fallback : idx;
    }
    function sourceHash(text: string): string {
        return crypto.createHash('sha1').update(text || '', 'utf8').digest('hex');
    }
    type OfficeDocumentType = 'pptx' | 'docx' | 'pdf' | 'xlsx';
    type OfficeStats = PPTXStats | DOCXStats | PDFStats | XLSXStats;
    function getDocumentTypeFromName(fileName: string): OfficeDocumentType | null {
        const ext = path.extname(fileName || '').toLowerCase();
        if (ext === '.docx')
            return 'docx';
        if (ext === '.pptx')
            return 'pptx';
        if (ext === '.xlsx')
            return 'xlsx';
        return null;
    }
    function getOutputLanguageSuffix(project: Project): 'zh-CN' | 'EN' | 'FR' | 'JA' | 'IT' | 'AR' {
        const target = String(project.targetLang || '').toLowerCase();
        if (target.includes('english'))
            return 'EN';
        if (target.includes('french'))
            return 'FR';
        if (target.includes('japanese'))
            return 'JA';
        if (target.includes('italian'))
            return 'IT';
        if (target.includes('arabic'))
            return 'AR';
        return 'zh-CN';
    }
    function getTranslatedDownloadName(project: Project, documentType: OfficeDocumentType): string {
        const originalName = project.originalName;
        const baseName = path.basename(originalName, path.extname(originalName));
        const extension = documentType === 'docx' ? 'docx' : (documentType === 'pdf' ? 'pdf' : (documentType === 'xlsx' ? 'xlsx' : 'pptx'));
        return `${baseName}.${getOutputLanguageSuffix(project)}.${extension}`;
    }
    async function extractOfficeText(buffer: Buffer, documentType: OfficeDocumentType): Promise<OfficeStats> {
        if (documentType === 'docx')
            return extractDOCXText(buffer);
        if (documentType === 'pdf')
            return extractPDFText(buffer);
        if (documentType === 'xlsx')
            return extractXLSXText(buffer);
        return extractPPTXText(buffer);
    }
    function buildTextItemsFromStats(stats: OfficeStats): ExtractedTextItem[] {
        return stats.paragraphs.map((p: any, idx: number) => {
            const pIdx = p_idx_safe(p.p_idx, idx);
            const partType = p.partType || 'slide';
            const partPath = p.partPath || p.slidePath;
            const partKey = partType === 'diagram' || partType === 'document' || partType === 'chart'
                ? `d${Buffer.from(partPath || '').toString('base64url').slice(0, 10)}`
                : 's';
            const id = `${p.slideNum}_${partKey}_${pIdx}`;
            return {
                id,
                slideNum: p.slideNum,
                slidePath: p.slidePath,
                partPath,
                partType,
                pIdx,
                sourceHash: sourceHash(p.originalText),
                originalText: p.originalText,
                translatedText: '',
                status: 'pending' as const
            };
        });
    }
    // API: Update custom project-specific glossary
    app.post('/api/projects/:id/glossary', (req, res) => {
        try {
            const project = db.getProject(req.params.id);
            if (!project) {
                return res.status(404).json({ error: 'Project not found' });
            }
            const clientId = getClientId(req);
            if (project.clientId && project.clientId !== clientId) {
                return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
            }
            const { glossary, preDetectReport } = req.body;
            if (glossary !== undefined) {
                project.glossary = normalizePersonalGlossary(glossary);
                project.effectiveGlossarySnapshot = undefined;
                project.segmentTermHints = undefined;
            }
            if (preDetectReport !== undefined) {
                project.preDetectReport = preDetectReport;
            }
            db.saveProject(project);
            res.json(project);
        }
        catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });
    // Select multiple reusable glossary libraries for a project. The selected
    // rows are flattened into the project's immutable effective snapshot at the
    // start of translation; the libraries themselves remain reusable assets.
    app.post('/api/projects/:id/glossaries/select', (req, res) => {
        try {
            const project = db.getProject(req.params.id);
            if (!project)
                return res.status(404).json({ error: 'Project not found' });
            const clientId = getClientId(req);
            if (project.clientId && project.clientId !== clientId) {
                return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
            }
            const requestedIds = Array.isArray(req.body?.libraryIds)
                ? req.body.libraryIds.map((id: unknown) => String(id)).filter(Boolean)
                : [];
            const libraries = db.getGlossaryLibraries(clientId);
            const byId = new Map(libraries.map(library => [library.id, library]));
            const selected = requestedIds.map(id => byId.get(id)).filter((library): library is GlossaryLibrary => Boolean(library));
            if (requestedIds.length !== selected.length) {
                return res.status(400).json({ error: 'One or more glossary libraries are invalid or unavailable.' });
            }
            const orderedIds = selected.map(library => library.id);
            const selectedTerms = selected.flatMap(library => orientGlossaryForLanguagePair(library.terms.map(term => ({
                ...term,
                sourceLang: term.sourceLang || library.sourceLang,
                targetLang: term.targetLang || library.targetLang
            })), project.sourceLang, project.targetLang)
                .map(term => ({ ...term, libraryId: library.id, libraryName: library.name })));
            project.selectedGlossaryLibraryIds = orderedIds;
            project.glossaryLibraryOrder = orderedIds;
            const projectOwnedTerms = (project.glossary || []).filter(term => !term.libraryId);
            project.glossary = mergeProjectGlossaryTerms(selectedTerms, projectOwnedTerms);
            project.effectiveGlossarySnapshot = undefined;
            project.segmentTermHints = undefined;
            db.saveProject(project);
            res.json({ success: true, project, selectedLibraries: selected.map(library => ({
                    id: library.id,
                    name: library.name,
                    scope: library.scope,
                    priority: library.priority,
                    termCount: library.terms.length
                })) });
        }
        catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });
    // Save project-scoped conflict decisions. These decisions affect only this
    // project and never rewrite a reusable glossary library.
    app.post('/api/projects/:id/glossary-conflicts', (req, res) => {
        try {
            const project = db.getProject(req.params.id);
            if (!project)
                return res.status(404).json({ error: 'Project not found' });
            const clientId = getClientId(req);
            if (project.clientId && project.clientId !== clientId) {
                return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
            }
            const decisions = req.body?.decisions;
            if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions)) {
                return res.status(400).json({ error: 'decisions must be an object keyed by source term.' });
            }
            const acceptedModes = new Set(['strict', 'candidate', 'skipped']);
            const acceptedScopes = new Set(['segment', 'page', 'context', 'project']);
            const nextDecisions = { ...(project.glossaryConflictDecisions || {}) };
            for (const [source, raw] of Object.entries(decisions as Record<string, any>)) {
                if (!raw || !acceptedModes.has(raw.mode) || !acceptedScopes.has(raw.scope))
                    continue;
                const normalizedSource = String(raw.source || source).trim().toLowerCase();
                const segmentId = raw.scope === 'segment' && raw.segmentId ? String(raw.segmentId) : undefined;
                const decisionKey = segmentId ? `${normalizedSource}::segment:${segmentId}` : normalizedSource;
                nextDecisions[decisionKey] = {
                    source: String(raw.source || source).trim(),
                    segmentId,
                    target: raw.target ? String(raw.target).trim() : undefined,
                    mode: raw.mode,
                    scope: raw.scope,
                    note: raw.note ? String(raw.note).trim() : undefined,
                    updatedAt: new Date().toISOString()
                };
            }
            project.glossaryConflictDecisions = nextDecisions;
            project.segmentTermHints = undefined;
            project.effectiveGlossarySnapshot = undefined;
            db.saveProject(project);
            res.json({ success: true, glossaryConflictDecisions: nextDecisions, project });
        }
        catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });
    app.post('/api/projects/:id/glossary/import-preview', upload.single('file'), async (req, res) => {
        try {
            const project = db.getProject(req.params.id);
            if (!project) {
                return res.status(404).json({ error: 'Project not found' });
            }
            const clientId = getClientId(req);
            if (project.clientId && project.clientId !== clientId) {
                return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
            }
            if (!req.file) {
                return res.status(400).json({ error: 'No glossary file uploaded' });
            }
            const parsed = await parseGlossaryFile(req.file.path, req.file.originalname);
            fs.unlinkSync(req.file.path);
            const baselineGlossary = project.glossary && project.glossary.length > 0 ? project.glossary : db.getGlossary(project.clientId);
            res.json(buildGlossaryImportPreview(parsed.terms, baselineGlossary, parsed.skippedRows));
        }
        catch (err: any) {
            if (req.file?.path && fs.existsSync(req.file.path))
                fs.unlinkSync(req.file.path);
            res.status(500).json({ error: err.message });
        }
    });
    app.post('/api/projects/:id/glossary/import-apply', (req, res) => {
        try {
            const project = db.getProject(req.params.id);
            if (!project) {
                return res.status(404).json({ error: 'Project not found' });
            }
            const clientId = getClientId(req);
            if (project.clientId && project.clientId !== clientId) {
                return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
            }
            const { terms, conflictStrategy = 'skip' } = req.body;
            if (!Array.isArray(terms)) {
                return res.status(400).json({ error: 'terms must be an array' });
            }
            const baselineGlossary = project.glossary && project.glossary.length > 0 ? project.glossary : db.getGlossary(project.clientId);
            project.glossary = mergeGlossaryTerms(baselineGlossary, terms, conflictStrategy === 'overwrite' ? 'overwrite' : 'skip');
            project.effectiveGlossarySnapshot = undefined;
            project.segmentTermHints = undefined;
            db.saveProject(project);
            res.json({ success: true, project });
        }
        catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });
    app.post('/api/projects/:id/glossary/validate', (req, res) => {
        try {
            const project = db.getProject(req.params.id);
            if (!project) {
                return res.status(404).json({ error: 'Project not found' });
            }
            const clientId = getClientId(req);
            if (project.clientId && project.clientId !== clientId) {
                return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
            }
            const activeGlossary = project.glossary && project.glossary.length > 0 ? project.glossary : db.getGlossary(project.clientId);
            const report = validateGlossaryUsage(project.textItems, activeGlossary);
            project.glossaryValidationReport = report;
            for (const finding of report.findings) {
                if (finding.status === 'GLOSSARY_MISS') {
                    const item = project.textItems.find(t => t.id === finding.itemId);
                    if (item && item.status !== 'edited')
                        item.status = 'warning';
                }
            }
            db.saveProject(project);
            res.json({ success: true, report, project });
        }
        catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });
    app.post('/api/projects/:id/rescan-text', async (req, res) => {
        try {
            const project = db.getProject(req.params.id);
            if (!project) {
                return res.status(404).json({ error: 'Project not found' });
            }
            const clientId = getClientId(req);
            if (project.clientId && project.clientId !== clientId) {
                return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
            }
            if (!project.originalFilePath || !fs.existsSync(project.originalFilePath)) {
                return res.status(404).json({ error: 'Original file not found.' });
            }
            const existingByAnchor = new Map<string, ExtractedTextItem>();
            const existingByText = new Map<string, ExtractedTextItem>();
            for (const item of project.textItems) {
                const anchor = `${item.partPath || item.slidePath || ''}::${item.pIdx ?? ''}::${item.originalText}`;
                existingByAnchor.set(anchor, item);
                existingByText.set(item.originalText, item);
            }
            const buffer = fs.readFileSync(project.originalFilePath);
            const documentType = project.documentType || getDocumentTypeFromName(project.originalName) || 'pptx';
            const stats = await extractOfficeText(buffer, documentType);
            const textItems: ExtractedTextItem[] = buildTextItemsFromStats(stats).map((item) => {
                const existing = existingByAnchor.get(`${item.partPath || item.slidePath || ''}::${item.pIdx ?? ''}::${item.originalText}`)
                    || existingByText.get(item.originalText);
                return {
                    ...item,
                    translatedText: existing?.translatedText || '',
                    status: existing?.status || 'pending'
                };
            });
            const allOriginalTexts = stats.paragraphs.map((p: any) => p.originalText);
            const uniqueStringsSet = new Set<string>(allOriginalTexts);
            project.slideCount = stats.slideCount;
            project.documentType = documentType;
            project.mediaCount = stats.mediaCount;
            project.uniqueCount = uniqueStringsSet.size;
            project.repeatedCount = allOriginalTexts.length - uniqueStringsSet.size;
            project.estimatedChars = allOriginalTexts.reduce((acc, str) => acc + (str || '').length, 0);
            project.textItems = textItems;
            project.translationMap = {};
            for (const item of textItems) {
                if (item.translatedText) {
                    project.translationMap[item.originalText] = item.translatedText;
                }
            }
            const rebuiltGlossary = buildLocalProjectGlossary(textItems, project.clientId, project.sourceLang, project.targetLang);
            project.glossary = mergeProjectGlossaryTerms(rebuiltGlossary.initialGlossary, project.glossary || []);
            project.glossaryReviewCandidates = rebuiltGlossary.glossaryReviewCandidates;
            project.preDetectReport = rebuiltGlossary.preDetectReport || project.preDetectReport;
            project.preDetectStatus = 'pending';
            project.preDetectError = undefined;
            project.status = textItems.some(item => !item.translatedText) ? 'uploaded' : project.status;
            project.sourceContainers = [];
            project.translationSegments = [];
            project.translationBySegmentId = {};
            ensureProjectTranslationStructure(project);
            db.saveProject(project);
            queueProjectPreDetection(project.id);
            res.json({ success: true, project });
        }
        catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });
    app.patch('/api/projects/:id/language', async (req, res) => {
        try {
            const project = db.getProject(req.params.id);
            if (!project) {
                return res.status(404).json({ error: 'Project not found' });
            }
            const clientId = getClientId(req);
            if (project.clientId && project.clientId !== clientId) {
                return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
            }
            if (activeTranslationJobs.has(project.id) || project.status === 'translating') {
                return res.status(409).json({ error: 'This project is still translating. Please wait until the current translation finishes before changing the target language.' });
            }
            const targetLang = normalizeLanguage(req.body?.targetLang, project.targetLang as SupportedLanguage || 'Simplified Chinese');
            const forceRedetect = req.body?.forceRedetect === true;
            const detectedSourceLang = detectSourceLanguageFromTexts((project.textItems || []).map(item => item.originalText), targetLang, project.originalName);
            const sourceLang = normalizeLanguage(req.body?.sourceLang, detectedSourceLang);
            const nextPair = languagePairForLangs(sourceLang, targetLang);
            const currentPair = languagePairForLangs(project.sourceLang || 'English', project.targetLang || 'Simplified Chinese');
            if (nextPair !== currentPair) {
                resetProjectForLanguageChange(project, sourceLang, targetLang);
                db.saveProject(project);
                queueProjectPreDetection(project.id);
            }
            else if (forceRedetect) {
                project.sourceLang = sourceLang;
                project.targetLang = targetLang;
                project.translationDirection = nextPair;
                project.languagePair = nextPair;
                project.tone = defaultToneForTargetLanguage(targetLang);
                rebuildProjectGlossary(project, sourceLang, targetLang);
                db.saveProject(project);
                queueProjectPreDetection(project.id);
            }
            else {
                project.sourceLang = sourceLang;
                project.targetLang = targetLang;
                project.translationDirection = nextPair;
                project.languagePair = nextPair;
                project.tone = defaultToneForTargetLanguage(targetLang);
                db.saveProject(project);
            }
            res.json(project);
        }
        catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });
    app.post('/api/projects/:id/translation/pause', (req, res) => {
        try {
            const project = db.getProject(req.params.id);
            if (!project)
                return res.status(404).json({ error: 'Project not found' });
            const clientId = getClientId(req);
            if (project.clientId && project.clientId !== clientId) {
                return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
            }
            const control = translationJobControls.get(project.id);
            if (control) {
                control.pauseRequested = true;
                project.status = 'pausing';
                project.translationProgress = {
                    total: project.translationProgress?.total || project.textItems.length,
                    completed: project.textItems.filter(item => Boolean(item.translatedText)).length,
                    percent: project.translationProgress?.percent || 0,
                    phase: 'pausing',
                    message: '正在暂停，等待进行中的请求完成…'
                };
                db.saveProject(project);
                return res.json(project);
            }
            if (project.status === 'paused')
                return res.json(project);
            if (project.status === 'translating' || project.status === 'pausing') {
                project.status = 'paused';
                project.translationProgress = {
                    total: project.translationProgress?.total || project.textItems.length,
                    completed: project.textItems.filter(item => Boolean(item.translatedText)).length,
                    percent: project.translationProgress?.percent || 0,
                    phase: 'paused',
                    message: '翻译已暂停。'
                };
                db.saveProject(project);
                return res.json(project);
            }
            return res.status(409).json({ error: 'This project is not currently translating.' });
        }
        catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });
    // API: Request translation
    app.post('/api/projects/:id/translate', async (req, res) => {
        const translateStartMs = Date.now();
        const clientId = getClientId(req);
        try {
            const project = db.getProject(req.params.id);
            if (!project) {
                return res.status(404).json({ error: 'Project not found' });
            }
            if (project.clientId && project.clientId !== clientId) {
                return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
            }
            if (activeTranslationJobs.has(project.id)) {
                return res.status(409).json({ error: 'This project already has an active translation job.' });
            }
            activeTranslationJobs.add(project.id);
            const jobControl = { pauseRequested: false };
            translationJobControls.set(project.id, jobControl);
            const { sourceLang, targetLang, tone, glossaryPreset, translationDirection, translationDomain } = req.body;
            if (sourceLang)
                project.sourceLang = normalizeLanguage(sourceLang, 'English');
            if (targetLang)
                project.targetLang = normalizeLanguage(targetLang, 'Simplified Chinese');
            if (translationDirection)
                project.translationDirection = normalizeTranslationDirection(translationDirection, project.sourceLang, project.targetLang);
            project.languagePair = languagePairForLangs(project.sourceLang, project.targetLang);
            if (translationDomain)
                project.translationDomain = normalizeTranslationDomain(translationDomain);
            if (tone)
                project.tone = tone;
            if (glossaryPreset)
                project.glossaryPreset = glossaryPreset;
            ensureProjectTranslationStructure(project);
            project.status = 'translating';
            project.errorMsg = undefined;
            project.translationStartedAt = new Date().toISOString();
            project.translationCompletedAt = undefined;
            project.translationProgress = {
                total: project.textItems.length,
                completed: project.textItems.filter(item => Boolean(item.translatedText)).length,
                percent: 0,
                phase: 'preparing',
                message: '正在准备翻译任务...'
            };
            db.saveProject(project);
            // Use project-specific customized glossary if defined, otherwise fall back to system active directory
            const glossary = (project.glossary && project.glossary.length > 0)
                ? project.glossary
                : db.getGlossary(project.clientId);
            refreshProjectSegmentTermHints(project, glossary);
            // Extract occurrence-level segments that still need translation.
            const textItems = project.textItems;
            const isLikelyUntranslated = (source: string, translation?: string): boolean => {
                return isQaTranslationWarning(source, translation, glossary, project);
            };
            const segmentIdsToRequest: string[] = [];
            for (const item of textItems) {
                if (item.status === 'edited')
                    continue;
                const segmentId = getItemSegmentId(project, item);
                const currentTranslation = project.translationBySegmentId?.[segmentId] || item.translatedText;
                if (isLikelyUntranslated(item.originalText, currentTranslation)) {
                    segmentIdsToRequest.push(segmentId);
                    item.status = 'pending';
                }
            }
            project.translationProgress = {
                total: segmentIdsToRequest.length,
                completed: 0,
                percent: segmentIdsToRequest.length === 0 ? 100 : 0,
                phase: 'translating',
                message: '正在翻译正文...'
            };
            db.saveProject(project);
            // Trigger segment-level translation with progressive callback updating database in real time.
            const translatedBySegmentId = await translateSegments(buildTranslationSegmentInputs(project, segmentIdsToRequest), project.sourceLang, project.targetLang, project.tone, glossary, project.preDetectReport?.topic || undefined, (batchIndex, totalBatches, batchCount, newlyTranslated) => {
                applySegmentTranslations(project, newlyTranslated);
                // Calculate progress percentage dynamically
                const completedCount = segmentIdsToRequest.filter(segmentId => project.translationBySegmentId?.[segmentId]).length;
                project.translationProgress = {
                    total: segmentIdsToRequest.length,
                    completed: completedCount,
                    percent: Math.min(100, Math.round((completedCount / Math.max(1, segmentIdsToRequest.length)) * 100)),
                    phase: jobControl.pauseRequested ? 'pausing' : 'translating',
                    message: jobControl.pauseRequested ? '正在暂停，等待进行中的请求完成…' : '正在翻译正文...'
                };
                db.saveProject(project);
                console.log(`[REALTIME DB MATCH] Project ${project.id} translated ${completedCount}/${segmentIdsToRequest.length} segment(s) (${project.translationProgress.percent}%). Saved to DB cache.`);
            }, false, project.translationDomain, () => jobControl.pauseRequested);
            applySegmentTranslations(project, translatedBySegmentId);
            const finishPausedTranslation = () => {
                project.status = 'paused';
                const completed = project.textItems.filter(item => Boolean(item.translatedText)).length;
                const total = Math.max(project.textItems.length, 1);
                project.translationProgress = {
                    total: project.textItems.length,
                    completed,
                    percent: Math.min(99, Math.round((completed / total) * 100)),
                    phase: 'paused',
                    message: '翻译已暂停。'
                };
                db.saveProject(project);
                activeTranslationJobs.delete(project.id);
                translationJobControls.delete(project.id);
            };
            if (jobControl.pauseRequested) {
                finishPausedTranslation();
                return res.json(project);
            }
            project.translationProgress = {
                total: project.textItems.length,
                completed: project.textItems.filter(item => Boolean(item.translatedText)).length,
                percent: 100,
                phase: 'qa_checking',
                message: '正文翻译完成，正在执行质量检查...'
            };
            db.saveProject(project);
            const qaRetryCount = await retryQaWarningTranslationsOnce(project, glossary);
            if (qaRetryCount > 0) {
                console.log(`[QA AUTO RETRY] Project ${project.id} retranslated ${qaRetryCount} suspicious segment(s) after initial translation.`);
            }
            if (jobControl.pauseRequested) {
                finishPausedTranslation();
                return res.json(project);
            }
            project.translationProgress = {
                total: project.textItems.length,
                completed: project.textItems.filter(item => Boolean(item.translatedText)).length,
                percent: 100,
                phase: 'glossary_checking',
                message: '质量检查完成，正在检查术语一致性...'
            };
            db.saveProject(project);
            const glossaryRetryCount = await retryGlossaryMissTranslationsOnce(project, glossary);
            if (glossaryRetryCount > 0) {
                console.log(`[GLOSSARY AUTO RETRY] Project ${project.id} retranslated ${glossaryRetryCount} glossary miss unique text(s) after initial translation.`);
            }
            if (jobControl.pauseRequested) {
                finishPausedTranslation();
                return res.json(project);
            }
            const pendingBackfillCount = await backfillPendingTranslations(project, glossary, 3);
            if (pendingBackfillCount > 0) {
                console.log(`[PENDING BACKFILL] Project ${project.id} backfilled ${pendingBackfillCount} translation(s) after initial translation.`);
            }
            if (jobControl.pauseRequested) {
                finishPausedTranslation();
                return res.json(project);
            }
            project.translationProgress = {
                total: project.textItems.length,
                completed: project.textItems.filter(item => Boolean(item.translatedText)).length,
                percent: 100,
                phase: 'finalizing',
                message: '检查完成，正在保存最终结果...'
            };
            db.saveProject(project);
            finalizeTranslationStatus(project);
            db.saveProject(project);
            activeTranslationJobs.delete(project.id);
            translationJobControls.delete(project.id);
            res.json(project);
        }
        catch (err: any) {
            console.error('Translation error:', err);
            const jobControl = translationJobControls.get(req.params.id);
            activeTranslationJobs.delete(req.params.id);
            translationJobControls.delete(req.params.id);
            const failedProject = db.getProject(req.params.id);
            if (failedProject) {
                if (jobControl?.pauseRequested) {
                    failedProject.status = 'paused';
                    failedProject.errorMsg = undefined;
                    failedProject.translationProgress = {
                        total: failedProject.translationProgress?.total || failedProject.textItems.length,
                        completed: failedProject.textItems.filter(item => Boolean(item.translatedText)).length,
                        percent: failedProject.translationProgress?.percent || 0,
                        phase: 'paused',
                        message: '翻译已暂停。'
                    };
                    db.saveProject(failedProject);
                    return res.json(failedProject);
                }
                failedProject.status = 'failed';
                failedProject.errorMsg = err.message;
                db.saveProject(failedProject);
            }
            res.status(500).json({ error: err.message });
        }
    });
    // Precise word boundary mapping helper for glossary matching
    function isGlossaryTermMatch(text: string | null | undefined, term: string | null | undefined): boolean {
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
    // API: Request incremental retranslation based on updated glossary terms
    app.post('/api/projects/:id/retranslate', async (req, res) => {
        const retranslateStartMs = Date.now();
        const clientId = getClientId(req);
        try {
            const project = db.getProject(req.params.id);
            if (!project) {
                return res.status(404).json({ error: 'Project not found' });
            }
            if (project.clientId && project.clientId !== clientId) {
                return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
            }
            if (activeTranslationJobs.has(project.id)) {
                return res.status(409).json({ error: 'This project already has an active translation job.' });
            }
            activeTranslationJobs.add(project.id);
            const jobControl = { pauseRequested: false };
            translationJobControls.set(project.id, jobControl);
            const { changedKeys = [], overwriteEdited = false, forceFullRefresh = false } = req.body;
            ensureProjectTranslationStructure(project);
            if (!Array.isArray(changedKeys) || changedKeys.length === 0) {
                activeTranslationJobs.delete(project.id);
                translationJobControls.delete(project.id);
                return res.json(project);
            }
            const textItems = project.textItems || [];
            const affectedSegmentIds = new Set<string>();
            let usedNoMatchFallback = false;
            // Local scanning on backend for affected items
            for (const item of textItems) {
                const containsKey = forceFullRefresh || changedKeys.some((key: string) => isGlossaryTermMatch(item.originalText, key));
                if (containsKey) {
                    if (item.status === 'edited' && !overwriteEdited) {
                        continue; // Keep custom manual translation
                    }
                    affectedSegmentIds.add(getItemSegmentId(project, item));
                    item.status = 'pending';
                }
            }
            // PPT text is often split across shapes/runs, so a changed glossary term may not
            // appear as an exact standalone string in any extracted item. In that case, the
            // safest local behavior is to refresh all non-manually-edited translations.
            if (affectedSegmentIds.size === 0) {
                usedNoMatchFallback = true;
                for (const item of textItems) {
                    if (item.status === 'edited' && !overwriteEdited) {
                        continue;
                    }
                    affectedSegmentIds.add(getItemSegmentId(project, item));
                    item.status = 'pending';
                }
            }
            const segmentIdsToRequest = Array.from(affectedSegmentIds);
            console.log(`[INCREMENTAL RETRANSLATE] Project ${project.id}: changedKeys=${changedKeys.join(', ')} selected=${segmentIdsToRequest.length}/${textItems.length} forceFullRefresh=${forceFullRefresh} fallback=${usedNoMatchFallback}`);
            if (segmentIdsToRequest.length > 0) {
                clearSegmentTranslations(project, segmentIdsToRequest);
                project.status = 'translating';
                project.translationStartedAt = new Date().toISOString();
                project.translationCompletedAt = undefined;
                project.translationProgress = {
                    total: segmentIdsToRequest.length,
                    completed: 0,
                    percent: 0,
                    phase: 'translating',
                    message: '正在根据术语变更更新译文...'
                };
                project.translatedFilePath = null;
                project.qaReport = null;
                project.glossaryValidationReport = null;
                db.saveProject(project);
                const glossary = (project.glossary && project.glossary.length > 0)
                    ? project.glossary
                    : db.getGlossary(project.clientId);
                // Request retranslation with the new rules emphasized and isIncremental set to true
                const newlyTranslatedBySegmentId = await translateSegments(buildTranslationSegmentInputs(project, segmentIdsToRequest), project.sourceLang, project.targetLang, project.tone, glossary, project.preDetectReport?.topic || undefined, undefined, true, // isIncremental = true
                project.translationDomain, () => jobControl.pauseRequested);
                applySegmentTranslations(project, newlyTranslatedBySegmentId, !overwriteEdited);
                if (jobControl.pauseRequested) {
                    project.status = 'paused';
                    const completed = project.textItems.filter(item => Boolean(item.translatedText)).length;
                    project.translationProgress = {
                        total: project.textItems.length,
                        completed,
                        percent: Math.min(99, Math.round((completed / Math.max(project.textItems.length, 1)) * 100)),
                        phase: 'paused',
                        message: '翻译已暂停。'
                    };
                    db.saveProject(project);
                    activeTranslationJobs.delete(project.id);
                    translationJobControls.delete(project.id);
                    return res.json(project);
                }
                project.translationProgress = {
                    total: project.textItems.length,
                    completed: project.textItems.filter(item => Boolean(item.translatedText)).length,
                    percent: 100,
                    phase: 'glossary_checking',
                    message: '译文更新完成，正在检查术语一致性...'
                };
                db.saveProject(project);
                const glossaryRetryCount = await retryGlossaryMissTranslationsOnce(project, glossary);
                if (glossaryRetryCount > 0) {
                    console.log(`[GLOSSARY AUTO RETRY] Project ${project.id} retranslated ${glossaryRetryCount} glossary miss unique text(s) after incremental translation.`);
                }
                if (jobControl.pauseRequested) {
                    project.status = 'paused';
                    project.translationProgress = {
                        total: project.textItems.length,
                        completed: project.textItems.filter(item => Boolean(item.translatedText)).length,
                        percent: Math.min(99, project.translationProgress?.percent || 0),
                        phase: 'paused',
                        message: '翻译已暂停。'
                    };
                    db.saveProject(project);
                    activeTranslationJobs.delete(project.id);
                    translationJobControls.delete(project.id);
                    return res.json(project);
                }
                const pendingBackfillCount = await backfillPendingTranslations(project, glossary, 3);
                if (pendingBackfillCount > 0) {
                    console.log(`[PENDING BACKFILL] Project ${project.id} backfilled ${pendingBackfillCount} translation(s) after incremental translation.`);
                }
                if (jobControl.pauseRequested) {
                    project.status = 'paused';
                    project.translationProgress = {
                        total: project.textItems.length,
                        completed: project.textItems.filter(item => Boolean(item.translatedText)).length,
                        percent: Math.min(99, project.translationProgress?.percent || 0),
                        phase: 'paused',
                        message: '翻译已暂停。'
                    };
                    db.saveProject(project);
                    activeTranslationJobs.delete(project.id);
                    translationJobControls.delete(project.id);
                    return res.json(project);
                }
                project.translationProgress = {
                    total: project.textItems.length,
                    completed: project.textItems.filter(item => Boolean(item.translatedText)).length,
                    percent: 100,
                    phase: 'finalizing',
                    message: '检查完成，正在保存最终结果...'
                };
                db.saveProject(project);
            }
            finalizeTranslationStatus(project);
            db.saveProject(project);
            activeTranslationJobs.delete(project.id);
            translationJobControls.delete(project.id);
            res.json(project);
        }
        catch (err: any) {
            console.error('Incremental Translation API error:', err);
            const jobControl = translationJobControls.get(req.params.id);
            activeTranslationJobs.delete(req.params.id);
            translationJobControls.delete(req.params.id);
            const failedProject = db.getProject(req.params.id);
            if (failedProject) {
                if (jobControl?.pauseRequested) {
                    failedProject.status = 'paused';
                    failedProject.errorMsg = undefined;
                    failedProject.translationProgress = {
                        total: failedProject.textItems.length,
                        completed: failedProject.textItems.filter(item => Boolean(item.translatedText)).length,
                        percent: Math.min(99, failedProject.translationProgress?.percent || 0),
                        phase: 'paused',
                        message: '翻译已暂停。'
                    };
                    db.saveProject(failedProject);
                    return res.json(failedProject);
                }
                finalizeTranslationStatus(failedProject);
                db.saveProject(failedProject);
            }
            res.status(500).json({ error: err.message });
        }
    });
    // API: Update translations manually
    app.post('/api/projects/:id/items', (req, res) => {
        try {
            const project = db.getProject(req.params.id);
            if (!project) {
                return res.status(404).json({ error: 'Project not found' });
            }
            const clientId = getClientId(req);
            if (project.clientId && project.clientId !== clientId) {
                return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
            }
            const { originalText, translatedText, segmentId, itemId } = req.body;
            if (translatedText === undefined || (originalText === undefined && segmentId === undefined && itemId === undefined)) {
                return res.status(400).json({ error: 'translatedText and one of originalText, segmentId, or itemId are required' });
            }
            ensureProjectTranslationStructure(project);
            const targetItems = project.textItems.filter(item => {
                if (segmentId !== undefined)
                    return getItemSegmentId(project, item) === String(segmentId);
                if (itemId !== undefined)
                    return item.id === String(itemId);
                return item.originalText === originalText;
            });
            if (targetItems.length === 0) {
                return res.status(404).json({ error: 'No matching text item found' });
            }
            for (const item of targetItems) {
                const currentSegmentId = getItemSegmentId(project, item);
                const hasChanged = item.translatedText !== translatedText;
                project.translationBySegmentId![currentSegmentId] = translatedText;
                project.translationMap[item.originalText] = translatedText;
                item.translatedText = translatedText;
                if (hasChanged) {
                    item.status = 'edited';
                }
            }
            for (const segment of project.translationSegments || []) {
                const item = targetItems.find(candidate => getItemSegmentId(project, candidate) === segment.segmentId);
                if (!item)
                    continue;
                segment.translatedText = translatedText;
                segment.status = 'edited';
            }
            // Push to Translation Memory automatically to facilitate future reuse
            for (const item of targetItems) {
                db.setTM(item.originalText, translatedText, clientId);
            }
            project.translatedFilePath = null;
            project.qaReport = null;
            project.generationProgress = undefined;
            finalizeTranslationStatus(project);
            db.saveProject(project);
            res.json({ success: true, project });
        }
        catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });
    // API: Build / Generate PPTX
    app.post('/api/projects/:id/generate', async (req, res) => {
        const generateStartMs = Date.now();
        const clientId = getClientId(req);
        try {
            const project = db.getProject(req.params.id);
            if (!project) {
                return res.status(404).json({ error: 'Project not found' });
            }
            if (project.clientId && project.clientId !== clientId) {
                return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
            }
            ensureProjectTranslationStructure(project);
            applySegmentTranslations(project, {});
            const pendingBeforeGenerate = collectPendingTranslationOriginals(project);
            if (pendingBeforeGenerate.length > 0) {
                project.status = 'partial';
                project.errorMsg = `仍有 ${pendingBeforeGenerate.length} 条待补译。请先在 P3 点击“补译剩余待翻译项”。`;
                db.saveProject(project);
                return res.status(409).json({ error: project.errorMsg, pendingCount: pendingBeforeGenerate.length });
            }
            if (project.status === 'completed' &&
                project.translatedFilePath &&
                fs.existsSync(project.translatedFilePath) &&
                project.qaReport &&
                project.generationVersion === GENERATION_PIPELINE_VERSION) {
                return res.json(project);
            }
            project.status = 'generating';
            project.generationProgress = {
                phase: 'validating',
                percent: 10,
                message: '正在检查译文完整性...'
            };
            db.saveProject(project);
            const buffer = fs.readFileSync(project.originalFilePath);
            const activeGlossary = (project.glossary && project.glossary.length > 0)
                ? project.glossary
                : db.getGlossary(project.clientId);
            const documentType = project.documentType || getDocumentTypeFromName(project.originalName) || 'pptx';
            let outputBuffer: Buffer;
            project.generationProgress = {
                phase: 'writing',
                percent: 35,
                message: '正在将译文写入文档结构...'
            };
            db.saveProject(project);
            if (documentType === 'pdf') {
                outputBuffer = await writePDFTranslations(project.originalName, project.textItems.map(item => ({
                    originalText: item.originalText,
                    translatedText: item.translatedText
                })), project.targetLang);
            }
            else if (documentType === 'xlsx') {
                const translationsByPart: Record<string, Record<number, string>> = {};
                for (const item of project.textItems) {
                    const partPath = item.partPath || item.slidePath;
                    if (!partPath)
                        continue;
                    const parts = item.id.split('_');
                    const legacyIdx = parseInt(parts[parts.length - 1], 10);
                    const p_idx = item.pIdx ?? legacyIdx;
                    if (!translationsByPart[partPath]) {
                        translationsByPart[partPath] = {};
                    }
                    translationsByPart[partPath][p_idx] = item.translatedText || item.originalText;
                }
                outputBuffer = await writeXLSXTranslations(buffer, translationsByPart);
            }
            else if (documentType === 'docx') {
                const translationsByPart: Record<string, Record<number, string>> = {};
                for (const item of project.textItems) {
                    const partPath = item.partPath || item.slidePath;
                    if (!partPath)
                        continue;
                    const parts = item.id.split('_');
                    const legacyIdx = parseInt(parts[parts.length - 1], 10);
                    const p_idx = item.pIdx ?? legacyIdx;
                    if (!translationsByPart[partPath]) {
                        translationsByPart[partPath] = {};
                    }
                    translationsByPart[partPath][p_idx] = item.translatedText || item.originalText;
                }
                outputBuffer = await writeDOCXTranslations(buffer, translationsByPart);
            }
            else {
                // Reconstruct translation payload grouped by slide number and paragraph index
                const translationsBySlide: Record<number, Record<number, string>> = {};
                const translationsByPart: Record<string, Record<number, string>> = {};
                const translationsByText: Record<string, string> = {};
                for (const item of project.textItems) {
                    if (!translationsBySlide[item.slideNum]) {
                        translationsBySlide[item.slideNum] = {};
                    }
                    const parts = item.id.split('_');
                    const legacyIdx = parseInt(parts[parts.length - 1], 10);
                    const p_idx = item.pIdx ?? legacyIdx;
                    const text = item.translatedText || item.originalText;
                    if (item.translatedText) {
                        translationsByText[item.originalText] = item.translatedText;
                    }
                    if (item.partPath && (item.partType === 'diagram' || item.partType === 'chart')) {
                        if (!translationsByPart[item.partPath]) {
                            translationsByPart[item.partPath] = {};
                        }
                        translationsByPart[item.partPath][p_idx] = text;
                    }
                    else {
                        translationsBySlide[item.slideNum][p_idx] = text;
                    }
                }
                outputBuffer = await writePPTXTranslations(buffer, translationsBySlide, translationsByPart, translationsByText);
            }
            // Save output package
            project.generationProgress = {
                phase: 'packaging',
                percent: 70,
                message: '正在压缩并保存文档包...'
            };
            db.saveProject(project);
            const baseName = path.basename(project.originalName, path.extname(project.originalName));
            const outputExtension = documentType === 'docx' ? 'docx' : (documentType === 'pdf' ? 'pdf' : (documentType === 'xlsx' ? 'xlsx' : 'pptx'));
            const outputSuffix = getOutputLanguageSuffix(project);
            const outFileName = `${baseName}_${outputSuffix}.${outputExtension}`;
            const outPath = path.join(process.cwd(), 'uploads', `${project.id}_${outputSuffix}_${Date.now()}.${outputExtension}`);
            fs.writeFileSync(outPath, outputBuffer);
            project.translatedFilePath = outPath;
            project.errorMsg = undefined;
            // Calculate QA metrics
            let zipIntegrity = false;
            let outputSlideCount = 0;
            let outputMediaCount = 0;
            let emptyMediaCount = 0;
            const details: string[] = [];
            project.generationProgress = {
                phase: 'verifying',
                percent: 85,
                message: '正在验证文件完整性...'
            };
            db.saveProject(project);
            if (documentType === 'docx' && await hasDOCXFixedLayoutFlyerRisk(buffer, project.originalName)) {
                details.push('FORMAT_RISK_FIXED_LAYOUT_FLYER: 该文件为固定版式 flyer，格式可能需要人工微调字号等。');
            }
            let checkZip: JSZip | null = null;
            try {
                if (documentType === 'pdf') {
                    zipIntegrity = outputBuffer.subarray(0, 5).toString('latin1') === '%PDF-';
                    outputSlideCount = project.slideCount;
                    outputMediaCount = 0;
                    details.push('Generated a translated text PDF. Original PDF visual layout is not rewritten in this compatibility mode.');
                }
                else {
                    checkZip = await JSZip.loadAsync(outputBuffer);
                    zipIntegrity = true;
                    if (documentType === 'docx' || documentType === 'xlsx') {
                        outputSlideCount = project.slideCount;
                    }
                    else {
                        const slideReg = /^ppt\/slides\/slide\d+\.xml$/;
                        outputSlideCount = Object.keys(checkZip.files).filter(name => slideReg.test(name)).length;
                    }
                    const mediaPrefix = documentType === 'docx' ? 'word/media/' : (documentType === 'xlsx' ? 'xl/media/' : 'ppt/media/');
                    const mediaFiles = Object.keys(checkZip.files).filter(name => name.startsWith(mediaPrefix));
                    outputMediaCount = mediaFiles.length;
                    for (const file of mediaFiles) {
                        const content = await checkZip.files[file].async('nodebuffer');
                        if (content.length === 0) {
                            emptyMediaCount++;
                            details.push(`Empty media asset found: ${file}`);
                        }
                    }
                }
            }
            catch (err) {
                details.push(`${documentType === 'pdf' ? 'PDF' : 'ZIP package'} integrity failure: ${(err as Error).message}`);
            }
            // Check text mappings
            let unmappedCount = 0;
            let unexpectedEnglishCount = 0;
            let apiFailuresCount = 0;
            const reportedResidualTexts = new Set<string>();
            for (const item of project.textItems) {
                if (item.status === 'warning' && item.translatedText) {
                    item.status = 'translated';
                }
                if (!item.translatedText) {
                    unmappedCount++;
                    apiFailuresCount++;
                    details.push(`Slide ${item.slideNum}: Extracted text remains un-translated.`);
                }
                else {
                    // If the text is translated, check for leftover long English phrases that might be translation missed
                    const targetEnglish = isProjectTargetEnglish(project);
                    const hasResidualSourceLanguage = hasUnexpectedResidualSourceLanguage(item.translatedText, activeGlossary, project);
                    const sourceLooksTranslatable = targetEnglish
                        ? cjkReg.test(item.originalText) && item.originalText.trim().length > 6
                        : /[a-zA-Z]/.test(item.originalText) && item.originalText.trim().length > 12;
                    const sameAsOriginal = normalizeQaText(item.originalText) === normalizeQaText(item.translatedText)
                        && item.originalText.trim().length > (targetEnglish ? 6 : 12);
                    if (sourceLooksTranslatable && (hasResidualSourceLanguage || sameAsOriginal)) {
                        const residualKey = normalizeQaText(item.translatedText);
                        if (reportedResidualTexts.has(residualKey))
                            continue;
                        reportedResidualTexts.add(residualKey);
                        unexpectedEnglishCount++;
                        if (item.status !== 'edited') {
                            item.status = 'warning';
                        }
                        details.push(`Slide ${item.slideNum}: Possible untranslated or residual source-language text in translation: "${item.translatedText}"`);
                    }
                }
            }
            if (checkZip && documentType !== 'pdf') {
                const decodeXmlText = (text: string): string => text
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&amp;/g, '&')
                    .replace(/&apos;/g, "'")
                    .replace(/&quot;/g, '"');
                const collectParagraphTexts = (xml: string): string[] => {
                    const out: string[] = [];
                    xml.replace(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g, (pMatch, pInner) => {
                        const textParts: string[] = [];
                        pInner.replace(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g, (tMatch, tContent) => {
                            textParts.push(decodeXmlText(String(tContent)));
                            return tMatch;
                        });
                        const text = textParts.join('').replace(/\s+/g, ' ').trim();
                        if (text.length > 0)
                            out.push(text);
                        return pMatch;
                    });
                    return out;
                };
                const reportedResiduals = new Set<string>();
                const xmlParts = Object.keys(checkZip.files).filter(name => documentType === 'docx'
                    ? isDocxTextPart(name)
                    : documentType === 'xlsx'
                        ? /^xl\/worksheets\/sheet\d+\.xml$/.test(name)
                        : (/^ppt\/slides\/slide\d+\.xml$/.test(name) || /^ppt\/diagrams\/.+\.xml$/.test(name)));
                for (const partName of xmlParts) {
                    const file = checkZip.files[partName];
                    if (!file)
                        continue;
                    const xml = await file.async('string');
                    const paragraphTexts = documentType === 'docx'
                        ? collectDOCXParagraphTextsFromXml(xml)
                        : documentType === 'xlsx'
                            ? collectXLSXCellTextsFromXml(xml)
                            : collectParagraphTexts(xml);
                    for (const text of paragraphTexts) {
                        const residualThreshold = isProjectTargetEnglish(project) ? 6 : 18;
                        if (text.length < residualThreshold || !hasUnexpectedResidualSourceLanguage(text, activeGlossary, project))
                            continue;
                        const key = normalizeQaText(text);
                        if (reportedResiduals.has(key))
                            continue;
                        if (reportedResidualTexts.has(key))
                            continue;
                        reportedResiduals.add(key);
                        reportedResidualTexts.add(key);
                        unexpectedEnglishCount++;
                        details.push(`Final package residual source-language text in ${partName}: "${text}"`);
                    }
                }
            }
            details.push(`Verified page count: original ${project.slideCount}, generated ${outputSlideCount}.`);
            if (project.slideCount !== outputSlideCount) {
                details.push(`WARNING: Page count mismatch! Original ${project.slideCount} vs Translated ${outputSlideCount}`);
            }
            const qaReport: QAStatus = {
                sourceSlideCount: project.slideCount,
                outputSlideCount,
                zipIntegrity,
                mediaFileCount: outputMediaCount,
                emptyMediaCount,
                unmappedCount,
                unexpectedEnglishCount,
                apiFailuresCount,
                details
            };
            project.qaReport = qaReport;
            project.glossaryValidationReport = projectGlossaryValidationReport(project, activeGlossary);
            project.status = 'completed';
            project.generationVersion = GENERATION_PIPELINE_VERSION;
            project.generationProgress = {
                phase: 'completed',
                percent: 100,
                message: '文档已生成，正在开始下载...'
            };
            db.saveProject(project);
            res.json(project);
        }
        catch (err: any) {
            console.error(err);
            const failedProject = db.getProject(req.params.id);
            if (failedProject) {
                failedProject.status = 'failed';
                failedProject.errorMsg = err.message;
                db.saveProject(failedProject);
            }
            res.status(500).json({ error: err.message });
        }
    });
    // API: Download finished translated package
    app.get('/api/projects/:id/download', (req, res) => {
        const clientId = getClientId(req);
        try {
            const project = db.getProject(req.params.id);
            if (!project) {
                return res.status(404).json({ error: 'Project not found' });
            }
            if (project.clientId && project.clientId !== clientId) {
                return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
            }
            if (!project.translatedFilePath || !fs.existsSync(project.translatedFilePath)) {
                return res.status(404).json({ error: 'Translated file package not found or generation not finished.' });
            }
            const documentType = project.documentType || getDocumentTypeFromName(project.originalName) || 'pptx';
            const downloadName = getTranslatedDownloadName(project, documentType);
            res.download(project.translatedFilePath, downloadName);
        }
        catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });
    // API: Delete project
    app.delete('/api/projects/:id', (req, res) => {
        try {
            const project = db.getProject(req.params.id);
            if (!project) {
                return res.status(404).json({ error: 'Project not found' });
            }
            const clientId = getClientId(req);
            if (project.clientId && project.clientId !== clientId) {
                return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
            }
            db.deleteProject(req.params.id);
            res.json({ success: true });
        }
        catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });
    // API: Glossary Management
    app.get('/api/glossary', (req, res) => {
        try {
            const clientId = getClientId(req);
            res.json(getPersonalGlossary(clientId));
        }
        catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });
    app.get('/api/glossary/libraries', (req, res) => {
        try {
            const clientId = getClientId(req);
            res.json({ libraries: db.getGlossaryLibraries(clientId) });
        }
        catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });
    app.post('/api/glossary/libraries', (req, res) => {
        try {
            const clientId = getClientId(req);
            const name = String(req.body?.name || '').trim();
            if (!name)
                return res.status(400).json({ error: 'Library name is required.' });
            const terms = Array.isArray(req.body?.terms)
                ? normalizePersonalGlossary(req.body.terms)
                : [];
            const library = db.createGlossaryLibrary({
                clientId,
                name,
                description: req.body?.description,
                scope: ['general', 'domain', 'client', 'product', 'project'].includes(req.body?.scope) ? req.body.scope : 'general',
                sourceLang: req.body?.sourceLang,
                targetLang: req.body?.targetLang,
                priority: Number.isFinite(Number(req.body?.priority)) ? Number(req.body.priority) : 0,
                terms
            });
            res.status(201).json({ success: true, library });
        }
        catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });
    app.patch('/api/glossary/libraries/:id', (req, res) => {
        try {
            const clientId = getClientId(req);
            const library = db.getGlossaryLibraries(clientId).find(item => item.id === req.params.id);
            if (!library)
                return res.status(404).json({ error: 'Glossary library not found.' });
            const updated: GlossaryLibrary = {
                ...library,
                name: req.body?.name !== undefined ? String(req.body.name).trim() : library.name,
                description: req.body?.description !== undefined ? String(req.body.description || '').trim() : library.description,
                scope: req.body?.scope && ['general', 'domain', 'client', 'product', 'project'].includes(req.body.scope) ? req.body.scope : library.scope,
                sourceLang: req.body?.sourceLang !== undefined ? req.body.sourceLang : library.sourceLang,
                targetLang: req.body?.targetLang !== undefined ? req.body.targetLang : library.targetLang,
                priority: req.body?.priority !== undefined && Number.isFinite(Number(req.body.priority)) ? Number(req.body.priority) : library.priority,
                terms: Array.isArray(req.body?.terms) ? normalizePersonalGlossary(req.body.terms) : library.terms
            };
            const saved = db.saveGlossaryLibrary(updated);
            res.json({ success: true, library: saved });
        }
        catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });
    app.delete('/api/glossary/libraries/:id', (req, res) => {
        try {
            const clientId = getClientId(req);
            const deleted = db.deleteGlossaryLibrary(clientId, req.params.id);
            if (!deleted)
                return res.status(400).json({ error: 'The default library cannot be deleted or the library was not found.' });
            res.json({ success: true, libraries: db.getGlossaryLibraries(clientId) });
        }
        catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });
    app.post('/api/glossary', (req, res) => {
        try {
            const clientId = getClientId(req);
            const { source, target, category, explanation, usageNote, sourceLang, targetLang, direction } = req.body;
            if (!source || !target) {
                return res.status(400).json({ error: 'source and target fields are required' });
            }
            const term: GlossaryTerm = normalizePersonalGlossaryTerm({
                source,
                target,
                category,
                explanation,
                usageNote,
                sourceLang,
                targetLang,
                direction: direction || (sourceLang && targetLang ? languagePairForLangs(sourceLang, targetLang) : 'bidirectional'),
                origin: 'manual',
                status: 'active'
            });
            db.addGlossaryTerm(term, clientId);
            res.json({ success: true, glossary: getPersonalGlossary(clientId) });
        }
        catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });
    app.post('/api/glossary/import-preview', upload.single('file'), async (req, res) => {
        try {
            const clientId = getClientId(req);
            if (!req.file) {
                return res.status(400).json({ error: 'No glossary file uploaded' });
            }
            const parsed = await parseGlossaryFile(req.file.path, req.file.originalname);
            fs.unlinkSync(req.file.path);
            res.json(buildGlossaryImportPreview(normalizePersonalGlossary(parsed.terms), getPersonalGlossary(clientId), parsed.skippedRows));
        }
        catch (err: any) {
            if (req.file?.path && fs.existsSync(req.file.path))
                fs.unlinkSync(req.file.path);
            res.status(500).json({ error: err.message });
        }
    });
    app.post('/api/glossary/import-apply', (req, res) => {
        try {
            const clientId = getClientId(req);
            const { terms, conflictStrategy = 'skip' } = req.body;
            if (!Array.isArray(terms)) {
                return res.status(400).json({ error: 'terms must be an array' });
            }
            const glossary = mergeGlossaryTerms(getPersonalGlossary(clientId), normalizePersonalGlossary(terms), conflictStrategy === 'overwrite' ? 'overwrite' : 'skip');
            db.saveGlossary(normalizePersonalGlossary(glossary), clientId);
            res.json({ success: true, glossary: getPersonalGlossary(clientId) });
        }
        catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });
    app.patch('/api/glossary/:source', (req, res) => {
        try {
            const clientId = getClientId(req);
            const oldSource = req.params.source;
            const oldTarget = typeof req.query.target === 'string' ? req.query.target : undefined;
            const { source, target, category, explanation, usageNote, sourceLang, targetLang, direction } = req.body;
            if (!oldSource || !oldTarget) {
                return res.status(400).json({ error: 'source path and target query are required to update a glossary term.' });
            }
            if (!source || !target) {
                return res.status(400).json({ error: 'source and target fields are required.' });
            }
            const glossary = getPersonalGlossary(clientId);
            const index = glossary.findIndex(term => term.source.toLowerCase() === oldSource.toLowerCase()
                && term.target.toLowerCase() === oldTarget.toLowerCase());
            if (index < 0) {
                return res.status(404).json({ error: 'Glossary term not found.' });
            }
            const updatedTerm: GlossaryTerm = normalizePersonalGlossaryTerm({
                ...glossary[index],
                source,
                target,
                category,
                explanation,
                usageNote,
                sourceLang: sourceLang ?? glossary[index].sourceLang,
                targetLang: targetLang ?? glossary[index].targetLang,
                direction: direction || glossary[index].direction || (sourceLang && targetLang ? languagePairForLangs(sourceLang, targetLang) : 'bidirectional'),
                origin: glossary[index].origin || 'manual',
                status: glossary[index].status || 'active'
            });
            const updatedGlossary = [...glossary];
            updatedGlossary[index] = updatedTerm;
            db.saveGlossary(updatedGlossary, clientId);
            res.json({ success: true, glossary: getPersonalGlossary(clientId) });
        }
        catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });
    app.delete('/api/glossary/:source', (req, res) => {
        try {
            const clientId = getClientId(req);
            const target = typeof req.query.target === 'string' ? req.query.target : undefined;
            db.deleteGlossaryTerm(req.params.source, target, clientId);
            res.json({ success: true, glossary: getPersonalGlossary(clientId) });
        }
        catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });
    // API: Translation Memory management
    app.get('/api/tm', (req, res) => {
        try {
            const clientId = getClientId(req);
            res.json(db.getTranslationMemory(clientId));
        }
        catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });
    app.post('/api/tm/clear', (req, res) => {
        try {
            const clientId = getClientId(req);
            db.clearTM(clientId);
            res.json({ success: true });
        }
        catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });
    // API: One-click Full System Reset (per current user)
    app.post('/api/system/reset', (req, res) => {
        try {
            const clientId = getClientId(req);
            db.resetSystem(clientId);
            res.json({ success: true, message: 'Your projects, glossary, and translation memory were reset.' });
        }
        catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });
    // API: Get Current Engine Deployment Config
    app.get('/api/system/config', (req, res) => {
        try {
            const modelConfig = getModelApiConfig();
            res.json({
                activeEngine: modelConfig.providerName,
                hasApiKey: Boolean(modelConfig.apiKey),
                model: modelConfig.model,
                baseUrl: modelConfig.baseUrl
            });
        }
        catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });
    // Vite Server Middleware Routing Setup
    if (process.env.NODE_ENV !== 'production') {
        const vite = await createViteServer({
            server: {
                middlewareMode: true,
                watch: {
                    ignored: ['**/data/**', '**/uploads/**', '**/dist/**']
                }
            },
            appType: 'spa'
        });
        app.use(vite.middlewares);
    }
    else {
        const distPath = path.join(process.cwd(), 'dist');
        app.use(express.static(distPath));
        app.get('*', (req, res) => {
            res.sendFile(path.join(distPath, 'index.html'));
        });
    }
    const HOST = process.env.HOST || '127.0.0.1';
    app.listen(PORT, HOST, () => {
        console.log(`Server fully operational on http://localhost:${PORT}`);
    });
}
startServer();
