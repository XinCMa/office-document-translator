import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

export interface ExtractedParagraph {
  slideNum: number;
  slidePath: string;
  partPath?: string;
  partType?: 'slide' | 'diagram';
  p_idx: number;
  originalText: string;
}

export interface PPTXStats {
  slideCount: number;
  mediaCount: number;
  paragraphs: ExtractedParagraph[];
}

/**
 * Extracts all paragraph text nodes from slides within a PPTX file.
 */
export async function extractPPTXText(buffer: Buffer): Promise<PPTXStats> {
  const zip = await JSZip.loadAsync(buffer);

  // Find all slide paths matching ppt/slides/slideX.xml
  const slideRegex = /^ppt\/slides\/slide(\d+)\.xml$/;
  const slideFiles = Object.keys(zip.files).filter(name => slideRegex.test(name));

  // Sort slide files numerically
  slideFiles.sort((a, b) => {
    const numA = parseInt(a.match(slideRegex)![1], 10);
    const numB = parseInt(b.match(slideRegex)![1], 10);
    return numA - numB;
  });

  const paragraphs: ExtractedParagraph[] = [];
  const parser = new DOMParser();

  const extractParagraphsFromXml = (
    xmlContent: string,
    slideNum: number,
    slidePath: string,
    partPath: string,
    partType: 'slide' | 'diagram'
  ) => {
    const doc = parser.parseFromString(xmlContent, 'text/xml');
    const pElements = doc.getElementsByTagName('a:p');
    for (let p_idx = 0; p_idx < pElements.length; p_idx++) {
      const pNode = pElements[p_idx];
      const tElements = pNode.getElementsByTagName('a:t');
      let paragraphText = '';
      for (let t_idx = 0; t_idx < tElements.length; t_idx++) {
        paragraphText += tElements[t_idx].textContent || '';
      }

      const trimmed = paragraphText.trim();
      if (trimmed.length > 0) {
        paragraphs.push({
          slideNum,
          slidePath,
          partPath,
          partType,
          p_idx,
          originalText: trimmed
        });
      }
    }
  };

  const resolveRelationshipTarget = (fromPath: string, target: string): string => {
    const baseParts = fromPath.split('/').slice(0, -1);
    for (const part of target.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        baseParts.pop();
      } else {
        baseParts.push(part);
      }
    }
    return baseParts.join('/');
  };

  const getRelatedDiagramParts = async (slidePath: string): Promise<string[]> => {
    const relPath = slidePath.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels';
    const relFile = zip.file(relPath);
    if (!relFile) return [];

    const relXml = await relFile.async('string');
    const relDoc = parser.parseFromString(relXml, 'text/xml');
    const relationships = relDoc.getElementsByTagName('Relationship');
    const diagramParts: string[] = [];

    for (let i = 0; i < relationships.length; i++) {
      const rel = relationships[i];
      const type = rel.getAttribute('Type') || '';
      const target = rel.getAttribute('Target') || '';
      // SmartArt stores source data, layout, colors, style, and a rendered drawing cache.
      // The drawing part is what PowerPoint actually displays, so expose only that
      // text in the UI to avoid duplicate data/drawing entries for the same node.
      if (!target || !type.endsWith('/diagramDrawing')) continue;
      const resolved = resolveRelationshipTarget(slidePath, target);
      if (resolved.startsWith('ppt/diagrams/') && resolved.endsWith('.xml') && zip.file(resolved)) {
        diagramParts.push(resolved);
      }
    }

    return Array.from(new Set(diagramParts));
  };

  for (const slidePath of slideFiles) {
    const slideNum = parseInt(slidePath.match(slideRegex)![1], 10);
    const xmlContent = await zip.file(slidePath)!.async('string');

    extractParagraphsFromXml(xmlContent, slideNum, slidePath, slidePath, 'slide');

    const diagramParts = await getRelatedDiagramParts(slidePath);
    for (const diagramPath of diagramParts) {
      const diagramXml = await zip.file(diagramPath)!.async('string');
      extractParagraphsFromXml(diagramXml, slideNum, slidePath, diagramPath, 'diagram');
    }
  }

  // Count media assets in ppt/media (images, audios, videos)
  const mediaFiles = Object.keys(zip.files).filter(name => name.startsWith('ppt/media/'));

  return {
    slideCount: slideFiles.length,
    mediaCount: mediaFiles.length,
    paragraphs
  };
}

/**
 * Submits translations back into slide files inside the PPTX ZIP container.
 * This is 100% non-destructive to PPTX namespaces, relations, schemas, shapes, and media structures.
 */
