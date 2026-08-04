import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { ProjectGlossaryReviewCandidate } from './glossary.js';
import { DATA_DIR } from './paths.js';
import { normalizeStoredFileName } from './file-name.js';

export type TranslationDirection = string;
export type TranslationDomain = 'business';
export type DocumentType = 'pptx' | 'docx' | 'pdf' | 'xlsx';

export interface ExtractedTextItem {
  id: string; // slideNum_p_idx
  segmentId?: string;
  containerId?: string;
  slideNum: number;
  slidePath?: string;
  partPath?: string;
  partType?: 'slide' | 'diagram' | 'document';
  pIdx?: number;
  sourceHash?: string;
  originalText: string;
  translatedText: string;
  status: 'pending' | 'translated' | 'preserved' | 'edited' | 'warning';
}

export interface SourceContainer {
  containerId: string;
  documentType: DocumentType;
  containerType:
    | 'paragraph'
    | 'heading'
    | 'table_cell'
    | 'shape'
    | 'smartart'
    | 'header'
    | 'footer'
    | 'spreadsheet_cell'
    | 'unknown';
  sourceLocation: Record<string, unknown>;
  rawText: string;
  segmentIds: string[];
}

export interface TranslationSegment {
  segmentId: string;
  containerId: string;
  sourceText: string;
  translatedText?: string;
  documentType: DocumentType;
  location: {
    locationLabel: string;
    slideNumber?: number;
    paragraphIndex?: number;
    sheetName?: string;
    cellAddress?: string;
    shapeId?: string;
    tableId?: string;
    partName?: string;
  };
  context: {
    containerTitle?: string;
    nearbyTexts?: string[];
    role?: string;
    previousSegmentText?: string;
    nextSegmentText?: string;
  };
  /** Terminology constraints resolved for this write-back unit only. */
  termHints?: SegmentTermHint[];
  status?: 'pending' | 'translated' | 'edited' | 'confirmed';
}

export interface SegmentTermHint {
  source: string;
  target: string;
  explanation?: string;
  usageNote?: string;
  category?: string;
  /** Strict hints are enforced by deterministic QA; candidates are advisory. */
  mode?: 'strict' | 'candidate' | 'skipped';
  confidence?: number;
  reason?: string;
  sourceLibraryId?: string;
  sourceLibraryName?: string;
}

export interface QAStatus {
  sourceSlideCount: number;
  outputSlideCount: number;
  zipIntegrity: boolean;
  mediaFileCount: number;
  emptyMediaCount: number;
  unmappedCount: number;
  unexpectedEnglishCount: number;
  apiFailuresCount: number;
  details: string[];
}

export interface GlossaryValidationFinding {
  status: 'PASS' | 'GLOSSARY_MISS';
  itemId: string;
  slideNum: number;
  source: string;
  expectedTarget: string;
  originalText: string;
  translatedText: string;
  explanation?: string;
  category?: string;
}

export interface GlossaryValidationReport {
  checkedTerms: number;
  hits: number;
  misses: number;
  findings: GlossaryValidationFinding[];
}

