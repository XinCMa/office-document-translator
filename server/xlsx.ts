import JSZip from 'jszip';

export interface ExtractedXlsxCell {
  slideNum: number;
  slidePath: string;
  partPath: string;
  partType: 'document';
  p_idx: number;
  originalText: string;
}

export interface XLSXStats {
  slideCount: number;
  mediaCount: number;
  paragraphs: ExtractedXlsxCell[];
}

const TEXTISH_RE = /[A-Za-z\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function normalizeText(text: string): string {
  return text.replace(/[^\S\t]+/g, ' ').replace(/ *\t */g, '\t').trim();
}

function decodeXmlText(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec) => String.fromCodePoint(parseInt(dec, 10)))
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

function shouldExposeText(text: string): boolean {
  const clean = normalizeText(text);
  if (!clean || clean.length < 2) return false;
  return TEXTISH_RE.test(clean);
}

function getAttr(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? decodeXmlText(match[1]) : undefined;
}

function removeAttr(attrs: string, name: string): string {
  return attrs.replace(new RegExp(`\\s*${name}="[^"]*"`, 'g'), '');
}

export function collectXLSXSharedStrings(xml: string): string[] {
  const sharedStrings: string[] = [];
  xml.replace(/<si\b[^>]*>([\s\S]*?)<\/si>/g, (siMatch, siInner) => {
    const parts: string[] = [];
    siInner.replace(/<t\b[^>]*>([\s\S]*?)<\/t>/g, (tMatch, text) => {
      parts.push(decodeXmlText(String(text)));
      return tMatch;
    });
    sharedStrings.push(normalizeText(parts.join('')));
    return siMatch;
  });
  return sharedStrings;
}

function collectInlineText(cellInner: string): string {
  const parts: string[] = [];
  cellInner.replace(/<t\b[^>]*>([\s\S]*?)<\/t>/g, (tMatch, text) => {
    parts.push(decodeXmlText(String(text)));
    return tMatch;
  });
  return normalizeText(parts.join(''));
}

function extractCellText(cellAttrs: string, cellInner: string, sharedStrings: string[]): string {
  const type = getAttr(cellAttrs, 't');
  if (type === 's') {
    const rawIndex = cellInner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
    const index = Number.parseInt(String(rawIndex || ''), 10);
    return Number.isFinite(index) ? normalizeText(sharedStrings[index] || '') : '';
  }
  if (type === 'inlineStr') {
    return collectInlineText(cellInner);
  }
  if (type === 'str') {
    const rawText = cellInner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
    return normalizeText(decodeXmlText(String(rawText || '')));
  }
  return '';
}

export function collectXLSXCellTextsFromXml(xml: string, sharedStrings: string[] = []): string[] {
  const texts: string[] = [];
  xml.replace(/<c\b([^>/]*)>([\s\S]*?)<\/c>/g, (cellMatch, attrs, inner) => {
    const text = extractCellText(String(attrs), String(inner), sharedStrings);
    if (shouldExposeText(text)) texts.push(text);
    return cellMatch;
  });
  return texts;
}

