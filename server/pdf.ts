import zlib from 'zlib';

export interface ExtractedPdfParagraph {
  slideNum: number;
  slidePath: string;
  partPath: string;
  partType: 'document';
  p_idx: number;
  originalText: string;
}

export interface PDFStats {
  slideCount: number;
  mediaCount: number;
  paragraphs: ExtractedPdfParagraph[];
}

const TEXTISH_RE = /[A-Za-z\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function shouldExposeText(text: string): boolean {
  const clean = normalizeText(text);
  if (!clean || clean.length < 2) return false;
  return TEXTISH_RE.test(clean);
}

function decodePdfLiteral(raw: string): string {
  let out = '';
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (char !== '\\') {
      out += char;
      continue;
    }

    const next = raw[++index];
    if (next === undefined) break;
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else if (next === 'b') out += '\b';
    else if (next === 'f') out += '\f';
    else if (next === '(' || next === ')' || next === '\\') out += next;
    else if (/[0-7]/.test(next)) {
      let octal = next;
      for (let count = 0; count < 2 && /[0-7]/.test(raw[index + 1] || ''); count++) {
        octal += raw[++index];
      }
      out += String.fromCharCode(parseInt(octal, 8));
    } else {
      out += next;
    }
  }
  return out;
}

function decodePdfHex(raw: string): string {
  const clean = raw.replace(/\s+/g, '');
  if (!clean) return '';
  const evenHex = clean.length % 2 === 0 ? clean : `${clean}0`;
  const bytes: number[] = [];
  for (let index = 0; index < evenHex.length; index += 2) {
    const byte = parseInt(evenHex.slice(index, index + 2), 16);
    if (Number.isFinite(byte)) bytes.push(byte);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let text = '';
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      text += String.fromCharCode((bytes[index] << 8) + bytes[index + 1]);
    }
    return text;
  }
  return Buffer.from(bytes).toString('latin1');
}

function extractPdfStrings(content: string): string[] {
  const out: string[] = [];
  const literalRe = /\((?:\\.|[^\\()])*\)\s*(?:Tj|'|")/g;
  const hexRe = /<([0-9a-fA-F\s]+)>\s*Tj/g;
  const arrayRe = /\[((?:\s*(?:\((?:\\.|[^\\()])*\)|<[^>]+>|-?\d+(?:\.\d+)?)\s*)+)\]\s*TJ/g;

  let match: RegExpExecArray | null;
  while ((match = literalRe.exec(content))) {
    const token = match[0];
    out.push(decodePdfLiteral(token.slice(1, token.lastIndexOf(')'))));
  }

  while ((match = hexRe.exec(content))) {
    out.push(decodePdfHex(match[1]));
  }

  while ((match = arrayRe.exec(content))) {
    const arrayBody = match[1];
    const parts: string[] = [];
    const itemRe = /\((?:\\.|[^\\()])*\)|<([0-9a-fA-F\s]+)>/g;
    let itemMatch: RegExpExecArray | null;
    while ((itemMatch = itemRe.exec(arrayBody))) {
      const token = itemMatch[0];
      if (token.startsWith('(')) {
        parts.push(decodePdfLiteral(token.slice(1, -1)));
      } else if (itemMatch[1]) {
        parts.push(decodePdfHex(itemMatch[1]));
      }
    }
    if (parts.length > 0) out.push(parts.join(''));
  }

  return out.map(normalizeText).filter(shouldExposeText);
}

function decodeStream(dict: string, streamBytes: Buffer): string {
  let content = streamBytes;
  if (/\/FlateDecode\b/.test(dict)) {
    try {
      content = zlib.inflateSync(streamBytes);
    } catch {
      return '';
    }
  }
  return content.toString('latin1');
}

export async function extractPDFText(buffer: Buffer): Promise<PDFStats> {
  const raw = buffer.toString('latin1');
  const pageCount = Math.max(1, (raw.match(/\/Type\s*\/Page\b/g) || []).length);
  const paragraphs: ExtractedPdfParagraph[] = [];
  const streamRe = /(\d+\s+\d+\s+obj\s*<<[\s\S]*?>>\s*)stream\r?\n?([\s\S]*?)\r?\n?endstream/g;
  let streamIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = streamRe.exec(raw))) {
    streamIndex++;
    const dict = match[1];
    const streamContent = match[2];
    const streamBytes = Buffer.from(streamContent, 'latin1');
    const textContent = decodeStream(dict, streamBytes);
    if (!textContent) continue;

    const texts = extractPdfStrings(textContent);
    for (const text of texts) {
      paragraphs.push({
        slideNum: Math.min(pageCount, Math.max(1, streamIndex)),
        slidePath: `pdf/page-${Math.min(pageCount, Math.max(1, streamIndex))}`,
        partPath: `pdf/stream-${streamIndex}`,
        partType: 'document',
        p_idx: paragraphs.length,
        originalText: text
      });
    }
  }

  if (paragraphs.length === 0) {
    throw new Error('No selectable text was found in this PDF. Scanned/image-only PDFs are not supported yet.');
  }

  return {
    slideCount: pageCount,
    mediaCount: 0,
    paragraphs
  };
}