export interface Project {
  id: string;
  clientId?: string; // Client isolation identifier
  originalName: string;
  documentType?: DocumentType;
  uploadTime: string;
  slideCount: number;
  uniqueCount: number;
  repeatedCount: number;
  mediaCount: number;
  fileSize?: number;
  fileSizeBytes?: number;
  estimatedChars?: number;
  originalFilePath: string;
  translatedFilePath: string | null;
  sourceLang: string;
  targetLang: string;
  translationDirection: TranslationDirection;
  languagePair?: string;
  translationDomain: TranslationDomain;
  tone: string;
  glossaryPreset: string;
  status: 'uploaded' | 'translating' | 'pausing' | 'paused' | 'translated' | 'partial' | 'generating' | 'completed' | 'failed';
  errorMsg?: string;
  originalCacheKey?: string;
  textItems: ExtractedTextItem[];
  translationMap: Record<string, string>; // Maps unique originalText -> translatedText
  sourceContainers?: SourceContainer[];
  translationSegments?: TranslationSegment[];
  translationBySegmentId?: Record<string, string>;
  /** Immutable terminology inputs and segment-level decisions for this project run. */
  effectiveGlossarySnapshot?: GlossaryTerm[];
  segmentTermHints?: Record<string, SegmentTermHint[]>;
  glossaryConflictDecisions?: Record<string, {
    source: string;
    segmentId?: string;
    target?: string;
    mode: 'strict' | 'candidate' | 'skipped';
    scope: 'segment' | 'page' | 'context' | 'project';
    note?: string;
    updatedAt: string;
  }>;
  translationProgress?: {
    total: number;
    completed: number;
    percent: number;
    phase?: 'preparing' | 'translating' | 'pausing' | 'paused' | 'qa_checking' | 'glossary_checking' | 'backfilling' | 'finalizing' | 'completed';
    message?: string;
  };
  translationStartedAt?: string;
  translationCompletedAt?: string;
  generationProgress?: {
    phase: 'validating' | 'writing' | 'packaging' | 'verifying' | 'completed';
    percent: number;
    message: string;
  };
  generationVersion?: number;
  qaReport: QAStatus | null;
  glossaryValidationReport?: GlossaryValidationReport | null;
  glossary?: GlossaryTerm[];
  selectedGlossaryLibraryIds?: string[];
  glossaryLibraryOrder?: string[];
  glossaryLanguageVersion?: number;
  glossaryReviewCandidates?: ProjectGlossaryReviewCandidate[];
  preDetectStatus?: 'pending' | 'running' | 'completed' | 'failed';
  preDetectError?: string;
  preDetectReport?: {
    topic: string;
    topic_keywords?: string[];
    description?: string;
    recommendedGlossary: {
      source: string;
      target: string;
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
    }[];
  } | null;
}

export interface GlossaryTerm {
  source: string;
  target: string;
  category?: string;
  explanation?: string;
  usageNote?: string;
  libraryId?: string;
  libraryName?: string;
  origin?: 'global' | 'ai' | 'imported' | 'manual';
  status?: 'active' | 'candidate' | 'ambiguous' | 'ai_selected' | 'needs_review';
  usageCount?: number;
  confidence?: number;
  reason?: string;
  checked?: boolean;
  sourceLang?: string;
  targetLang?: string;
  direction?: TranslationDirection | 'bidirectional';
}

export type GlossaryLibraryScope = 'general' | 'domain' | 'client' | 'product' | 'project';

export interface GlossaryLibrary {
  id: string;
  clientId: string;
  name: string;
  description?: string;
  scope: GlossaryLibraryScope;
  sourceLang?: string;
  targetLang?: string;
  priority: number;
  terms: GlossaryTerm[];
  createdAt: string;
  updatedAt: string;
}
export interface DatabaseSchema {
  projects: Record<string, Project>;
  glossary: GlossaryTerm[];
  glossaryByClientId: Record<string, GlossaryTerm[]>;
  glossaryLibrariesByClientId: Record<string, GlossaryLibrary[]>;
  translationMemory: Record<string, string>; // Legacy global TM retained for migration compatibility
  translationMemoryByClientId: Record<string, Record<string, string>>;
}

function normalizeTranslationDirection(raw: any, sourceLang?: string, targetLang?: string): TranslationDirection {
  if (raw === 'zh-en' || raw === 'en-zh') return raw;
  if (raw && raw !== 'auto') return String(raw);
  const source = String(sourceLang || '').toLowerCase();
  const target = String(targetLang || '').toLowerCase();
  if (source.includes('chinese') || target.includes('english')) return 'zh-en';
  return languagePairForLangs(sourceLang || 'English', targetLang || 'Simplified Chinese');
}

function normalizeTranslationDomain(raw: any): TranslationDomain {
  // Business-only product mode. Legacy domain values are folded into business.
  return 'business';
}

function languagePairForDirection(direction: TranslationDirection): { sourceLang: string; targetLang: string } {
  return direction === 'zh-en'
    ? { sourceLang: 'Simplified Chinese', targetLang: 'English' }
    : { sourceLang: 'English', targetLang: 'Simplified Chinese' };
}