export async function extractXLSXText(buffer: Buffer): Promise<XLSXStats> {
  const zip = await JSZip.loadAsync(buffer);
  if (!zip.file('xl/workbook.xml')) {
    throw new Error('Invalid XLSX package: xl/workbook.xml not found.');
  }

  const sharedStringsXml = await zip.file('xl/sharedStrings.xml')?.async('string');
  const sharedStrings = sharedStringsXml ? collectXLSXSharedStrings(sharedStringsXml) : [];
  const sheetRegex = /^xl\/worksheets\/sheet(\d+)\.xml$/;
  const sheetFiles = Object.keys(zip.files).filter(name => sheetRegex.test(name)).sort((a, b) => {
    const aNum = Number.parseInt(a.match(sheetRegex)?.[1] || '0', 10);
    const bNum = Number.parseInt(b.match(sheetRegex)?.[1] || '0', 10);
    return aNum - bNum;
  });

  const paragraphs: ExtractedXlsxCell[] = [];
  for (const sheetPath of sheetFiles) {
    const sheetNum = Number.parseInt(sheetPath.match(sheetRegex)?.[1] || '1', 10);
    const xml = await zip.file(sheetPath)!.async('string');
    let cellIndex = 0;
    xml.replace(/<c\b([^>/]*)>([\s\S]*?)<\/c>/g, (cellMatch, attrs, inner) => {
      const text = extractCellText(String(attrs), String(inner), sharedStrings);
      if (shouldExposeText(text)) {
        paragraphs.push({
          slideNum: sheetNum,
          slidePath: sheetPath,
          partPath: sheetPath,
          partType: 'document',
          p_idx: cellIndex,
          originalText: text
        });
        cellIndex++;
      }
      return cellMatch;
    });
  }

  return {
    slideCount: Math.max(1, sheetFiles.length),
    mediaCount: Object.keys(zip.files).filter(name => name.startsWith('xl/media/')).length,
    paragraphs
  };
}

function buildInlineStringCell(attrs: string, translatedText: string): string {
  let nextAttrs = removeAttr(attrs, 't');
  nextAttrs = `${nextAttrs} t="inlineStr"`;
  return `<c${nextAttrs}><is><t xml:space="preserve">${escapeXml(translatedText)}</t></is></c>`;
}

/**
 * Convert a string into the same numeric character-reference form that openpyxl
 * uses when serializing CJK text inside formula literals. This lets us match
 * (and replace) the literal payload of `<f>` and `<formula>` elements without
 * miscounting ASCII characters.
 */
function toNumericCharacterReferences(text: string): string {
  let out = '';
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    out += codePoint > 127 ? `&#${codePoint};` : char;
  }
  return out;
}

/**
 * After cell text has been translated, propagate stable src→tgt literal pairs
 * into formula contexts that still reference the source language string.
 *
 * Two XML containers hold such references:
 *  - `<f>` (cell formulas)            — e.g. `COUNTIF(H2:H13,"通过")`
 *  - `<formula>` (CF rule payloads)  — e.g. `cellIs` operator="equal" payload
 *
 * We only propagate when the source maps to a unique target. Multiple competing
 * targets for the same source (e.g. AI picked two English phrasings) would
 * indicate unreliable translation alignment, so we skip those.
 */
function propagateLiteralUpdates(
  xml: string,
  literals: Array<{ oldText: string; newText: string }>
): string {
  if (literals.length === 0) return xml;
  const encoded = literals.map(item => ({
    oldNCR: toNumericCharacterReferences(item.oldText),
    newNCR: toNumericCharacterReferences(item.newText)
  }));

  // Cell formulas: <f attrs>literal</f> — closing </f> must be in a capture
  // group so the replacement callback receives three real groups (open,
  // content, close); otherwise `close` is silently filled with the match
  // offset of the regex engine and gets injected as digits next to <v>.
  const CELL_TAG = 'f';
  const CF_TAG = 'formula';
  const cellFormulaRegex = /<f([^>]*)>([^<]*)(<\/f>)/g;
  const cfFormulaRegex = /<formula([^>]*)>([^<]*)(<\/formula>)/g;

  const replaceInsideElement = (tagName: string, elementRegex: RegExp): ((source: string) => string) => {
    return (source) => source.replace(elementRegex, (_match, attrs, content, closeTag) => {
      let next = content;
      for (const { oldNCR, newNCR } of encoded) {
        if (oldNCR && next.includes(oldNCR)) {
          next = next.split(oldNCR).join(newNCR);
        }
      }
      // Re-emit with the opening `<tag` we consumed plus attrs (which is
      // *content between* `<tag` and `>`) preserved verbatim.
      return `<${tagName}${attrs}>${next}${closeTag}`;
    });
  };

  return [
    replaceInsideElement(CELL_TAG, cellFormulaRegex),
    replaceInsideElement(CF_TAG, cfFormulaRegex)
  ].reduce((acc, fn) => fn(acc), xml);
}

