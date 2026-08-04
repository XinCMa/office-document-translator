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

function collectSharedStrings(xml: string): string[] {
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
  xml.replace(/<c\b([^>]*)>([\s\S]*?)<\/c>/g, (cellMatch, attrs, inner) => {
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
  const sharedStrings = sharedStringsXml ? collectSharedStrings(sharedStringsXml) : [];
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
    xml.replace(/<c\b([^>]*)>([\s\S]*?)<\/c>/g, (cellMatch, attrs, inner) => {
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

export async function writeXLSXTranslations(
  originalBuffer: Buffer,
  translationsByPart: Record<string, Record<number, string>>
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(originalBuffer);
  const sharedStringsXml = await zip.file('xl/sharedStrings.xml')?.async('string');
  const sharedStrings = sharedStringsXml ? collectSharedStrings(sharedStringsXml) : [];

  for (const [sheetPath, partTranslations] of Object.entries(translationsByPart)) {
    const sheetFile = zip.file(sheetPath);
    if (!sheetFile) continue;
    const xml = await sheetFile.async('string');
    let cellIndex = 0;
    let hasChanges = false;

    const updatedXml = xml.replace(/<c\b([^>]*)>([\s\S]*?)<\/c>/g, (cellMatch, attrs, inner) => {
      const sourceText = extractCellText(String(attrs), String(inner), sharedStrings);
      if (!shouldExposeText(sourceText)) return cellMatch;
      const translatedText = partTranslations[cellIndex++];
      if (translatedText === undefined) return cellMatch;
      hasChanges = true;
      return buildInlineStringCell(String(attrs), translatedText);
    });

    if (hasChanges) {
      zip.file(sheetPath, updatedXml);
    }
  }

  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });
}
