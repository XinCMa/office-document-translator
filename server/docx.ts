import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

export interface ExtractedDocxParagraph {
  slideNum: number;
  slidePath: string;
  partPath: string;
  partType: 'document' | 'diagram';
  p_idx: number;
  originalText: string;
}

export interface DOCXStats {
  slideCount: number;
  mediaCount: number;
  paragraphs: ExtractedDocxParagraph[];
}

const DOCX_TEXT_PARTS = [
  /^word\/document\.xml$/,
  /^word\/header\d+\.xml$/,
  /^word\/footer\d+\.xml$/,
  /^word\/footnotes\.xml$/,
  /^word\/endnotes\.xml$/,
  /^word\/comments\.xml$/
];
const DOCX_DIAGRAM_DATA_PARTS = [
  /^word\/diagrams\/data.*\.xml$/
];
const DOCX_DIAGRAM_DRAWING_PARTS = [
  /^word\/diagrams\/drawing.*\.xml$/
];
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const DGM_NS = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const CODEISH_RE = /^([A-Z0-9_/.-]{2,}|[A-Z]{1,4}\d{1,4}[A-Z]?|\/[A-Z][A-Za-z0-9_/.-]+)$/;
const LAYOUT_SPACE_RE = / {6,}/g;
const EAST_ASIAN_TEXT_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const PAGE_FIELD_LABEL_RE = /^(p|page|age|of)$/i;
const PLACEHOLDER_RE = /^\s*(Title Text Appears Here|标题文本显示在此处)\s*$/i;

// Layout profile per CJK target language. Chinese localizes PAGE field labels
// ("第 X 页，共 Y 页"); Japanese/Korean keep the original labels because their
// conventional page-number rendering differs and guessing a label risks mojibake-like
// output. Fonts and lang tags follow the default CJK font of each locale.
interface CjkLayout {
  eastAsiaFont: string;
  eastAsiaLang: string;
  pageLabels: { prefix: string; between: string; suffix: string } | null;
}

function resolveCjkLayout(targetLanguage?: string): CjkLayout | null {
  const language = String(targetLanguage || '').trim().toLowerCase();
  if (language.startsWith('zh') || language.includes('chinese')) {
    return {
      eastAsiaFont: '微软雅黑',
      eastAsiaLang: 'zh-CN',
      pageLabels: { prefix: '第 ', between: ' 页，共 ', suffix: ' 页' }
    };
  }
  if (language.startsWith('ja') || language.includes('japanese')) {
    return { eastAsiaFont: '游ゴシック', eastAsiaLang: 'ja-JP', pageLabels: null };
  }
  if (language.startsWith('ko') || language.includes('korean')) {
    return { eastAsiaFont: '맑은 고딕', eastAsiaLang: 'ko-KR', pageLabels: null };
  }
  return null;
}

function isDocxTextPart(path: string): boolean {
  return DOCX_TEXT_PARTS.some(pattern => pattern.test(path))
    || DOCX_DIAGRAM_DATA_PARTS.some(pattern => pattern.test(path))
    || DOCX_DIAGRAM_DRAWING_PARTS.some(pattern => pattern.test(path));
}

function isDocxDiagramDataPart(path: string): boolean {
  return DOCX_DIAGRAM_DATA_PARTS.some(pattern => pattern.test(path));
}

function isDocxDiagramDrawingPart(path: string): boolean {
  return DOCX_DIAGRAM_DRAWING_PARTS.some(pattern => pattern.test(path));
}

function getDiagramDrawingPartPath(dataPartPath: string): string | null {
  const match = dataPartPath.match(/^word\/diagrams\/data(.*)\.xml$/);
  return match ? `word/diagrams/drawing${match[1]}.xml` : null;
}

function decodeXmlText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, char => {
    switch (char) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case "'": return '&apos;';
      case '"': return '&quot;';
      default: return char;
    }
  });
}

function normalizeText(text: string): string {
  return text.replace(/[^\S\t]+/g, ' ').replace(/ *\t */g, '\t').trim();
}

function normalizeLayoutText(text: string): string {
  let compact = text.replace(LAYOUT_SPACE_RE, ' ');
  compact = compact.trim();
  if (!compact) return '';

  if (compact.length % 2 === 0) {
    const midpoint = compact.length / 2;
    if (compact.slice(0, midpoint) === compact.slice(midpoint)) {
      compact = compact.slice(0, midpoint);
    }
  }

  const parts = compact.split(' ');
  for (let size = 1; size <= Math.floor(parts.length / 2); size++) {
    if (parts.length === size * 2 && parts.slice(0, size).join(' ') === parts.slice(size).join(' ')) {
      compact = parts.slice(0, size).join(' ');
      break;
    }
  }

  return compact.trim();
}