export async function writePPTXTranslations(
  originalBuffer: Buffer,
  translationsBySlide: Record<number, Record<number, string>>,
  translationsByPart?: Record<string, Record<number, string>>,
  translationsByText?: Record<string, string>
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(originalBuffer);

  const slideRegex = /^ppt\/slides\/slide(\d+)\.xml$/;
  const slideFiles = Object.keys(zip.files).filter(name => slideRegex.test(name));

  const escapeXml = (unsafe: string): string => {
    return unsafe.replace(/[<>&'"]/g, (c) => {
      switch (c) {
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '&': return '&amp;';
        case '\'': return '&apos;';
        case '"': return '&quot;';
        default: return c;
      }
    });
  };

  const applyTranslationsToPart = async (partPath: string, partTranslations: Record<number, string>) => {
    const partFile = zip.file(partPath);
    if (!partFile) return;

    const xmlContent = await partFile.async('string');
    let p_counter = 0;
    let hasChanges = false;

    const updatedXml = xmlContent.replace(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g, (pMatch, pInner) => {
      const current_idx = p_counter;
      p_counter++;

      const translatedText = partTranslations[current_idx];
      if (translatedText === undefined) {
        return pMatch;
      }

      hasChanges = true;
      const updatedParagraphInner = replaceParagraphText(pInner, translatedText);

      const startTagMatch = pMatch.match(/^<a:p\b[^>]*>/);
      const startTag = startTagMatch ? startTagMatch[0] : '<a:p>';
      return `${startTag}${updatedParagraphInner}</a:p>`;
    });

    if (hasChanges) {
      zip.file(partPath, updatedXml);
    }
  };

  const unescapeXml = (safe: string): string => {
    return safe
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"');
  };

  const normalizeText = (text: string): string => text.replace(/[^\S\t]+/g, ' ').replace(/ *\t */g, '\t').trim();

  const getParagraphText = (pInner: string): string => {
    const parts: string[] = [];
    pInner.replace(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g, (tMatch, tContent) => {
      parts.push(unescapeXml(String(tContent)));
      return tMatch;
    });
    return normalizeText(parts.join(''));
  };

  const replaceParagraphText = (pInner: string, translatedText: string): string => {
    let t_counter = 0;
    return pInner.replace(/<a:t\b([^>]*)>([\s\S]*?)<\/a:t>/g, (tMatch, tAttrs) => {
      if (t_counter === 0) {
        t_counter++;
        const hasSpaceAttr = /xml:space=/.test(tAttrs);
        const newAttrs = hasSpaceAttr ? tAttrs : (tAttrs + ' xml:space="preserve"');
        return `<a:t${newAttrs}>${escapeXml(translatedText)}</a:t>`;
      }

      t_counter++;
      return `<a:t${tAttrs}></a:t>`;
    });
  };

  for (const slidePath of slideFiles) {
    const slideNum = parseInt(slidePath.match(slideRegex)![1], 10);
    const slideTranslations = translationsBySlide[slideNum];
    if (!slideTranslations) continue; // No translations on this slide
    await applyTranslationsToPart(slidePath, slideTranslations);
  }

  if (translationsByPart) {
    for (const [partPath, partTranslations] of Object.entries(translationsByPart)) {
      await applyTranslationsToPart(partPath, partTranslations);
    }
  }

  if (translationsByText && Object.keys(translationsByText).length > 0) {
    const normalizedTranslations = new Map<string, string>();
    for (const [source, translation] of Object.entries(translationsByText)) {
      const normalizedSource = normalizeText(source);
      const normalizedTranslation = normalizeText(translation);
      if (normalizedSource && normalizedTranslation && normalizedSource !== normalizedTranslation) {
        normalizedTranslations.set(normalizedSource, translation);
      }
    }

    const diagramFiles = Object.keys(zip.files).filter(name => /^ppt\/diagrams\/.+\.xml$/.test(name));
    for (const diagramPath of diagramFiles) {
      const partFile = zip.file(diagramPath);
      if (!partFile) continue;

      const xmlContent = await partFile.async('string');
      let hasChanges = false;
      const updatedXml = xmlContent.replace(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g, (pMatch, pInner) => {
        const sourceText = getParagraphText(pInner);
        const translatedText = normalizedTranslations.get(sourceText);
        if (!translatedText) return pMatch;

        hasChanges = true;
        const startTagMatch = pMatch.match(/^<a:p\b[^>]*>/);
        const startTag = startTagMatch ? startTagMatch[0] : '<a:p>';
        return `${startTag}${replaceParagraphText(pInner, translatedText)}</a:p>`;
      });

      if (hasChanges) {
        zip.file(diagramPath, updatedXml);
      }
    }
  }

  // PPTX files are ZIP packages. Explicitly keep XML parts compressed when
  // rebuilding, otherwise regenerated decks can be much larger than the input.
  return await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });
}