function utf16beHex(text: string): string {
  const bytes: number[] = [0xfe, 0xff];
  for (const char of text) {
    const code = char.codePointAt(0) || 0x20;
    if (code > 0xffff) {
      const high = Math.floor((code - 0x10000) / 0x400) + 0xd800;
      const low = ((code - 0x10000) % 0x400) + 0xdc00;
      bytes.push(high >> 8, high & 0xff, low >> 8, low & 0xff);
    } else {
      bytes.push(code >> 8, code & 0xff);
    }
  }
  return bytes.map(byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function wrapText(text: string, maxChars: number): string[] {
  const clean = normalizeText(text);
  if (!clean) return [];
  const lines: string[] = [];
  let current = '';
  for (const token of clean.split(/(\s+)/)) {
    if (!token) continue;
    if ((current + token).length > maxChars && current.trim()) {
      lines.push(current.trim());
      current = token.trimStart();
    } else {
      current += token;
    }
  }
  if (current.trim()) lines.push(current.trim());

  const expanded: string[] = [];
  for (const line of lines) {
    if (line.length <= maxChars) {
      expanded.push(line);
      continue;
    }
    for (let index = 0; index < line.length; index += maxChars) {
      expanded.push(line.slice(index, index + maxChars));
    }
  }
  return expanded;
}

function makeContentStream(lines: string[]): string {
  const commands = [
    'BT',
    '/F1 11 Tf',
    '50 790 Td',
    '16 TL'
  ];
  lines.forEach((line, index) => {
    if (index > 0) commands.push('T*');
    commands.push(`<${utf16beHex(line)}> Tj`);
  });
  commands.push('ET');
  return commands.join('\n');
}

export async function writePDFTranslations(
  originalName: string,
  texts: { originalText: string; translatedText?: string }[],
  targetLanguageLabel: string
): Promise<Buffer> {
  const lines: string[] = [
    `${originalName}`,
    `Translated document (${targetLanguageLabel})`,
    ''
  ];
  for (const item of texts) {
    const text = item.translatedText?.trim() || item.originalText;
    lines.push(...wrapText(text, 54), '');
  }

  const pages: string[][] = [];
  for (let index = 0; index < lines.length; index += 42) {
    pages.push(lines.slice(index, index + 42));
  }
  if (pages.length === 0) pages.push(['Translated document']);

  const objects: string[] = [];
  const addObject = (body: string): number => {
    objects.push(body);
    return objects.length;
  };

  const catalogId = addObject('<< /Type /Catalog /Pages 2 0 R >>');
  const pageIds: number[] = [];
  addObject('PAGES_PLACEHOLDER');
  const fontId = addObject('<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] >>');
  addObject('<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /DW 1000 >>');

  for (const pageLines of pages) {
    const content = makeContentStream(pageLines);
    const contentId = addObject(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    const pageId = addObject(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }

  objects[1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index++) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
