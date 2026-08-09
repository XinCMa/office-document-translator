// Shared glossary helpers used by App, ReviewTable, UploadView and
// GlossaryManager. Canonical category values are the English keys; Chinese
// strings are display labels only. Legacy/AI-generated category strings
// (Chinese labels, old English variants such as "Code / Acronym" or
// "Domain Term") are normalized back to the canonical keys.

export const GLOSSARY_CATEGORY_KEYS = [
  'Product & Brand',
  'Code & Acronym',
  'Industry Domain',
  'Company Internal',
  'Other',
] as const;

export type GlossaryCategoryKey = (typeof GLOSSARY_CATEGORY_KEYS)[number];

export const GLOSSARY_CATEGORY_LABELS: Record<GlossaryCategoryKey, string> = {
  'Product & Brand': '产品与品牌名',
  'Code & Acronym': '代号与专业缩写',
  'Industry Domain': '行业垂直术语',
  'Company Internal': '企业内部/自定义',
  'Other': '其它',
};

export const DEFAULT_GLOSSARY_CATEGORY: GlossaryCategoryKey = GLOSSARY_CATEGORY_KEYS[0];

function matchGlossaryCategory(desc: string): GlossaryCategoryKey | null {
  const d = desc.trim();
  if (!d) return null;
  for (const key of GLOSSARY_CATEGORY_KEYS) {
    const label = GLOSSARY_CATEGORY_LABELS[key];
    if (d === key || d.includes(label) || label.includes(d)) return key;
  }
  const lower = d.toLowerCase();
  if (lower.includes('brand') || lower.includes('product') || lower.includes('system') || lower.includes('品牌') || lower.includes('产品'))
    return 'Product & Brand';
  if (lower.includes('acronym') || lower.includes('code') || lower.includes('abbreviation') || lower.includes('缩写') || lower.includes('代号') || lower.includes('代码'))
    return 'Code & Acronym';
  if (lower.includes('industry') || lower.includes('domain') || lower.includes('term') || lower.includes('垂直') || lower.includes('专业') || lower.includes('行业') || lower.includes('术语'))
    return 'Industry Domain';
  if (lower.includes('company') || lower.includes('internal') || lower.includes('custom') || lower.includes('内部') || lower.includes('自定义'))
    return 'Company Internal';
  if (lower.includes('other') || lower.includes('其它') || lower.includes('其他'))
    return 'Other';
  return null;
}

export function normalizeGlossaryCategory(desc: string | undefined | null): GlossaryCategoryKey {
  return (desc && matchGlossaryCategory(desc)) || 'Other';
}

export function getGlossaryCategoryLabel(category?: string): string {
  if (!category) return GLOSSARY_CATEGORY_LABELS.Other;
  // Unknown free-form categories are shown as-is instead of being collapsed
  // into "其它", so imported custom values stay visible to the user.
  const canonical = matchGlossaryCategory(category);
  return canonical ? GLOSSARY_CATEGORY_LABELS[canonical] : category;
}

// Precise word boundary mapping to avoid overly broad matching in incremental
// segments. CJK terms match as substrings; Latin terms match on word
// boundaries with common inflection suffixes (translate -> translates,
// translated, translating, translation, ...).
export function isGlossaryTermMatch(text: string | null | undefined, term: string | null | undefined): boolean {
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