function languagePairForLangs(sourceLang: string, targetLang: string): string {
  return `${String(sourceLang || 'English').trim()}-${String(targetLang || 'Simplified Chinese').trim()}`;
}

function normalizeStoredLanguage(value: any): string | undefined {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return undefined;
  if (['en', 'eng', 'english'].includes(normalized)) return 'English';
  if (['zh', 'zho', 'chi', 'chinese', 'cn', 'zh-cn', 'simplified chinese'].includes(normalized)) return 'Simplified Chinese';
  if (['fr', 'fra', 'fre', 'french'].includes(normalized)) return 'French';
  if (['ja', 'jpn', 'japanese'].includes(normalized)) return 'Japanese';
  if (['it', 'ita', 'italian'].includes(normalized)) return 'Italian';
  if (['ar', 'ara', 'arabic', 'العربية', '阿拉伯语'].includes(normalized)) return 'Arabic';
  return String(value || '').trim();
}
const DB_FILE = path.join(DATA_DIR, 'db.json');

function normalizeGlossaryTerm(raw: any): GlossaryTerm {
  const source = String(raw?.source || '').trim();
  const explanation = raw?.explanation || raw?.description || undefined;
  const sourceLang = normalizeStoredLanguage(raw?.sourceLang);
  const targetLang = normalizeStoredLanguage(raw?.targetLang);
  const fallbackPair = languagePairForDirection(normalizeTranslationDirection(raw?.direction, sourceLang, targetLang));
  const isLegacyUnscopedAiTerm = raw?.origin === 'ai' && !sourceLang && !targetLang && !raw?.direction;
  const inferredCategory = /^[A-Z0-9/-]{2,}$/.test(source)
    ? 'Code & Acronym'
    : source.toLowerCase().startsWith('sap') || ['Launchpad', 'App Finder', 'My Home'].includes(source)
      ? 'Product & Brand'
      : 'Other';
  return {
    source,
    target: String(raw?.target || '').trim(),
    category: raw?.category || inferredCategory,
    explanation,
    usageNote: raw?.usageNote || raw?.translationNote || undefined,
    libraryId: raw?.libraryId || undefined,
    libraryName: raw?.libraryName || undefined,
    origin: raw?.origin,
    status: raw?.status,
    usageCount: raw?.usageCount,
    confidence: raw?.confidence,
    reason: raw?.reason,
    checked: raw?.checked,
    sourceLang: sourceLang || (isLegacyUnscopedAiTerm ? undefined : fallbackPair.sourceLang),
    targetLang: targetLang || (isLegacyUnscopedAiTerm ? undefined : fallbackPair.targetLang),
    direction: raw?.direction === 'bidirectional'
      ? 'bidirectional'
      : (isLegacyUnscopedAiTerm ? undefined : normalizeTranslationDirection(raw?.direction, sourceLang, targetLang))
  };
}

function glossaryMatchKey(value: unknown): string {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase();
}

