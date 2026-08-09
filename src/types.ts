export type TranslationDirection = string;
export type TranslationDomain = 'business';
export type DocumentType = 'pptx' | 'docx' | 'pdf' | 'xlsx';
export type TranslationPhase = 'preparing' | 'translating' | 'pausing' | 'paused' | 'qa_checking' | 'glossary_checking' | 'backfilling' | 'finalizing' | 'completed';

export interface TranslationProgress {
  total: number;
  completed: number;
  percent: number;
  phase?: TranslationPhase;
  message?: string;
}

export interface ProjectSummary {
  id: string;
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
  sourceLang: string;
  targetLang: string;
  translationDirection?: TranslationDirection;
  languagePair?: string;
  translationDomain?: TranslationDomain;
  tone: string;
  glossaryPreset: string;
  status: 'uploaded' | 'translating' | 'pausing' | 'paused' | 'translated' | 'partial' | 'generating' | 'completed' | 'failed';
  errorMsg?: string;
  originalCacheKey?: string;
  translatedFilePath?: string | null;
  translationProgress?: TranslationProgress;
  translationStartedAt?: string;
  translationCompletedAt?: string;
  generationProgress?: {
    phase: 'validating' | 'writing' | 'packaging' | 'verifying' | 'completed';
    percent: number;
    message: string;
  };
  generationVersion?: number;
  glossary?: GlossaryTerm[];
  selectedGlossaryLibraryIds?: string[];
  glossaryLibraryOrder?: string[];
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

export interface ExtractedTextItem {
  id: string; // slideNum_p_idx
  segmentId?: string;
  containerId?: string;
  slideNum: number;
  slidePath?: string;
  partPath?: string;
  partType?: 'slide' | 'diagram' | 'chart' | 'document';
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
  termHints?: SegmentTermHint[];
  status?: 'pending' | 'translated' | 'edited' | 'confirmed';
}

export interface SegmentTermHint {
  source: string;
  target: string;
  explanation?: string;
  usageNote?: string;
  category?: string;
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

export interface ProjectDetail extends ProjectSummary {
  textItems: ExtractedTextItem[];
  translationMap: Record<string, string>;
  sourceContainers?: SourceContainer[];
  translationSegments?: TranslationSegment[];
  translationBySegmentId?: Record<string, string>;
  qaReport: QAStatus | null;
  glossaryValidationReport?: GlossaryValidationReport | null;
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

export interface GlossaryLibrary {
  id: string;
  clientId: string;
  name: string;
  description?: string;
  scope: 'general' | 'domain' | 'client' | 'product' | 'project';
  sourceLang?: string;
  targetLang?: string;
  priority: number;
  terms: GlossaryTerm[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectGlossaryReviewCandidate {
  source: string;
  occurrences: {
    slideNum: number;
    text: string;
  }[];
  candidates: GlossaryTerm[];
  status: 'ambiguous' | 'ai_selected' | 'needs_review';
  selectedTarget?: string;
  confidence?: number;
  reason?: string;
}

export interface GlossaryConflict {
  source: string;
  existing: GlossaryTerm;
  incoming: GlossaryTerm;
}

export interface GlossaryImportPreview {
  terms: GlossaryTerm[];
  additions: GlossaryTerm[];
  conflicts: GlossaryConflict[];
  skippedRows: number;
}
