import type { GlossaryTerm, TranslationDirection } from './db.js';

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const LATIN_RE = /[A-Za-z]/;

function hasCjk(text: string): boolean {
  return CJK_RE.test(text);
}

function hasLatin(text: string): boolean {
  return LATIN_RE.test(text);
}

export function shouldSwapToEnglishChineseOrder(source: string, target: string): boolean {
  return hasCjk(source) && hasLatin(target);
}

function swapGlossaryTerm(term: GlossaryTerm): GlossaryTerm {
  return {
    ...term,
    source: term.target,
    target: term.source,
    sourceLang: term.targetLang,
    targetLang: term.sourceLang,
    direction: 'bidirectional'
  };
}

export function normalizeEnglishChineseGlossaryTerm(term: GlossaryTerm): GlossaryTerm {
  const cleanTerm: GlossaryTerm = {
    ...term,
    source: String(term.source || '').trim(),
    target: String(term.target || '').trim(),
    direction: 'bidirectional'
  };
  return shouldSwapToEnglishChineseOrder(cleanTerm.source, cleanTerm.target)
    ? swapGlossaryTerm(cleanTerm)
    : cleanTerm;
}

export function orientGlossaryTermForTranslation(term: GlossaryTerm, direction: TranslationDirection): GlossaryTerm {
  const canonical = normalizeEnglishChineseGlossaryTerm(term);
  if (direction === 'zh-en' && hasLatin(canonical.source) && hasCjk(canonical.target)) {
    return swapGlossaryTerm(canonical);
  }
  return canonical;
}

export function bidirectionalGlossaryTermVariants(term: GlossaryTerm): GlossaryTerm[] {
  const canonical = normalizeEnglishChineseGlossaryTerm(term);
  if (!canonical.source || !canonical.target) return [];
  if (canonical.source.trim().toLowerCase() === canonical.target.trim().toLowerCase()) {
    return [canonical];
  }
  return [canonical, swapGlossaryTerm(canonical)];
}