function normalizeProject(project: any): Project {
  const normalized = { ...project };
  normalized.originalName = normalizeStoredFileName(normalized.originalName, normalized.originalCacheKey);
  const ext = path.extname(String(normalized.originalName || '')).toLowerCase();
  normalized.documentType = normalized.documentType === 'xlsx' || ext === '.xlsx'
    ? 'xlsx'
    : (normalized.documentType === 'pdf' || ext === '.pdf'
      ? 'pdf'
      : (normalized.documentType === 'docx' || ext === '.docx' ? 'docx' : 'pptx'));
  normalized.translationDirection = normalizeTranslationDirection(normalized.translationDirection, normalized.sourceLang, normalized.targetLang);
  normalized.translationDomain = normalizeTranslationDomain(normalized.translationDomain);
  const pair = languagePairForDirection(normalized.translationDirection);
  normalized.sourceLang = normalized.sourceLang || pair.sourceLang;
  normalized.targetLang = normalized.targetLang || pair.targetLang;
  normalized.languagePair = normalized.languagePair || languagePairForLangs(normalized.sourceLang, normalized.targetLang);
  if (Array.isArray(normalized.glossary)) {
    normalized.glossary = normalized.glossary.map(normalizeGlossaryTerm).filter((term: GlossaryTerm) => term.source && term.target);
  }
  if (Array.isArray(normalized.effectiveGlossarySnapshot)) {
    normalized.effectiveGlossarySnapshot = normalized.effectiveGlossarySnapshot
      .map(normalizeGlossaryTerm)
      .filter((term: GlossaryTerm) => term.source && term.target);
  }
  if (normalized.segmentTermHints && typeof normalized.segmentTermHints === 'object') {
    normalized.segmentTermHints = Object.fromEntries(
      Object.entries(normalized.segmentTermHints).map(([segmentId, hints]) => [
        segmentId,
        Array.isArray(hints)
          ? hints.filter((hint: any) => hint?.source && hint?.target).map((hint: any) => ({
            source: String(hint.source).trim(),
            target: String(hint.target).trim(),
            explanation: hint.explanation,
            usageNote: hint.usageNote,
            category: hint.category,
            mode: hint.mode === 'candidate' || hint.mode === 'skipped' ? hint.mode : 'strict',
            confidence: typeof hint.confidence === 'number' ? hint.confidence : undefined,
            reason: hint.reason,
            sourceLibraryId: hint.sourceLibraryId,
            sourceLibraryName: hint.sourceLibraryName
          }))
          : []
      ])
    );
  }
  if (normalized.preDetectReport?.recommendedGlossary) {
    normalized.preDetectReport = {
      ...normalized.preDetectReport,
      topic_keywords: normalized.preDetectReport.topic_keywords || (normalized.preDetectReport.topic ? [normalized.preDetectReport.topic] : []),
      description: normalized.preDetectReport.description || normalized.preDetectReport.file_description,
      recommendedGlossary: normalized.preDetectReport.recommendedGlossary.map(normalizeGlossaryTerm).filter((term: GlossaryTerm) => term.source && term.target)
    };
  }
  return normalized;
}

const DEFAULT_GLOSSARY: GlossaryTerm[] = [
  { source: 'SAP Fiori', target: 'SAP Fiori', category: 'Product & Brand', explanation: 'SAP UX specification and technology framework' },
  { source: 'SAP S/4HANA', target: 'SAP S/4HANA', category: 'Product & Brand', explanation: 'SAP intelligent ERP suite' },
  { source: 'SAP GUI', target: 'SAP GUI', category: 'Product & Brand', explanation: 'SAP traditional graphical user interface' },
  { source: 'Launchpad', target: '\u542f\u52a8\u53f0 (Launchpad)', category: 'Product & Brand', explanation: 'Application home page navigation or entry point' },
  { source: 'App Finder', target: '\u5e94\u7528\u67e5\u627e\u5668 (App Finder)', category: 'Product & Brand', explanation: 'Tool for searching and finding SAP applications' },
  { source: 'My Home', target: '\u6211\u7684\u4e3b\u9875 (My Home)', category: 'Product & Brand', explanation: 'Personalized user workspace' },
  { source: 'T-Code', target: '\u4e8b\u52a1\u4ee3\u7801 (T-Code)', category: 'Code & Acronym', explanation: 'SAP transaction shortcut code' },
  { source: 'SSO', target: '\u5355\u70b9\u767b\u5f55 (SSO)', category: 'Code & Acronym', explanation: 'SSO = Single Sign-On' },
  { source: 'KPI', target: '\u5173\u952e\u7ee9\u6548\u6307\u6807 (KPI)', category: 'Code & Acronym', explanation: 'KPI = Key Performance Indicator' }
];

class Database {
  private cache: DatabaseSchema = {
    projects: {},
    glossary: [...DEFAULT_GLOSSARY],
    glossaryByClientId: {},
    glossaryLibrariesByClientId: {},
    translationMemory: {},
    translationMemoryByClientId: {}
  };

  constructor() {
    this.ensureDirectory();
    this.load();
  }

