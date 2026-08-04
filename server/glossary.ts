import path from 'path';
import fs from 'fs';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { GlossaryTerm, ExtractedTextItem, TranslationDirection, SegmentTermHint } from './db.js';

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

export interface ProjectGlossaryLinkResult {
  terms: GlossaryTerm[];
  reviewCandidates: ProjectGlossaryReviewCandidate[];
}

function textContent(node: any): string {
  return node?.textContent?.replace(/\s+/g, ' ').trim() || '';
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const next = content[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      i++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      row.push(cell.trim());
      cell = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i++;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function decodeCsvBuffer(buffer: Buffer): string {
  const utf8 = buffer.toString('utf-8').replace(/^\uFEFF/, '');
  if (!utf8.includes('\uFFFD')) return utf8;

  try {
    return new TextDecoder('gb18030').decode(buffer).replace(/^\uFEFF/, '');
  } catch {
    return utf8;
  }
}

function normalizeGlossaryLang(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (['en', 'eng', 'english'].includes(normalized)) return 'English';
  if (['zh', 'zho', 'chi', 'chinese', 'cn', 'zh-cn', 'simplified chinese'].includes(normalized)) return 'Simplified Chinese';
  if (['fr', 'fra', 'fre', 'french'].includes(normalized)) return 'French';
  if (['ja', 'jp', 'jpn', 'japanese'].includes(normalized)) return 'Japanese';
  if (['it', 'ita', 'italian', '意大利语'].includes(normalized)) return 'Italian';
  if (['ar', 'ara', 'arabic', 'العربية', '阿拉伯语'].includes(normalized)) return 'Arabic';
  if (['en', 'eng', 'english', '英文', '英语'].includes(normalized)) return 'en';
  if (['zh', 'zho', 'chi', 'chinese', 'cn', 'zh-cn', '中文', '简体中文'].includes(normalized)) return 'zh';
  return normalized;
}

function directionFromLangs(sourceLang?: string, targetLang?: string): TranslationDirection | 'bidirectional' | undefined {
  if (sourceLang && targetLang && sourceLang !== 'en' && sourceLang !== 'zh' && targetLang !== 'en' && targetLang !== 'zh') {
    return `${sourceLang}-${targetLang}`;
  }
  if (sourceLang === 'English' && targetLang === 'Simplified Chinese') return 'en-zh';
  if (sourceLang === 'Simplified Chinese' && targetLang === 'English') return 'zh-en';
  if (sourceLang === 'en' && targetLang === 'zh') return 'en-zh';
  if (sourceLang === 'zh' && targetLang === 'en') return 'zh-en';
  return undefined;
}

function normalizeLangLabel(value?: string): string | undefined {
  return value ? normalizeGlossaryLang(value) : undefined;
}

function sameLang(a?: string, b?: string): boolean {
  const left = normalizeLangLabel(a);
  const right = normalizeLangLabel(b);
  return Boolean(left && right && left === right);
}

function inferLegacyTermLanguages(term: GlossaryTerm): { sourceLang?: string; targetLang?: string } {
  const source = term.source || '';
  const target = term.target || '';
  const sourceHasCjk = /[\u3400-\u9fff]/.test(source);
  const targetHasCjk = /[\u3400-\u9fff]/.test(target);
  const sourceHasLatin = /[A-Za-z]/.test(source);
  const targetHasLatin = /[A-Za-z]/.test(target);
  if (sourceHasLatin && targetHasCjk) return { sourceLang: 'English', targetLang: 'Simplified Chinese' };
  if (sourceHasCjk && targetHasLatin) return { sourceLang: 'Simplified Chinese', targetLang: 'English' };
  if (sourceHasCjk && targetHasCjk) return { sourceLang: 'Simplified Chinese', targetLang: 'Simplified Chinese' };
  return {};
}

function swapGlossaryTerm(term: GlossaryTerm): GlossaryTerm {
  return {
    ...term,
    source: term.target,
    target: term.source,
    sourceLang: term.targetLang,
    targetLang: term.sourceLang,
    direction: term.direction === 'bidirectional'
      ? 'bidirectional'
      : directionFromLangs(term.targetLang, term.sourceLang)
  };
}

function orientGlossaryTermForLanguagePair(term: GlossaryTerm, sourceLang: string, targetLang: string): GlossaryTerm[] {
  if (!term.source || !term.target) return [];
  const hasLangs = Boolean(term.sourceLang || term.targetLang);
  const directMatch = sameLang(term.sourceLang, sourceLang) && sameLang(term.targetLang, targetLang);
  const reverseMatch = sameLang(term.sourceLang, targetLang) && sameLang(term.targetLang, sourceLang);

  if (directMatch) return [term];
  if ((term.direction === 'bidirectional' || reverseMatch) && reverseMatch) return [swapGlossaryTerm(term)];
  if (hasLangs) return [];

  const inferred = inferLegacyTermLanguages(term);
  if (inferred.sourceLang || inferred.targetLang) {
    const inferredDirect = sameLang(inferred.sourceLang, sourceLang) && sameLang(inferred.targetLang, targetLang);
    const inferredReverse = sameLang(inferred.sourceLang, targetLang) && sameLang(inferred.targetLang, sourceLang);
    if (inferredDirect) return [term];
    if (term.direction === 'bidirectional' && inferredReverse) return [swapGlossaryTerm(term)];
    return [];
  }

  if (term.direction !== 'bidirectional') return [term];
  if (term.source.trim().toLowerCase() === term.target.trim().toLowerCase()) return [term];
  return [term, swapGlossaryTerm(term)];
}

export function orientGlossaryForLanguagePair(
  terms: GlossaryTerm[],
  sourceLang: string,
  targetLang: string
): GlossaryTerm[] {
  return terms.flatMap(term => orientGlossaryTermForLanguagePair(term, sourceLang, targetLang));
}

function rowsToTerms(rows: string[][]): { terms: GlossaryTerm[]; skippedRows: number } {
  let skippedRows = 0;
  if (rows.length === 0) return { terms: [], skippedRows };

  const header = rows[0].map(h => h.toLowerCase());
  const sourceIndex = header.findIndex(h => /source|english|英文|缩写|原文|term/.test(h));
  const targetIndex = header.findIndex(h => /target|chinese|中文|翻译|译文/.test(h));
  const categoryIndex = header.findIndex(h => /category|type|分类|类别|domain/.test(h));
  const explanationIndex = header.findIndex(h => /note|备注|场景|description|explanation|说明|full.?form|context/.test(h));

  const startRow = sourceIndex >= 0 && targetIndex >= 0 ? 1 : 0;
  const sIdx = sourceIndex >= 0 ? sourceIndex : 0;
  const tIdx = targetIndex >= 0 ? targetIndex : 1;
  const cIdx = categoryIndex >= 0 ? categoryIndex : -1;
  const eIdx = explanationIndex >= 0 ? explanationIndex : 2;
  const hasLanguageColumnsWithoutHeader = startRow === 0
    && rows[0].length >= 4
    && Boolean(normalizeGlossaryLang(rows[0][2] || ''))
    && Boolean(normalizeGlossaryLang(rows[0][3] || ''));
  const slIdx = hasLanguageColumnsWithoutHeader ? 2 : -1;
  const tlIdx = hasLanguageColumnsWithoutHeader ? 3 : -1;

  const terms: GlossaryTerm[] = [];
  const seen = new Set<string>();

  for (const row of rows.slice(startRow)) {
    const source = (row[sIdx] || '').trim();
    const target = (row[tIdx] || '').trim();
    const category = cIdx >= 0 ? (row[cIdx] || '').trim() : '';
    const explanation = hasLanguageColumnsWithoutHeader ? '' : (row[eIdx] || '').trim();
    const sourceLang = slIdx >= 0 ? normalizeGlossaryLang(row[slIdx] || '') : undefined;
    const targetLang = tlIdx >= 0 ? normalizeGlossaryLang(row[tlIdx] || '') : undefined;
    const direction = directionFromLangs(sourceLang, targetLang);

    if (!source || !target) {
      skippedRows++;
      continue;
    }

    const key = `${source.toLowerCase()}::${target.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push({
      source,
      target,
      category: category || undefined,
      explanation: explanation || undefined,
      sourceLang,
      targetLang,
      direction,
      origin: 'imported',
      status: 'active'
    });
  }

  return { terms, skippedRows };
}

async function parseDocxGlossary(buffer: Buffer): Promise<{ terms: GlossaryTerm[]; skippedRows: number }> {
  const zip = await JSZip.loadAsync(buffer);
  const documentXml = await zip.file('word/document.xml')?.async('string');
  if (!documentXml) throw new Error('DOCX glossary is missing word/document.xml');

  const doc = new DOMParser().parseFromString(documentXml, 'text/xml');
  const tableNodes = Array.from(doc.getElementsByTagName('w:tbl'));
  const rows: string[][] = [];

  for (const table of tableNodes) {
    const trNodes = Array.from(table.getElementsByTagName('w:tr'));
    for (const tr of trNodes) {
      const cells = Array.from(tr.getElementsByTagName('w:tc')).map(textContent);
      if (cells.some(Boolean)) rows.push(cells);
    }
  }

  return rowsToTerms(rows);
}

async function parseXlsxGlossary(buffer: Buffer): Promise<{ terms: GlossaryTerm[]; skippedRows: number }> {
  const zip = await JSZip.loadAsync(buffer);
  const sharedStringsXml = await zip.file('xl/sharedStrings.xml')?.async('string');
  const sharedStrings: string[] = [];

  if (sharedStringsXml) {
    const sharedDoc = new DOMParser().parseFromString(sharedStringsXml, 'text/xml');
    for (const si of Array.from(sharedDoc.getElementsByTagName('si'))) {
      sharedStrings.push(textContent(si));
    }
  }

  const workbookRels = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
  const workbookXml = await zip.file('xl/workbook.xml')?.async('string');
  let sheetPath = 'xl/worksheets/sheet1.xml';

  if (workbookXml && workbookRels) {
    const workbookDoc = new DOMParser().parseFromString(workbookXml, 'text/xml');
    const firstSheet = workbookDoc.getElementsByTagName('sheet')[0];
    const relId = firstSheet?.getAttribute('r:id');
    if (relId) {
      const relsDoc = new DOMParser().parseFromString(workbookRels, 'text/xml');
      const rel = Array.from(relsDoc.getElementsByTagName('Relationship')).find(r => r.getAttribute('Id') === relId);
      const target = rel?.getAttribute('Target');
      if (target) sheetPath = `xl/${target.replace(/^\/?xl\//, '')}`;
    }
  }

  const sheetXml = await zip.file(sheetPath)?.async('string');
  if (!sheetXml) throw new Error('XLSX glossary is missing the first worksheet XML');

  const sheetDoc = new DOMParser().parseFromString(sheetXml, 'text/xml');
  const rows: string[][] = [];

  for (const rowNode of Array.from(sheetDoc.getElementsByTagName('row'))) {
    const row: string[] = [];
    for (const cellNode of Array.from(rowNode.getElementsByTagName('c'))) {
      const type = cellNode.getAttribute('t');
      const value = textContent(cellNode.getElementsByTagName('v')[0]);
      const inlineValue = textContent(cellNode.getElementsByTagName('is')[0]);
      row.push(type === 's' ? (sharedStrings[Number(value)] || '') : (inlineValue || value));
    }
    if (row.some(Boolean)) rows.push(row);
  }

  return rowsToTerms(rows);
}

export async function parseGlossaryFile(filePath: string, originalName: string): Promise<{ terms: GlossaryTerm[]; skippedRows: number }> {
  const ext = path.extname(originalName).toLowerCase();
  const buffer = fs.readFileSync(filePath);

  if (ext === '.csv') {
    return rowsToTerms(parseCsv(decodeCsvBuffer(buffer)));
  }

  throw new Error('Unsupported glossary format. Please upload a comma-separated .csv file.');
}

export function buildGlossaryImportPreview(incoming: GlossaryTerm[], existing: GlossaryTerm[], skippedRows = 0): GlossaryImportPreview {
  const existingByExact = new Map(existing.map(term => [glossaryTermKey(term), term]));
  const existingBySource = new Map<string, GlossaryTerm[]>();
  for (const term of existing) {
    const sourceKey = glossarySourceKey(term);
    existingBySource.set(sourceKey, [...(existingBySource.get(sourceKey) || []), term]);
  }
  const additions: GlossaryTerm[] = [];
  const conflicts: GlossaryConflict[] = [];

  for (const term of incoming) {
    const exactTerm = existingByExact.get(glossaryTermKey(term));
    if (exactTerm) {
      continue;
    }

    const sameSourceTerms = existingBySource.get(glossarySourceKey(term)) || [];
    if (sameSourceTerms.length === 0) {
      additions.push(term);
      continue;
    }

    conflicts.push({ source: term.source, existing: sameSourceTerms[0], incoming: term });
  }

  return { terms: incoming, additions, conflicts, skippedRows };
}

export function mergeGlossaryTerms(existing: GlossaryTerm[], incoming: GlossaryTerm[], conflictStrategy: 'skip' | 'overwrite' = 'skip'): GlossaryTerm[] {
  const merged = [...existing];

  for (const term of incoming) {
    const index = merged.findIndex(existingTerm => glossaryTermKey(existingTerm) === glossaryTermKey(term));
    if (index < 0) {
      const hasSameSource = merged.some(existingTerm => glossarySourceKey(existingTerm) === glossarySourceKey(term));
      if (!hasSameSource || conflictStrategy === 'overwrite') {
        merged.push(term);
      }
      continue;
    }

    if (conflictStrategy === 'overwrite') {
      merged[index] = term;
    }
  }

  return merged;
}

export function containsSourceTerm(text: string, source: string): boolean {
  const escapeRegExp = (value: string) => value.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  const isCjk = /[\u3400-\u9fff]/.test(source);
  if (isCjk) {
    return text.toLowerCase().includes(source.toLowerCase());
  }

  const compactSource = source.trim();
  if (!compactSource) return false;

  const words = compactSource.split(/\s+/);
  const lastWord = words[words.length - 1];
  const prefix = words.slice(0, -1).map(escapeRegExp).join('\\s+');
  const suffixPattern = /^[a-z]+$/i.test(lastWord) && lastWord.length >= 4
    ? (lastWord.toLowerCase().endsWith('e')
      ? `${escapeRegExp(lastWord.slice(0, -1))}(?:e|es|ed|ing|ion|ions|ive|ives|er|ers)?`
      : `${escapeRegExp(lastWord)}(?:s|es|ed|ing|ion|ions|ive|ives|er|ers)?`)
    : escapeRegExp(lastWord);
  const pattern = words.length > 1
    ? `${prefix}\\s+${suffixPattern}`
    : suffixPattern;

  return new RegExp(`\\b${pattern}\\b`, 'i').test(text);
}

function containsTarget(text: string, target: string): boolean {
  const variants = [
    target,
    target.replace(/（.*?）/g, '').trim(),
    target.replace(/\(.*?\)/g, '').trim()
  ].filter(Boolean);
  return variants.some(variant => text.toLowerCase().includes(variant.toLowerCase()));
}

export interface SegmentTermInput {
  segmentId: string;
  sourceText: string;
}

export type GlossaryConflictDecisionMap = Record<string, {
  source: string;
  segmentId?: string;
  target?: string;
  mode: 'strict' | 'candidate' | 'skipped';
  scope: 'segment' | 'page' | 'context' | 'project';
  note?: string;
  updatedAt: string;
}>;

function hintFromTerm(term: GlossaryTerm, mode: SegmentTermHint['mode']): SegmentTermHint {
  return {
    source: term.source,
    target: term.target,
    explanation: term.explanation || (term as any).description,
    usageNote: term.usageNote,
    category: term.category,
    mode,
    confidence: term.confidence,
    reason: term.reason,
    sourceLibraryId: term.libraryId,
    sourceLibraryName: term.libraryName
  };
}

/**
 * Resolves the effective terminology for each write-back segment. Matching is
 * deterministic and happens before the AI request, so a batch never receives
 * unrelated glossary rows.
 */
export function buildSegmentTermHints(
  segments: SegmentTermInput[],
  glossary: GlossaryTerm[],
  decisions: GlossaryConflictDecisionMap = {}
): Record<string, SegmentTermHint[]> {
  const termsBySource = new Map<string, GlossaryTerm[]>();
  for (const term of glossary) {
    if (!term.source || !term.target) continue;
    const key = term.source.trim().toLowerCase();
    termsBySource.set(key, [...(termsBySource.get(key) || []), term]);
  }

  const sortedTerms = Array.from(termsBySource.entries()).sort((a, b) => b[0].length - a[0].length);
  const output: Record<string, SegmentTermHint[]> = {};

  for (const segment of segments) {
    const hints: SegmentTermHint[] = [];
    const matchedSources = sortedTerms
      .map(([, sourceTerms]) => sourceTerms[0]?.source || '')
      .filter(source => containsSourceTerm(segment.sourceText || '', source));
    for (const [, sourceTerms] of sortedTerms) {
      const representative = sourceTerms[0];
      if (!containsSourceTerm(segment.sourceText || '', representative.source)) continue;
      const nestedInLongerTerm = matchedSources.some(source =>
        source.toLowerCase() !== representative.source.toLowerCase()
        && source.toLowerCase().includes(representative.source.toLowerCase())
      );
      if (nestedInLongerTerm) continue;

      const sourceKey = representative.source.trim().toLowerCase();
      const decision = decisions[`${sourceKey}::segment:${segment.segmentId}`] || decisions[sourceKey];
      if (decision?.mode === 'skipped') continue;

      const selectedTerms = decision?.target
        ? sourceTerms.filter(term => term.target.trim().toLowerCase() === decision.target!.trim().toLowerCase())
        : [];
      const activeTerms = sourceTerms.filter(term =>
        term.status !== 'candidate' && term.status !== 'ambiguous' && term.status !== 'needs_review'
      );
      const aiSelectedTerm = activeTerms.find(term => term.status === 'ai_selected');
      const targets = new Set(sourceTerms.map(term => term.target.trim().toLowerCase()));
      const hasConflict = targets.size > 1;

      if (selectedTerms.length > 0) {
        hints.push(hintFromTerm(selectedTerms[0], decision?.mode === 'candidate' ? 'candidate' : 'strict'));
      } else if (decision?.mode === 'candidate') {
        for (const term of sourceTerms) hints.push(hintFromTerm(term, 'candidate'));
      } else if (aiSelectedTerm) {
        hints.push(hintFromTerm(aiSelectedTerm, 'strict'));
      } else if (activeTerms.length === 1 && !hasConflict) {
        hints.push(hintFromTerm(activeTerms[0], 'strict'));
      } else if (activeTerms.length === 1 && !sourceTerms.some(term => term.status === 'candidate' || term.status === 'ambiguous' || term.status === 'needs_review')) {
        hints.push(hintFromTerm(activeTerms[0], 'strict'));
      } else {
        for (const term of sourceTerms) hints.push(hintFromTerm(term, 'candidate'));
      }
    }

    if (hints.length > 0) {
      const unique = new Map<string, SegmentTermHint>();
      for (const hint of hints) {
        const key = `${hint.source.toLowerCase()}::${hint.target.toLowerCase()}::${hint.mode || 'strict'}`;
        unique.set(key, hint);
      }
      output[segment.segmentId] = Array.from(unique.values());
    }
  }

  return output;
}

/** Validates only strict hints attached to the segment that produced a translation. */
export function validateSegmentTermHints(
  textItems: ExtractedTextItem[],
  translationBySegmentId: Record<string, string> = {},
  segmentTermHints: Record<string, SegmentTermHint[]> = {}
): GlossaryValidationReport {
  const findings: GlossaryValidationFinding[] = [];
  let hits = 0;
  let misses = 0;

  for (const item of textItems) {
    const segmentId = item.segmentId || item.id;
    const hints = segmentTermHints[segmentId] || [];
    const translatedText = translationBySegmentId[segmentId] || item.translatedText || '';
    for (const hint of hints) {
      if (hint.mode !== 'strict' || !containsSourceTerm(item.originalText || '', hint.source)) continue;
      const passed = containsTarget(translatedText, hint.target);
      if (passed) hits++;
      else misses++;
      findings.push({
        status: passed ? 'PASS' : 'GLOSSARY_MISS',
        itemId: item.id,
        slideNum: item.slideNum,
        source: hint.source,
        expectedTarget: hint.target,
        originalText: item.originalText,
        translatedText,
        explanation: hint.explanation || hint.usageNote,
        category: hint.category
      });
    }
  }

  return {
    checkedTerms: hits + misses,
    hits,
    misses,
    findings
  };
}

function glossaryTermKey(term: GlossaryTerm): string {
  const sourceLang = normalizeLangLabel(term.sourceLang) || '*';
  const targetLang = normalizeLangLabel(term.targetLang) || '*';
  const languageKey = term.direction === 'bidirectional'
    ? [sourceLang, targetLang].sort().join('<>')
    : `${sourceLang}>${targetLang}`;
  return `${languageKey}::${term.source.toLowerCase()}::${term.target.toLowerCase()}`;
}

function glossarySourceKey(term: GlossaryTerm): string {
  const sourceLang = normalizeLangLabel(term.sourceLang) || '*';
  const targetLang = normalizeLangLabel(term.targetLang) || '*';
  const languageKey = term.direction === 'bidirectional'
    ? [sourceLang, targetLang].sort().join('<>')
    : `${sourceLang}>${targetLang}`;
  return `${languageKey}::${term.source.toLowerCase()}`;
}

function normalizeProjectTerm(term: GlossaryTerm, status: GlossaryTerm['status'], usageCount: number): GlossaryTerm {
  return {
    ...term,
    category: term.category,
    explanation: term.explanation || (term as any).description,
    origin: term.origin || 'global',
    status,
    usageCount,
    checked: status === 'active' || status === 'ai_selected'
  };
}

function orientBidirectionalGlossaryTerms(term: GlossaryTerm): GlossaryTerm[] {
  if (!term.source || !term.target) return [];

  const forward: GlossaryTerm = {
    ...term,
    source: term.source,
    target: term.target,
    sourceLang: undefined,
    targetLang: undefined,
    direction: 'bidirectional'
  };

  if (term.source.trim().toLowerCase() === term.target.trim().toLowerCase()) {
    return [forward];
  }

  return [
    forward,
    {
      ...term,
      source: term.target,
      target: term.source,
      sourceLang: undefined,
      targetLang: undefined,
      direction: 'bidirectional'
    }
  ];
}

export function linkGlobalGlossaryToProject(
  textItems: ExtractedTextItem[],
  globalGlossary: GlossaryTerm[],
  sourceLang = 'English',
  targetLang = 'Simplified Chinese'
): ProjectGlossaryLinkResult {
  const matchesBySource = new Map<string, {
    source: string;
    occurrences: { slideNum: number; text: string }[];
    termsByTarget: Map<string, GlossaryTerm>;
    usageCount: number;
  }>();

  const sortedGlossary = globalGlossary
    .flatMap(term => orientGlossaryTermForLanguagePair(term, sourceLang, targetLang))
    .sort((a, b) => b.source.length - a.source.length);

  for (const term of sortedGlossary) {
    if (!term.source || !term.target) continue;
    for (const item of textItems) {
      if (!containsSourceTerm(item.originalText || '', term.source)) continue;
      const sourceKey = term.source.toLowerCase();
      if (!matchesBySource.has(sourceKey)) {
        matchesBySource.set(sourceKey, {
          source: term.source,
          occurrences: [],
          termsByTarget: new Map(),
          usageCount: 0
        });
      }
      const bucket = matchesBySource.get(sourceKey)!;
      bucket.usageCount++;
      if (bucket.occurrences.length < 6) {
        bucket.occurrences.push({ slideNum: item.slideNum, text: item.originalText });
      }
      bucket.termsByTarget.set(term.target.toLowerCase(), term);
    }
  }

  const terms: GlossaryTerm[] = [];
  const reviewCandidates: ProjectGlossaryReviewCandidate[] = [];

  for (const bucket of matchesBySource.values()) {
    const candidates = Array.from(bucket.termsByTarget.values());
    if (candidates.length === 1) {
      terms.push(normalizeProjectTerm(candidates[0], 'active', bucket.usageCount));
      continue;
    }

    const ambiguousTerms = candidates.map(term => normalizeProjectTerm(term, 'ambiguous', bucket.usageCount));
    terms.push(...ambiguousTerms);
    reviewCandidates.push({
      source: bucket.source,
      occurrences: bucket.occurrences,
      candidates: ambiguousTerms,
      status: 'ambiguous'
    });
  }

  return { terms, reviewCandidates };
}

export function mergeProjectGlossaryTerms(...groups: GlossaryTerm[][]): GlossaryTerm[] {
  const merged = new Map<string, GlossaryTerm>();
  const sourceSeen = new Set<string>();

  for (const group of groups) {
    for (const rawTerm of group) {
      if (!rawTerm.source || !rawTerm.target) continue;
      const sourceKey = glossarySourceKey(rawTerm);
      const key = glossaryTermKey(rawTerm);
      const hasSameSource = sourceSeen.has(sourceKey);
      const term: GlossaryTerm = {
        ...rawTerm,
        category: rawTerm.category || (rawTerm as any).description,
        explanation: rawTerm.explanation || (rawTerm as any).description,
        status: rawTerm.status || (hasSameSource ? 'candidate' : 'active'),
        origin: rawTerm.origin || 'ai',
        checked: rawTerm.checked ?? (!hasSameSource)
      };

      if (merged.has(key)) {
        merged.set(key, { ...merged.get(key)!, ...term });
      } else {
        merged.set(key, term);
      }
      sourceSeen.add(sourceKey);
    }
  }

  return Array.from(merged.values());
}

export function validateGlossaryUsage(textItems: ExtractedTextItem[], glossary: GlossaryTerm[]): GlossaryValidationReport {
  const findings: GlossaryValidationFinding[] = [];
  let hits = 0;
  let misses = 0;

  for (const item of textItems) {
    for (const term of glossary) {
      if (term.status === 'candidate' || term.status === 'ambiguous' || term.status === 'needs_review') continue;
      if (!containsSourceTerm(item.originalText || '', term.source)) continue;

      const passed = containsTarget(item.translatedText || '', term.target);
      if (passed) hits++;
      else misses++;

      findings.push({
        status: passed ? 'PASS' : 'GLOSSARY_MISS',
        itemId: item.id,
        slideNum: item.slideNum,
        source: term.source,
        expectedTarget: term.target,
        originalText: item.originalText,
        translatedText: item.translatedText,
        explanation: term.explanation || (term as any).description,
        category: term.category
      });
    }
  }

  return {
    checkedTerms: glossary.length,
    hits,
    misses,
    findings
  };
}
