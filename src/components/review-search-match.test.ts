import { isLiteralSearchMatch } from './ReviewTable.js';

const cases: Array<[string, string, boolean]> = [
  ['PowerPoint Translator', 'powerpoint', true],
  ['PowerPoint Translator', 'POINT TRANS', true],
  ['PowerPoint Translator', 'pwerpoint', false],
  ['PowerPoint Translator', 'p-o-w-e-r', false],
  ['文档专业翻译', '专业翻译', true],
  ['文档专业翻译', '文翻', false]
];

for (const [text, search, expected] of cases) {
  const actual = isLiteralSearchMatch(text, search);
  if (actual !== expected) {
    throw new Error(`Expected ${JSON.stringify(search)} in ${JSON.stringify(text)} to be ${expected}, received ${actual}.`);
  }
}

console.log('review literal search matching: ok');