function shouldExposeText(text: string): boolean {
  const stripped = text.trim();
  if (!stripped) return false;
  if (PLACEHOLDER_RE.test(stripped)) return false;
  if (CODEISH_RE.test(stripped)) return false;
  return /[A-Za-z\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(stripped);
}

function localNameOf(node: any): string {
  const raw = node?.localName || node?.nodeName || '';
  return String(raw).includes(':') ? String(raw).split(':').pop() || '' : String(raw);
}

function prefixOf(node: any): string {
  const raw = String(node?.prefix || node?.nodeName || '');
  return raw.includes(':') ? raw.split(':')[0] : raw;
}

function isWordElement(node: any, localName: string): boolean {
  return node?.nodeType === 1
    && localNameOf(node) === localName
    && (!node.namespaceURI || node.namespaceURI === W_NS || String(node.nodeName || '').startsWith('w:'));
}

function isDrawingElement(node: any, localName: string): boolean {
  return node?.nodeType === 1
    && localNameOf(node) === localName
    && (node.namespaceURI === A_NS || prefixOf(node) === 'a');
}

function isDiagramElement(node: any, localName: string): boolean {
  return node?.nodeType === 1
    && localNameOf(node) === localName
    && (node.namespaceURI === DGM_NS || prefixOf(node) === 'dgm');
}

function getWordAttr(node: any, name: string): string | null {
  return node?.getAttribute?.(`w:${name}`) || node?.getAttributeNS?.(W_NS, name) || null;
}

function setWordAttr(node: any, name: string, value: string): void {
  node.setAttribute(`w:${name}`, value);
}

function getFirstWordChild(node: any, localName: string): any | null {
  for (let i = 0; i < (node.childNodes?.length || 0); i++) {
    const child = node.childNodes.item(i);
    if (isWordElement(child, localName)) return child;
  }
  return null;
}

function getOrCreateWordChild(node: any, localName: string): any {
  const existing = getFirstWordChild(node, localName);
  if (existing) return existing;

  const doc = node.ownerDocument || node;
  const child = doc.createElementNS(W_NS, `w:${localName}`);
  node.insertBefore(child, node.firstChild || null);
  return child;
}

function getAncestorWordElement(node: any, localName: string): any | null {
  let current = node?.parentNode || null;
  while (current) {
    if (isWordElement(current, localName)) return current;
    current = current.parentNode;
  }
  return null;
}

function isInsideWordElement(node: any, localName: string): boolean {
  return Boolean(getAncestorWordElement(node, localName));
}

function removeWordChildren(node: any, localName: string): void {
  const toRemove: any[] = [];
  for (let i = 0; i < (node.childNodes?.length || 0); i++) {
    const child = node.childNodes.item(i);
    if (isWordElement(child, localName)) toRemove.push(child);
  }
  toRemove.forEach(child => node.removeChild(child));
}

function parseWordNumber(node: any, name: string): number | null {
  const raw = getWordAttr(node, name);
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function getTextNodesUnder(node: any): any[] {
  const out: any[] = [];
  const visit = (current: any) => {
    if (current !== node && (isWordElement(current, 'pPr') || isWordElement(current, 'rPr'))) return;
    if (isWordElement(current, 't') || isWordElement(current, 'tab')) {
      out.push(current);
      return;
    }
    for (let i = 0; i < (current.childNodes?.length || 0); i++) {
      visit(current.childNodes.item(i));
    }
  };
  visit(node);
  return out;
}

function getDirectRunTextNodes(paragraph: any): any[] {
  const out: any[] = [];
  for (let i = 0; i < (paragraph.childNodes?.length || 0); i++) {
    const child = paragraph.childNodes.item(i);
    if (isWordElement(child, 'r')) {
      out.push(...getTextNodesUnder(child));
    }
  }
  return out.filter(node => getAncestorWordElement(node, 'p') === paragraph);
}

function getFieldInstructionText(paragraph: any): string {
  const instructions: string[] = [];
  const visit = (current: any) => {
    if (isWordElement(current, 'instrText')) {
      instructions.push(current.textContent || '');
      return;
    }
    for (let i = 0; i < (current.childNodes?.length || 0); i++) {
      visit(current.childNodes.item(i));
    }
  };
  visit(paragraph);
  return instructions.join(' ');
}

function getFieldAwareTextNodes(paragraph: any): any[] {
  const hasPageField = /\b(PAGE|NUMPAGES)\b/i.test(getFieldInstructionText(paragraph));
  const out: any[] = [];
  let fieldDepth = 0;
  let inFieldResult = false;

  const visit = (current: any) => {
    if (current !== paragraph && (isWordElement(current, 'pPr') || isWordElement(current, 'rPr'))) return;
    if (isWordElement(current, 'fldChar')) {
      const fieldType = getWordAttr(current, 'fldCharType');
      if (fieldType === 'begin') {
        fieldDepth += 1;
        inFieldResult = false;
      } else if (fieldType === 'separate' && fieldDepth > 0) {
        inFieldResult = true;
      } else if (fieldType === 'end' && fieldDepth > 0) {
        fieldDepth -= 1;
        if (fieldDepth === 0) inFieldResult = false;
      }
      return;
    }

    if (isWordElement(current, 't') || isWordElement(current, 'tab')) {
      if (fieldDepth > 0 && inFieldResult) return;
      const normalized = isWordElement(current, 'tab') ? '\t' : normalizeText(current.textContent || '');
      if (hasPageField && (!normalized || PAGE_FIELD_LABEL_RE.test(normalized))) return;
      out.push(current);
      return;
    }

    for (let i = 0; i < (current.childNodes?.length || 0); i++) {
      visit(current.childNodes.item(i));
    }
  };

  visit(paragraph);
  return out;
}

function getNonFieldResultTextNodes(paragraph: any): any[] {
  const out: any[] = [];
  let fieldDepth = 0;
  let inFieldResult = false;

  const visit = (current: any) => {
    if (current !== paragraph && (isWordElement(current, 'pPr') || isWordElement(current, 'rPr'))) return;
    if (isWordElement(current, 'fldChar')) {
      const fieldType = getWordAttr(current, 'fldCharType');
      if (fieldType === 'begin') {
        fieldDepth += 1;
        inFieldResult = false;
      } else if (fieldType === 'separate' && fieldDepth > 0) {
        inFieldResult = true;
      } else if (fieldType === 'end' && fieldDepth > 0) {
        fieldDepth -= 1;
        if (fieldDepth === 0) inFieldResult = false;
      }
      return;
    }

    if (isWordElement(current, 't') || isWordElement(current, 'tab')) {
      if (!(fieldDepth > 0 && inFieldResult)) out.push(current);
      return;
    }

    for (let i = 0; i < (current.childNodes?.length || 0); i++) {
      visit(current.childNodes.item(i));
    }
  };

  visit(paragraph);
  return out;
}

function hasNestedParagraph(paragraph: any): boolean {
  let found = false;
  const visit = (node: any) => {
    for (let i = 0; i < (node.childNodes?.length || 0); i++) {
      const child = node.childNodes.item(i);
      if (isWordElement(child, 'p')) {
        found = true;
        return;
      }
      visit(child);
      if (found) return;
    }
  };
  visit(paragraph);
  return found;
}

function paragraphTextFromNodes(textNodes: any[]): string {
  return normalizeText(textNodes.map(node => isWordElement(node, 'tab') ? '\t' : (node.textContent || '')).join(''));
}

function selectVisibleTextNodes(paragraph: any): any[] {
  const fieldInstructions = getFieldInstructionText(paragraph);
  if (/\b(TOC|PAGEREF)\b/i.test(fieldInstructions)) return [];

  const directTextNodes = getDirectRunTextNodes(paragraph);
  if (directTextNodes.length > 0 && paragraphTextFromNodes(directTextNodes).trim()) return directTextNodes;
  if (hasNestedParagraph(paragraph)) return [];
  return getFieldAwareTextNodes(paragraph);
}

function visibleTextForNode(node: any): string {
  return isWordElement(node, 'tab') ? '\t' : (node.textContent || '');
}

function getDuplicatedTextNodeGroups(textNodes: any[]): any[][] | null {
  if (textNodes.length < 4 || textNodes.length % 2 !== 0) return null;

  const midpoint = textNodes.length / 2;
  const firstGroup = textNodes.slice(0, midpoint);
  const secondGroup = textNodes.slice(midpoint);
  const firstText = firstGroup.map(visibleTextForNode);
  const secondText = secondGroup.map(visibleTextForNode);

  const firstVisible = normalizeText(firstText.join(''));
  const secondVisible = normalizeText(secondText.join(''));
  if (!firstVisible || firstVisible !== secondVisible) return null;

  const sameRunShape = firstText.every((text, index) => normalizeText(text) === normalizeText(secondText[index] || ''));
  return sameRunShape ? [firstGroup, secondGroup] : null;
}

function ensureEastAsianFontForTextNode(textNode: any, text: string, layout: CjkLayout): void {
  if (!EAST_ASIAN_TEXT_RE.test(text) || !isWordElement(textNode, 't')) return;

  const run = getAncestorWordElement(textNode, 'r');
  if (!run) return;

  const rPr = getOrCreateWordChild(run, 'rPr');
  const rFonts = getOrCreateWordChild(rPr, 'rFonts');
  setWordAttr(rFonts, 'eastAsia', layout.eastAsiaFont);
}

function setTextNodeContent(node: any, text: string): void {
  node.textContent = text;
  if (isWordElement(node, 't') || isDrawingElement(node, 't')) {
    node.setAttributeNS(XML_NS, 'xml:space', 'preserve');
  }
}

function applyTextToNodes(textNodes: any[], translatedText: string): void {
  const insertAfter = (referenceNode: any, newNode: any) => {
    referenceNode.parentNode.insertBefore(newNode, referenceNode.nextSibling || null);
  };
  const clearNode = (node: any) => {
    if (isWordElement(node, 'tab')) {
      node.parentNode?.removeChild(node);
    } else {
      setTextNodeContent(node, '');
    }
  };

  const applyTextToGroup = (nodes: any[]) => {
    const firstNode = nodes[0];
    if (!firstNode) return;

    if ((translatedText.includes('\t') || isWordElement(firstNode, 'tab')) && (isWordElement(firstNode, 't') || isWordElement(firstNode, 'tab'))) {
      const doc = firstNode.ownerDocument || firstNode;
      const parent = firstNode.parentNode;
      let textNode = firstNode;
      if (isWordElement(firstNode, 'tab')) {
        textNode = doc.createElementNS(W_NS, 'w:t');
        parent.insertBefore(textNode, firstNode);
        parent.removeChild(firstNode);
      }

      const segments = translatedText.split('\t');
      setTextNodeContent(textNode, segments[0] || '');
      let cursor = textNode;
      for (const segment of segments.slice(1)) {
        const tab = doc.createElementNS(W_NS, 'w:tab');
        insertAfter(cursor, tab);
        cursor = tab;
        if (segment) {
          const nextText = doc.createElementNS(W_NS, 'w:t');
          setTextNodeContent(nextText, segment);
          insertAfter(cursor, nextText);
          cursor = nextText;
        }
      }

      nodes.slice(1).forEach(clearNode);
      return;
    }

    nodes.forEach((node, index) => {
      if (index === 0) {
        setTextNodeContent(node, translatedText);
      } else {
        clearNode(node);
      }
    });
  };

  const duplicatedGroups = getDuplicatedTextNodeGroups(textNodes);
  if (duplicatedGroups) {
    duplicatedGroups.forEach(group => applyTextToGroup(group));
    return;
  }

  applyTextToGroup(textNodes);
}

function splitTextByWeights(text: string, weights: number[]): string[] {
  const chars = Array.from(text);
  if (weights.length === 0) return [];
  if (chars.length === 0) return weights.map(() => '');

  const totalWeight = weights.reduce((sum, weight) => sum + Math.max(1, weight), 0);
  const chunks: string[] = [];
  let cursor = 0;

  for (let index = 0; index < weights.length; index++) {
    const remainingSlots = weights.length - index - 1;
    const remainingChars = chars.length - cursor;
    if (remainingSlots === 0) {
      chunks.push(chars.slice(cursor).join(''));
      break;
    }

    const proportional = Math.round((chars.length * Math.max(1, weights[index])) / totalWeight);
    const take = Math.max(0, Math.min(remainingChars - remainingSlots, proportional));
    chunks.push(chars.slice(cursor, cursor + take).join(''));
    cursor += take;
  }

  return chunks;
}

function applyTextToTextboxNodes(textNodes: any[], translatedText: string): void {
  if (translatedText.includes('\t')) {
    applyTextToNodes(textNodes, translatedText);
    return;
  }

  const textOnlyNodes = textNodes.filter(node => isWordElement(node, 't'));
  const contentNodes = textOnlyNodes.filter(node => normalizeText(node.textContent || '').length > 0);
  if (contentNodes.length <= 1) {
    applyTextToNodes(textNodes, translatedText);
    return;
  }

  const weights = contentNodes.map(node => Math.max(1, Array.from(normalizeText(node.textContent || '')).length));
  const chunks = splitTextByWeights(translatedText, weights);
  let chunkIndex = 0;

  for (const node of textNodes) {
    if (!isWordElement(node, 't')) {
      if (isWordElement(node, 'tab')) node.parentNode?.removeChild(node);
      continue;
    }

    if (contentNodes.includes(node)) {
      setTextNodeContent(node, chunks[chunkIndex++] || '');
    } else {
      setTextNodeContent(node, '');
    }
  }
}

function serializeDocxXml(doc: any): string {
  return new XMLSerializer()
    .serializeToString(doc)
    .replace(/<(w:t|a:t)(\s[^>]*)?\/>/g, '<$1$2></$1>');
}

function getDocumentTextWidth(doc: any): number | null {
  const sectPrNodes = doc.getElementsByTagNameNS?.(W_NS, 'sectPr') || doc.getElementsByTagName?.('w:sectPr');
  const sectPr = sectPrNodes?.length ? sectPrNodes.item(sectPrNodes.length - 1) : null;
  if (!sectPr) return null;

  const pgSz = getFirstWordChild(sectPr, 'pgSz');
  const pgMar = getFirstWordChild(sectPr, 'pgMar');
  const pageWidth = pgSz ? parseWordNumber(pgSz, 'w') : null;
  if (!pageWidth) return null;

  const left = pgMar ? parseWordNumber(pgMar, 'left') || 0 : 0;
  const right = pgMar ? parseWordNumber(pgMar, 'right') || 0 : 0;
  const gutter = pgMar ? parseWordNumber(pgMar, 'gutter') || 0 : 0;
  const textWidth = pageWidth - left - right - gutter;
  return textWidth > 0 ? textWidth : null;
}

function scaleWordWidth(node: any, scale: number): void {
  const width = parseWordNumber(node, 'w');
  if (!width || width <= 0) return;
  setWordAttr(node, 'w', String(Math.max(1, Math.round(width * scale))));
}

function capTranslatedTableWidth(table: any, textWidth: number | null): void {
  if (!table) return;

  const tblPr = getOrCreateWordChild(table, 'tblPr');
  const tblLayout = getOrCreateWordChild(tblPr, 'tblLayout');
  setWordAttr(tblLayout, 'type', 'fixed');

  if (!textWidth) return;

  const tblW = getFirstWordChild(tblPr, 'tblW');
  const tblInd = getFirstWordChild(tblPr, 'tblInd');
  const grid = getFirstWordChild(table, 'tblGrid');
  const gridCols = grid
    ? Array.from({ length: grid.childNodes?.length || 0 }, (_, index) => grid.childNodes.item(index)).filter(child => isWordElement(child, 'gridCol'))
    : [];

  const declaredWidth = tblW ? parseWordNumber(tblW, 'w') : null;
  const gridWidth = gridCols.reduce((sum, col) => sum + (parseWordNumber(col, 'w') || 0), 0);
  const currentWidth = declaredWidth || gridWidth;
  if (!currentWidth) return;

  const indent = tblInd ? parseWordNumber(tblInd, 'w') || 0 : 0;
  const maxWidth = Math.max(1200, textWidth - indent);
  if (currentWidth <= maxWidth) return;

  const scale = maxWidth / currentWidth;
  if (tblW) {
    setWordAttr(tblW, 'w', String(Math.round(maxWidth)));
    setWordAttr(tblW, 'type', 'dxa');
  }
  gridCols.forEach(col => scaleWordWidth(col, scale));

  const cells = table.getElementsByTagNameNS?.(W_NS, 'tc') || table.getElementsByTagName?.('w:tc') || [];
  for (let i = 0; i < cells.length; i++) {
    const tcPr = getFirstWordChild(cells.item(i), 'tcPr');
    const tcW = tcPr ? getFirstWordChild(tcPr, 'tcW') : null;
    if (tcW) scaleWordWidth(tcW, scale);
  }
}

function localizePageFieldLabels(paragraph: any, labels: NonNullable<CjkLayout['pageLabels']>): void {
  const fieldInstructions = getFieldInstructionText(paragraph);
  if (!/\bPAGE\b/i.test(fieldInstructions)) return;

  getNonFieldResultTextNodes(paragraph).forEach(node => {
    const normalized = normalizeText(node.textContent || '').toLowerCase();
    if (normalized === 'p' || normalized === 'page') {
      node.textContent = labels.prefix;
    } else if (normalized === 'age') {
      node.textContent = '';
    } else if (normalized === 'of') {
      node.textContent = labels.between;
    }
  });

  if (/\bNUMPAGES\b/i.test(fieldInstructions) && !paragraphTextFromNodes(getTextNodesUnder(paragraph)).trim().endsWith(labels.suffix.trim())) {
    const doc = paragraph.ownerDocument || paragraph;
    const run = doc.createElementNS(W_NS, 'w:r');
    const text = doc.createElementNS(W_NS, 'w:t');
    text.textContent = labels.suffix;
    run.appendChild(text);
    paragraph.appendChild(run);
  }
}

function prepareTranslatedParagraphLayout(paragraph: any, textNodes: any[], translatedText: string, textWidth: number | null, layout: CjkLayout): void {
  if (!EAST_ASIAN_TEXT_RE.test(translatedText)) return;

  if (layout.pageLabels) localizePageFieldLabels(paragraph, layout.pageLabels);

  const pPr = getOrCreateWordChild(paragraph, 'pPr');
  const wordWrap = getOrCreateWordChild(pPr, 'wordWrap');
  setWordAttr(wordWrap, 'val', '1');

  textNodes.forEach(textNode => {
    const run = getAncestorWordElement(textNode, 'r');
    if (!run) return;
    const rPr = getOrCreateWordChild(run, 'rPr');
    const lang = getOrCreateWordChild(rPr, 'lang');
    setWordAttr(lang, 'eastAsia', layout.eastAsiaLang);
    ensureEastAsianFontForTextNode(textNode, translatedText, layout);
  });

  const cell = getAncestorWordElement(paragraph, 'tc');
  if (cell) {
    const tcPr = getFirstWordChild(cell, 'tcPr');
    if (tcPr) removeWordChildren(tcPr, 'noWrap');
  }

  capTranslatedTableWidth(getAncestorWordElement(paragraph, 'tbl'), textWidth);
}

function markFieldsDirty(doc: any): void {
  const fldChars = doc.getElementsByTagNameNS?.(W_NS, 'fldChar') || doc.getElementsByTagName?.('w:fldChar') || [];
  for (let i = 0; i < fldChars.length; i++) {
    const fldChar = fldChars.item(i);
    if (getWordAttr(fldChar, 'fldCharType') === 'begin') {
      setWordAttr(fldChar, 'dirty', 'true');
    }
  }

  const simpleFields = doc.getElementsByTagNameNS?.(W_NS, 'fldSimple') || doc.getElementsByTagName?.('w:fldSimple') || [];
  for (let i = 0; i < simpleFields.length; i++) {
    setWordAttr(simpleFields.item(i), 'dirty', 'true');
  }
}

function enableUpdateFieldsOnOpen(settingsDoc: any): void {
  const settingsNodes = settingsDoc.getElementsByTagNameNS?.(W_NS, 'settings') || settingsDoc.getElementsByTagName?.('w:settings');
  const settings = settingsNodes?.length ? settingsNodes.item(0) : settingsDoc.documentElement;
  if (!settings) return;

  const updateFields = getOrCreateWordChild(settings, 'updateFields');
  setWordAttr(updateFields, 'val', 'true');
}

function collectParagraphs(doc: any): any[] {
  const out: any[] = [];
  const visit = (node: any) => {
    if (isWordElement(node, 'p')) {
      out.push(node);
    }
    for (let i = 0; i < (node.childNodes?.length || 0); i++) {
      visit(node.childNodes.item(i));
    }
  };
  visit(doc);
  return out;
}

function isPageBreakMarker(node: any): boolean {
  if (isWordElement(node, 'lastRenderedPageBreak')) return true;
  return isWordElement(node, 'br') && getWordAttr(node, 'type') === 'page';
}

function countPageBreakMarkers(node: any): number {
  let count = 0;
  const visit = (current: any) => {
    if (isPageBreakMarker(current)) {
      count += 1;
      return;
    }
    for (let i = 0; i < (current.childNodes?.length || 0); i++) {
      visit(current.childNodes.item(i));
    }
  };
  visit(node);
  return count;
}

function countBreaksBeforeFirstVisibleText(paragraph: any, visibleTextNodes: any[]): number {
  if (visibleTextNodes.length === 0) return 0;

  const visibleNodeSet = new Set(visibleTextNodes);
  let count = 0;
  let reachedText = false;

  const visit = (current: any) => {
    if (reachedText) return;
    if (visibleNodeSet.has(current)) {
      reachedText = true;
      return;
    }
    if (isPageBreakMarker(current)) {
      count += 1;
      return;
    }
    for (let i = 0; i < (current.childNodes?.length || 0); i++) {
      visit(current.childNodes.item(i));
      if (reachedText) return;
    }
  };

  visit(paragraph);
  return count;
}

function buildParagraphPageMap(paragraphNodes: any[]): Map<any, number> {
  const pageMap = new Map<any, number>();
  let currentPage = 1;

  paragraphNodes.forEach(paragraph => {
    const textNodes = selectVisibleTextNodes(paragraph);
    const leadingBreaks = countBreaksBeforeFirstVisibleText(paragraph, textNodes);
    if (leadingBreaks > 0) currentPage += leadingBreaks;

    pageMap.set(paragraph, Math.max(1, currentPage));

    const breakCount = countPageBreakMarkers(paragraph);
    const trailingBreaks = Math.max(0, breakCount - leadingBreaks);
    if (trailingBreaks > 0) currentPage += trailingBreaks;
  });

  return pageMap;
}

function getDrawingTextNodesUnder(node: any): any[] {
  const out: any[] = [];
  const visit = (current: any) => {
    if (isDrawingElement(current, 't')) {
      out.push(current);
      return;
    }
    for (let i = 0; i < (current.childNodes?.length || 0); i++) {
      visit(current.childNodes.item(i));
    }
  };
  visit(node);
  return out;
}

function collectDiagramPoints(doc: any): any[] {
  const out: any[] = [];
  const visit = (node: any) => {
    if (isDiagramElement(node, 'pt')) {
      out.push(node);
    }
    for (let i = 0; i < (node.childNodes?.length || 0); i++) {
      visit(node.childNodes.item(i));
    }
  };
  visit(doc);
  return out;
}

function firstDiagramTextChild(point: any): any | null {
  for (let i = 0; i < (point.childNodes?.length || 0); i++) {
    const child = point.childNodes.item(i);
    if (isDiagramElement(child, 't')) return child;
  }
  return null;
}

function collectDiagramTextRuns(doc: any): { index: number; textNodes: any[] }[] {
  return collectDiagramPoints(doc)
    .map((point, index) => {
      const textElement = firstDiagramTextChild(point);
      const textNodes = textElement ? getDrawingTextNodesUnder(textElement) : [];
      return { index, textNodes };
    })
    .filter(run => run.textNodes.length > 0 && paragraphTextFromNodes(run.textNodes).trim().length > 0);
}

function collectDrawingParagraphTextRuns(doc: any): { index: number; textNodes: any[] }[] {
  const out: { index: number; textNodes: any[] }[] = [];
  const visit = (node: any) => {
    if (isDrawingElement(node, 'p')) {
      const textNodes = getDrawingTextNodesUnder(node);
      if (textNodes.length > 0 && paragraphTextFromNodes(textNodes).trim().length > 0) {
        out.push({ index: out.length, textNodes });
      }
      return;
    }
    for (let i = 0; i < (node.childNodes?.length || 0); i++) {
      visit(node.childNodes.item(i));
    }
  };
  visit(doc);
  return out;
}

function getTextRunKey(textNodes: any[]): string {
  return normalizeLayoutText(paragraphTextFromNodes(textNodes));
}

function addSourceTranslation(map: Map<string, string[]>, source: string, translation: string): void {
  const key = normalizeText(source);
  if (!key) return;
  const existing = map.get(key) || [];
  existing.push(translation);
  map.set(key, existing);
}

function takeSourceTranslation(map: Map<string, string[]>, source: string): string | null {
  const key = normalizeText(source);
  const translations = map.get(key);
  if (!translations || translations.length === 0) return null;
  if (translations.length === 1) return translations[0];
  return translations.shift() || null;
}

function cloneSourceTranslationMap(map: Map<string, string[]>): Map<string, string[]> {
  return new Map(Array.from(map.entries()).map(([key, value]) => [key, [...value]]));
}

function firstElementTextByLocalName(doc: any, localName: string): string | null {
  const visit = (node: any): string | null => {
    if (node?.nodeType === 1 && localNameOf(node) === localName) {
      return normalizeText(node.textContent || '');
    }

    for (let i = 0; i < (node.childNodes?.length || 0); i++) {
      const found = visit(node.childNodes.item(i));
      if (found !== null) return found;
    }

    return null;
  };

  return visit(doc);
}

function parsePositiveInteger(value: string | null | undefined): number | null {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function sanitizeDocxXml(xml: string): string {
  const text = String(xml || '').replace(/^\uFEFF/, '');
  const declarationIndex = text.indexOf('<?xml');
  return declarationIndex > 0 && text.slice(0, declarationIndex).trim() === ''
    ? text.slice(declarationIndex)
    : text;
}

function parseDocxXml(xml: string): any {
  return new DOMParser().parseFromString(sanitizeDocxXml(xml), 'text/xml');
}

async function resolveDOCXPageCount(zip: JSZip, paragraphs: ExtractedDocxParagraph[]): Promise<number> {
  const appXml = await zip.file('docProps/app.xml')?.async('string');
  if (appXml) {
    const appDoc = parseDocxXml(appXml);
    const savedPages = parsePositiveInteger(firstElementTextByLocalName(appDoc, 'Pages'));
    if (savedPages) return savedPages;
  }

  const documentXml = await zip.file('word/document.xml')?.async('string');
  if (documentXml) {
    const doc = parseDocxXml(documentXml);
    const pageBreaks = countPageBreakMarkers(doc);
    if (pageBreaks > 0) return pageBreaks + 1;
  }

  const bodyParagraphs = paragraphs.filter(paragraph => paragraph.partPath === 'word/document.xml').length;
  return Math.max(1, Math.ceil(bodyParagraphs / 14));
}

export async function extractDOCXText(buffer: Buffer): Promise<DOCXStats> {
  const zip = await JSZip.loadAsync(buffer);
  if (!zip.file('word/document.xml')) {
    throw new Error('Invalid DOCX package: word/document.xml not found.');
  }

  const paragraphs: ExtractedDocxParagraph[] = [];
  const partPaths = Object.keys(zip.files).filter(path => isDocxTextPart(path)).sort();

  for (const partPath of partPaths) {
    const file = zip.file(partPath);
    if (!file) continue;
    const xml = await file.async('string');
    const doc = parseDocxXml(xml);
    if (isDocxDiagramDrawingPart(partPath)) {
      continue;
    }
    if (isDocxDiagramDataPart(partPath)) {
      collectDiagramTextRuns(doc).forEach(run => {
        const text = normalizeLayoutText(paragraphTextFromNodes(run.textNodes));
        if (shouldExposeText(text)) {
          paragraphs.push({
            slideNum: 0,
            slidePath: partPath,
            partPath,
            partType: 'diagram',
            p_idx: run.index,
            originalText: text
          });
        }
      });
      continue;
    }

    const paragraphNodes = collectParagraphs(doc);
    const pageMap = partPath === 'word/document.xml' && countPageBreakMarkers(doc) > 0
      ? buildParagraphPageMap(paragraphNodes)
      : new Map<any, number>();
    paragraphNodes.forEach((paragraph, currentIdx) => {
      const textNodes = selectVisibleTextNodes(paragraph);
      const text = normalizeLayoutText(paragraphTextFromNodes(textNodes));
      if (shouldExposeText(text)) {
        paragraphs.push({
          slideNum: pageMap.get(paragraph) || 0,
          slidePath: partPath,
          partPath,
          partType: 'document',
          p_idx: currentIdx,
          originalText: text
        });
      }
    });
  }

  const mediaCount = Object.keys(zip.files).filter(path => path.startsWith('word/media/')).length;
  const pageCount = await resolveDOCXPageCount(zip, paragraphs);
  return {
    slideCount: pageCount,
    mediaCount,
    paragraphs
  };
}

export async function writeDOCXTranslations(
  originalBuffer: Buffer,
  translationsByPart: Record<string, Record<number, string>>,
  targetLanguage?: string
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(originalBuffer);
  const cjkLayout = resolveCjkLayout(targetLanguage);

  for (const [partPath, partTranslations] of Object.entries(translationsByPart)) {
    const file = zip.file(partPath);
    if (!file) continue;
    const xml = await file.async('string');
    let changed = false;
    const doc = parseDocxXml(xml);
    if (isDocxDiagramDataPart(partPath)) {
      const sourceTranslations = new Map<string, string[]>();
      collectDiagramTextRuns(doc).forEach(run => {
        const translatedText = partTranslations[run.index];
        if (translatedText === undefined) return;
        addSourceTranslation(sourceTranslations, getTextRunKey(run.textNodes), translatedText);
        changed = true;
        applyTextToNodes(run.textNodes, translatedText);
      });

      if (changed) {
        zip.file(partPath, serializeDocxXml(doc));
      }

      const drawingPartPath = getDiagramDrawingPartPath(partPath);
      const drawingFile = drawingPartPath ? zip.file(drawingPartPath) : null;
      if (drawingFile && sourceTranslations.size > 0) {
        const drawingXml = await drawingFile.async('string');
        const drawingDoc = parseDocxXml(drawingXml);
        const drawingTranslations = cloneSourceTranslationMap(sourceTranslations);
        let drawingChanged = false;

        collectDrawingParagraphTextRuns(drawingDoc).forEach(run => {
          const translatedText = takeSourceTranslation(drawingTranslations, getTextRunKey(run.textNodes));
          if (!translatedText) return;
          drawingChanged = true;
          applyTextToNodes(run.textNodes, translatedText);
        });

        if (drawingChanged) {
          zip.file(drawingPartPath, serializeDocxXml(drawingDoc));
        }
      }
      continue;
    }

    const paragraphNodes = collectParagraphs(doc);
    const textWidth = cjkLayout ? getDocumentTextWidth(doc) : null;
    paragraphNodes.forEach((paragraph, currentIdx) => {
      const translatedText = partTranslations[currentIdx];
      if (translatedText === undefined) return;
      const textNodes = selectVisibleTextNodes(paragraph);
      if (textNodes.length === 0) return;

      changed = true;
      const inTextbox = isInsideWordElement(paragraph, 'txbxContent');
      if (inTextbox) {
        applyTextToTextboxNodes(textNodes, translatedText);
      } else {
        applyTextToNodes(textNodes, translatedText);
      }
      // CJK layout fixes (font/lang tags, word wrap, table width cap, page-field
      // labels) apply to body paragraphs only; text boxes manage their own layout.
      if (cjkLayout && !inTextbox) {
        prepareTranslatedParagraphLayout(paragraph, selectVisibleTextNodes(paragraph), translatedText, textWidth, cjkLayout);
      }
    });

    if (changed) {
      markFieldsDirty(doc);
      zip.file(partPath, serializeDocxXml(doc));
    }
  }

  const settingsFile = zip.file('word/settings.xml');
  if (settingsFile) {
    const settingsXml = await settingsFile.async('string');
    const settingsDoc = parseDocxXml(settingsXml);
    enableUpdateFieldsOnOpen(settingsDoc);
    zip.file('word/settings.xml', serializeDocxXml(settingsDoc));
  }

  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });
}

export async function hasDOCXFixedLayoutFlyerRisk(buffer: Buffer, originalName = ''): Promise<boolean> {
  if (/(?:^|[_\-\s])IG(?:[_\-\s.]|$)|instruction[\s_-]*guide/i.test(originalName)) return false;

  const zip = await JSZip.loadAsync(buffer);
  const documentXml = await zip.file('word/document.xml')?.async('string');
  if (!documentXml) return false;

  const appXml = await zip.file('docProps/app.xml')?.async('string');
  if (appXml) {
    const appDoc = parseDocxXml(appXml);
    const savedPages = parsePositiveInteger(firstElementTextByLocalName(appDoc, 'Pages'));
    if (savedPages && savedPages !== 1) return false;
  }

  const document = parseDocxXml(documentXml);
  if (countPageBreakMarkers(document) > 0) return false;

  const hasTextboxText = /<w:txbxContent\b/.test(documentXml);
  if (!hasTextboxText) return false;

  const hasFixedDrawingLayout = /<wp:anchor\b/.test(documentXml)
    || /<wpg:wgp\b/.test(documentXml)
    || /<wps:wsp\b/.test(documentXml);
  const hasNoAutofit = /<a:noAutofit\b/.test(documentXml);
  return hasFixedDrawingLayout && hasNoAutofit;
}

export function collectDOCXParagraphTextsFromXml(xml: string): string[] {
  const out: string[] = [];
  const doc = parseDocxXml(xml);
  collectParagraphs(doc).forEach(paragraph => {
    const text = normalizeLayoutText(paragraphTextFromNodes(selectVisibleTextNodes(paragraph)));
    if (text.length > 0) out.push(text);
  });
  collectDiagramTextRuns(doc).forEach(run => {
    const text = normalizeLayoutText(paragraphTextFromNodes(run.textNodes));
    if (text.length > 0) out.push(text);
  });
  collectDrawingParagraphTextRuns(doc).forEach(run => {
    const text = normalizeLayoutText(paragraphTextFromNodes(run.textNodes));
    if (text.length > 0) out.push(text);
  });
  return out;
}

export { isDocxTextPart };
