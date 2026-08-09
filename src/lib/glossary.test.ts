import { isGlossaryTermMatch, normalizeGlossaryCategory, getGlossaryCategoryLabel } from './glossary.js';

const matchCases: Array<[string | null | undefined, string | null | undefined, boolean]> = [
  // Word-boundary matching for Latin terms
  ['We use SAP GUI daily', 'SAP GUI', true],
  ['SAPGUI is legacy', 'SAP GUI', false],
  ['We translated the deck', 'translate', true],
  ['Translating documents', 'translate', true],
  ['translation memory', 'translate', true],
  ['the untranslated text', 'translate', false],
  ['The cats sleep', 'cat', false],
  // CJK terms match as substrings
  ['文档专业翻译工具', '专业翻译', true],
  ['文档翻译工具', '专业翻译', false],
  // Empty / null inputs never match
  ['', 'translate', false],
  [null, 'translate', false],
  ['some text', '', false]
];

for (const [text, term, expected] of matchCases) {
  const actual = isGlossaryTermMatch(text, term);
  if (actual !== expected) {
    throw new Error(`Expected isGlossaryTermMatch(${JSON.stringify(text)}, ${JSON.stringify(term)}) to be ${expected}, received ${actual}.`);
  }
}

const categoryCases: Array<[string | undefined, string]> = [
  ['产品与品牌名', 'Product & Brand'],
  ['Product & Brand', 'Product & Brand'],
  ['Product / System', 'Product & Brand'],
  ['Code / Acronym', 'Code & Acronym'],
  ['Domain Term', 'Industry Domain'],
  ['行业垂直术语', 'Industry Domain'],
  ['企业内部/自定义', 'Company Internal'],
  ['其它', 'Other'],
  ['finance jargon', 'Other'],
  [undefined, 'Other']
];

for (const [input, expected] of categoryCases) {
  const actual = normalizeGlossaryCategory(input);
  if (actual !== expected) {
    throw new Error(`Expected normalizeGlossaryCategory(${JSON.stringify(input)}) to be ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`);
  }
}

const labelCases: Array<[string | undefined, string]> = [
  ['Product & Brand', '产品与品牌名'],
  ['行业垂直术语', '行业垂直术语'],
  ['Treasury Jargon', 'Treasury Jargon'],
  [undefined, '其它']
];

for (const [input, expected] of labelCases) {
  const actual = getGlossaryCategoryLabel(input);
  if (actual !== expected) {
    throw new Error(`Expected getGlossaryCategoryLabel(${JSON.stringify(input)}) to be ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`);
  }
}

console.log('shared glossary helpers: ok');