export async function writeXLSXTranslations(
  originalBuffer: Buffer,
  translationsByPart: Record<string, Record<number, string>>
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(originalBuffer);
  const sharedStringsXml = await zip.file('xl/sharedStrings.xml')?.async('string');
  const sharedStrings = sharedStringsXml ? collectXLSXSharedStrings(sharedStringsXml) : [];

  const sheetRegex = /^xl\/worksheets\/sheet\d+\.xml$/;
  const sheetFiles = Object.keys(zip.files).filter(name => sheetRegex.test(name));

  // -- Pass 1: collect globally-stable src→tgt literal pairs from every sheet
  // that received translations. A pair is "stable" only when every occurrence
  // of the source in the translated sheet maps to the same target.
  const targetCountBySource = new Map<string, Set<string>>();
  const cellReplacementsBySheet = new Map<string, Record<number, { srcText: string; tgtText: string }>>();

  for (const sheetPath of sheetFiles) {
    const partTranslations = translationsByPart[sheetPath];
    if (!partTranslations) continue;
    const sheetFile = zip.file(sheetPath);
    if (!sheetFile) continue;
    const xml = await sheetFile.async('string');

    const replacements: Record<number, { srcText: string; tgtText: string }> = {};
    let cellIndex = 0;
    xml.replace(/<c\b([^>/]*)>([\s\S]*?)<\/c>/g, (_match, attrs, inner) => {
      const sourceText = extractCellText(String(attrs), String(inner), sharedStrings);
      if (!shouldExposeText(sourceText)) return _match;
      // Post-increment index so empty/untranslated slots still advance past.
      const idx = cellIndex++;
      const translatedText = partTranslations[idx];
      if (translatedText === undefined) return _match;
      if (sourceText !== translatedText) {
        replacements[idx] = { srcText: sourceText, tgtText: translatedText };
        const bucket = targetCountBySource.get(sourceText) ?? new Set<string>();
        bucket.add(translatedText);
        targetCountBySource.set(sourceText, bucket);
      }
      return _match;
    });
    cellReplacementsBySheet.set(sheetPath, replacements);
  }

  const stableLiterals = Array.from(targetCountBySource.entries())
    .filter(([, targets]) => targets.size === 1)
    .map(([srcText, targets]) => ({ oldText: srcText, newText: Array.from(targets)[0] }));

  // -- Pass 2: write back cell text + propagate stable literals to formulas
  // across *every* sheet (even those without translations, since formula
  // payloads may reference values translated elsewhere in the workbook).
  for (const sheetPath of sheetFiles) {
    const sheetFile = zip.file(sheetPath);
    if (!sheetFile) continue;
    const xml = await sheetFile.async('string');
    const partTranslations = translationsByPart[sheetPath];
    const replacements = cellReplacementsBySheet.get(sheetPath);

    let updatedXml = xml;
    let hasChanges = false;

    if (partTranslations && replacements) {
      let cellIndex = 0;
      updatedXml = xml.replace(/<c\b([^>/]*)>([\s\S]*?)<\/c>/g, (cellMatch, attrs, inner) => {
        const sourceText = extractCellText(String(attrs), String(inner), sharedStrings);
        if (!shouldExposeText(sourceText)) return cellMatch;
        const translatedText = partTranslations[cellIndex];
        const idx = cellIndex;
        cellIndex++;
        if (translatedText === undefined) return cellMatch;
        hasChanges = true;
        // The "is in replacements" check is bookkeeping only; we just emit
        // the translated cell regardless so callers don't need to know which
        // slots actually changed.
        return buildInlineStringCell(String(attrs), translatedText);
      });
    }

    const finalXml = stableLiterals.length > 0
      ? propagateLiteralUpdates(updatedXml, stableLiterals)
      : updatedXml;

    if (hasChanges || finalXml !== xml) {
      zip.file(sheetPath, finalXml);
    }
  }

  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });
}