  private ensureDirectory() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const uploadsDir = path.join(process.cwd(), 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  }

  private load() {
    try {
      if (!fs.existsSync(DB_FILE)) {
        this.save();
        return;
      }

      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
      this.cache = {
        projects: Object.fromEntries(
          Object.entries(parsed.projects || {}).map(([id, project]) => [id, normalizeProject(project)])
        ),
        glossary: (parsed.glossary || [...DEFAULT_GLOSSARY])
          .map(normalizeGlossaryTerm)
          .filter((term: GlossaryTerm) => term.source && term.target),
        glossaryByClientId: Object.fromEntries(
          Object.entries(parsed.glossaryByClientId || {}).map(([clientId, terms]) => [
            clientId,
            Array.isArray(terms)
              ? terms.map(normalizeGlossaryTerm).filter((term: GlossaryTerm) => term.source && term.target)
              : []
          ])
        ),
        glossaryLibrariesByClientId: Object.fromEntries(
          Object.entries(parsed.glossaryLibrariesByClientId || {}).map(([clientId, libraries]) => [
            clientId,
            Array.isArray(libraries)
              ? libraries.map((library: any) => ({
                  ...library,
                  clientId,
                  scope: ['general', 'domain', 'client', 'product', 'project'].includes(library?.scope)
                    ? library.scope
                    : 'general',
                  priority: Number.isFinite(Number(library?.priority)) ? Number(library.priority) : 0,
                  terms: Array.isArray(library?.terms)
                    ? library.terms.map(normalizeGlossaryTerm).filter((term: GlossaryTerm) => term.source && term.target)
                    : [],
                  createdAt: library?.createdAt || new Date().toISOString(),
                  updatedAt: library?.updatedAt || new Date().toISOString()
                }))
              : []
          ])
        ),
        translationMemory: parsed.translationMemory || {},
        translationMemoryByClientId: parsed.translationMemoryByClientId || {}
      };
      this.save();
    } catch (error) {
      console.error('Error loading local database:', error);
    }
  }

  private save() {
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(this.cache, null, 2), 'utf-8');
    } catch (e) {
      console.error('Error saving database to file:', e);
    }
  }

  // Projects Operations
  public getProjects(clientId?: string): Project[] {
    const list = Object.values(this.cache.projects);
    if (!clientId) {
      return [];
    }
    const filtered = list.filter(p => p.clientId === clientId);
    return filtered.sort((a, b) =>
      new Date(b.uploadTime).getTime() - new Date(a.uploadTime).getTime()
    );
  }

  public getAllProjects(): Project[] {
    return Object.values(this.cache.projects);
  }

  public getProject(id: string): Project | null {
    return this.cache.projects[id] || null;
  }

  public saveProject(project: Project) {
    this.cache.projects[project.id] = project;
    this.save();
  }

  public deleteProject(id: string) {
    const project = this.cache.projects[id];
    if (project) {
      try {
        // Try deleting local files Associated with it
        if (project.originalFilePath && fs.existsSync(project.originalFilePath)) {
          fs.unlinkSync(project.originalFilePath);
        }
        if (project.translatedFilePath && fs.existsSync(project.translatedFilePath)) {
          fs.unlinkSync(project.translatedFilePath);
        }
      } catch (err) {
        console.error('Error unlinking project files:', err);
      }

      const translationMemory = project.clientId
        ? this.cache.translationMemoryByClientId[project.clientId]
        : undefined;
      if (translationMemory) {
        const projectSourceTexts = new Set([
          ...(project.textItems || []).map(item => item.originalText),
          ...Object.keys(project.translationMap || {})
        ]);
        for (const sourceText of projectSourceTexts) {
          delete translationMemory[sourceText];
        }
      }

      delete this.cache.projects[id];
      this.save();
    }
  }

  // Glossary Operations
  private ensureClientGlossary(clientId?: string): GlossaryTerm[] {
    if (!clientId) return [];
    if (!this.cache.glossaryByClientId[clientId]) {
      // New users start with an empty personal glossary; DEFAULT_GLOSSARY is retained only for legacy/global migration compatibility.
      this.cache.glossaryByClientId[clientId] = [];
      this.save();
    }
    return this.cache.glossaryByClientId[clientId];
  }

  public getGlossary(clientId?: string): GlossaryTerm[] {
    return this.ensureClientGlossary(clientId);
  }

  public saveGlossary(terms: GlossaryTerm[], clientId?: string) {
    if (!clientId) return;
    const normalizedTerms = terms.map(normalizeGlossaryTerm).filter(term => term.source && term.target);
    this.cache.glossaryByClientId[clientId] = normalizedTerms;
    const defaultId = `default_${clientId}`;
    const libraries = this.cache.glossaryLibrariesByClientId[clientId] || [];
    const defaultLibrary = libraries.find(library => library.id === defaultId);
    if (defaultLibrary) {
      defaultLibrary.terms = normalizedTerms.map(term => ({ ...term, libraryId: defaultId, libraryName: defaultLibrary.name }));
      defaultLibrary.updatedAt = new Date().toISOString();
    }
    this.save();
  }

  public addGlossaryTerm(term: GlossaryTerm, clientId?: string) {
    if (!clientId) return;
    const glossary = this.ensureClientGlossary(clientId);
    const cleanTerm = normalizeGlossaryTerm(term);
    // Prevent exact duplicates while allowing the same source term to have
    // multiple context-specific targets, especially for abbreviations.
    const idx = glossary.findIndex(t =>
      glossaryMatchKey(t.source) === glossaryMatchKey(cleanTerm.source)
      && glossaryMatchKey(t.target) === glossaryMatchKey(cleanTerm.target)
    );
    if (idx >= 0) {
      glossary[idx] = cleanTerm;
    } else {
      glossary.push(cleanTerm);
    }
    const defaultLibrary = (this.cache.glossaryLibrariesByClientId[clientId] || [])
      .find(library => library.id === `default_${clientId}`);
    if (defaultLibrary) {
      defaultLibrary.terms = glossary.map(term => ({ ...term, libraryId: defaultLibrary.id, libraryName: defaultLibrary.name }));
      defaultLibrary.updatedAt = new Date().toISOString();
    }
    this.save();
  }

  public deleteGlossaryTerm(source: string, target?: string, clientId?: string) {
    if (!clientId) return;
    const glossary = this.ensureClientGlossary(clientId);
    this.cache.glossaryByClientId[clientId] = glossary.filter(t => {
      const sourceMatches = t.source.toLowerCase() === source.toLowerCase();
      if (!sourceMatches) return true;
      if (!target) return false;
      return t.target.toLowerCase() !== target.toLowerCase();
    });
    const defaultLibrary = (this.cache.glossaryLibrariesByClientId[clientId] || [])
      .find(library => library.id === `default_${clientId}`);
    if (defaultLibrary) {
      defaultLibrary.terms = this.cache.glossaryByClientId[clientId]
        .map(term => ({ ...term, libraryId: defaultLibrary.id, libraryName: defaultLibrary.name }));
      defaultLibrary.updatedAt = new Date().toISOString();
    }
    this.save();
  }

  private ensureClientGlossaryLibraries(clientId?: string): GlossaryLibrary[] {
    if (!clientId) return [];
    if (!this.cache.glossaryLibrariesByClientId[clientId]) {
      this.cache.glossaryLibrariesByClientId[clientId] = [];
    }

    const libraries = this.cache.glossaryLibrariesByClientId[clientId];
    if (libraries.length === 0) {
      const legacyTerms = this.ensureClientGlossary(clientId);
      const now = new Date().toISOString();
      libraries.push({
        id: `default_${clientId}`,
        clientId,
        name: '我的默认术语库',
        description: '由旧版全局术语库迁移而来，可继续通过旧接口维护。',
        scope: 'general',
        priority: 0,
        terms: legacyTerms.map(term => ({ ...term, libraryId: `default_${clientId}`, libraryName: '我的默认术语库' })),
        createdAt: now,
        updatedAt: now
      });
      this.save();
    }
    return libraries;
  }

  public getGlossaryLibraries(clientId?: string): GlossaryLibrary[] {
    return this.ensureClientGlossaryLibraries(clientId).map(library => ({
      ...library,
      terms: library.terms.map(term => ({ ...term }))
    }));
  }

  public saveGlossaryLibrary(library: GlossaryLibrary): GlossaryLibrary {
    const libraries = this.ensureClientGlossaryLibraries(library.clientId);
    const clean: GlossaryLibrary = {
      ...library,
      name: String(library.name || '').trim(),
      description: library.description ? String(library.description).trim() : undefined,
      scope: library.scope || 'general',
      priority: Number.isFinite(Number(library.priority)) ? Number(library.priority) : 0,
      terms: (library.terms || []).map(normalizeGlossaryTerm)
        .filter(term => term.source && term.target)
        .map(term => ({ ...term, libraryId: library.id, libraryName: String(library.name || '').trim() })),
      updatedAt: new Date().toISOString()
    };
    const index = libraries.findIndex(item => item.id === clean.id);
    if (index >= 0) libraries[index] = clean;
    else libraries.push(clean);
    if (clean.id === `default_${clean.clientId}`) {
      this.cache.glossaryByClientId[clean.clientId] = clean.terms.map(term => ({ ...term }));
    }
    this.save();
    return { ...clean, terms: clean.terms.map(term => ({ ...term })) };
  }

  public createGlossaryLibrary(input: Omit<GlossaryLibrary, 'id' | 'createdAt' | 'updatedAt'>): GlossaryLibrary {
    const now = new Date().toISOString();
    return this.saveGlossaryLibrary({
      ...input,
      id: `lib_${crypto.randomUUID()}`,
      createdAt: now,
      updatedAt: now
    });
  }

  public deleteGlossaryLibrary(clientId: string | undefined, libraryId: string): boolean {
    if (!clientId) return false;
    const libraries = this.ensureClientGlossaryLibraries(clientId);
    if (libraryId === `default_${clientId}`) return false;
    const next = libraries.filter(library => library.id !== libraryId);
    if (next.length === libraries.length) return false;
    this.cache.glossaryLibrariesByClientId[clientId] = next;
    this.save();
    return true;
  }

  // Translation Memory Operations
  private ensureClientTM(clientId?: string): Record<string, string> {
    if (!clientId) return {};
    if (!this.cache.translationMemoryByClientId[clientId]) {
      this.cache.translationMemoryByClientId[clientId] = {};
      this.save();
    }
    return this.cache.translationMemoryByClientId[clientId];
  }

  public getTranslationMemory(clientId?: string): Record<string, string> {
    return this.ensureClientTM(clientId);
  }

  public saveTranslationMemory(tm: Record<string, string>, clientId?: string) {
    if (!clientId) return;
    this.cache.translationMemoryByClientId[clientId] = tm;
    this.save();
  }

  public setTM(original: string, translation: string, clientId?: string) {
    if (!clientId) return;
    const tm = this.ensureClientTM(clientId);
    tm[original] = translation;
    this.save();
  }

  public clearTM(clientId?: string) {
    if (!clientId) return;
    this.cache.translationMemoryByClientId[clientId] = {};
    this.save();
  }

  private makeId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  public resetSystem(clientId?: string) {
    const projectsToDelete = clientId
      ? Object.values(this.cache.projects).filter(project => project.clientId === clientId)
      : [];

    try {
      for (const project of projectsToDelete) {
        if (project.originalFilePath && fs.existsSync(project.originalFilePath)) {
          fs.unlinkSync(project.originalFilePath);
        }
        if (project.translatedFilePath && fs.existsSync(project.translatedFilePath)) {
          fs.unlinkSync(project.translatedFilePath);
        }
      }
    } catch (err) {
      console.error('Error during system reset unlinking files:', err);
    }

    if (clientId) {
      for (const project of projectsToDelete) {
        delete this.cache.projects[project.id];
      }
      this.cache.glossaryByClientId[clientId] = [];
      this.cache.translationMemoryByClientId[clientId] = {};
    }
    this.save();
  }
}

export const db = new Database();
