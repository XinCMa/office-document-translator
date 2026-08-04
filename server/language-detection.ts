import path from 'path';

export const SUPPORTED_LANGUAGES = ['English', 'Simplified Chinese', 'French', 'Japanese', 'Italian', 'Arabic'] as const;
export type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];

const LANGUAGE_WORDS: Record<'English' | 'French' | 'Italian', Set<string>> = {
  English: new Set([
    'the', 'and', 'of', 'to', 'in', 'for', 'with', 'is', 'are', 'this', 'that', 'from', 'on', 'by',
    'as', 'not', 'or', 'you', 'your', 'we', 'our', 'will', 'can', 'must', 'between', 'into', 'through'
  ]),
  French: new Set([
    'le', 'les', 'de', 'des', 'du', 'un', 'une', 'et', 'est', 'sont', 'pour', 'avec', 'dans', 'sur',
    'que', 'qui', 'ce', 'cette', 'ces', 'par', 'pas', 'plus', 'au', 'aux', 'en', 'votre', 'vous',
    'nous', 'entre', 'comme', 'afin', 'doit', 'peut', 'tous', 'toutes', 'leur', 'leurs', 'sans'
  ]),
  Italian: new Set([
    'il', 'lo', 'gli', 'di', 'del', 'della', 'dei', 'delle', 'un', 'una', 'sono', 'per', 'con', 'nel',
    'nella', 'che', 'chi', 'questo', 'questa', 'questi', 'queste', 'dal', 'dalla', 'non', 'piu', 'tra',
    'come', 'deve', 'puo', 'tutti', 'tutte', 'loro', 'senza', 'anche', 'alla', 'alle', 'sul', 'sulla'
  ])
};

export function normalizeLanguage(raw: unknown, fallback: SupportedLanguage = 'Simplified Chinese'): SupportedLanguage {
  const value = String(raw || '').trim().toLowerCase();
  if (['en', 'eng', 'english'].includes(value)) return 'English';
  if (['zh', 'zh-cn', 'cn', 'chinese', 'simplified chinese'].includes(value)) return 'Simplified Chinese';
  if (['fr', 'fra', 'fre', 'french', 'francais', 'français'].includes(value)) return 'French';
  if (['ja', 'jp', 'jpn', 'japanese'].includes(value)) return 'Japanese';
  if (['it', 'ita', 'italian', 'italiano'].includes(value)) return 'Italian';
  if (['ar', 'ara', 'arabic', 'العربية', '阿拉伯语'].includes(value)) return 'Arabic';
  return fallback;
}

function detectFilenameLanguage(originalName?: string): SupportedLanguage | null {
  const baseName = path.basename(String(originalName || ''), path.extname(String(originalName || ''))).toLowerCase();
  const localeToken = (token: string) => new RegExp(`(?:^|[._\\-\\s])${token}(?=$|[._\\-\\s])`, 'i').test(baseName);

  if (localeToken('fr(?:[-_]?(?:fr|ca|be|ch))?') || /(?:french|français|francais)/i.test(baseName)) return 'French';
  if (localeToken('it(?:[-_]?(?:it|ch))?') || /(?:italian|italiano)/i.test(baseName)) return 'Italian';
  if (localeToken('ja(?:[-_]?jp)?') || /japanese/i.test(baseName)) return 'Japanese';
  if (localeToken('ar(?:[-_]?(?:sa|ae|eg|ma))?') || /(?:arabic|العربية)/i.test(baseName)) return 'Arabic';
  if (localeToken('zh(?:[-_]?(?:cn|hans))?') || /(?:chinese|simplified[._\-\s]?chinese)/i.test(baseName)) return 'Simplified Chinese';
  if (localeToken('en(?:[-_]?(?:us|gb|uk|au))?') || /english/i.test(baseName)) return 'English';
  return null;
}

type LatinLanguage = 'English' | 'French' | 'Italian';

export type LanguageEvidence = {
  scores: Record<LatinLanguage, number>;
  latinWordCount: number;
  cjkCount: number;
  japaneseCount: number;
  arabicCount: number;
};

function scoreLatinLanguages(sample: string): Record<LatinLanguage, number> {
  const normalized = sample.normalize('NFKD').toLowerCase();
  const words = normalized.match(/\p{L}+/gu) || [];
  const scores = { English: 0, French: 0, Italian: 0 };

  for (const word of words) {
    for (const language of Object.keys(LANGUAGE_WORDS) as Array<keyof typeof LANGUAGE_WORDS>) {
      if (LANGUAGE_WORDS[language].has(word)) scores[language] += 1;
    }
  }

  scores.French += ((sample.match(/[àâçéèêëîïôûùüÿœæ]/gi) || []).length * 1.5);
  scores.Italian += ((sample.match(/[àèéìíîòóù]/gi) || []).length * 0.75);
  scores.French += ((sample.match(/\b(?:qu|l|d|j|n|s|c)'/gi) || []).length * 0.75);
  scores.Italian += ((sample.match(/\b(?:dell|all|nell|sull|l)'/gi) || []).length * 1.25);
  return scores;
}

export function getLanguageEvidence(sample: string): LanguageEvidence {
  return {
    scores: scoreLatinLanguages(sample),
    latinWordCount: (sample.match(/\p{L}+/gu) || []).filter(word => /[A-Za-z]/.test(word)).length,
    cjkCount: (sample.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length,
    japaneseCount: (sample.match(/[\u3040-\u30ff]/g) || []).length,
    arabicCount: (sample.match(/[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/g) || []).length
  };
}

export function hasLikelyResidualLanguage(
  text: string,
  sourceLang: SupportedLanguage,
  targetLang: SupportedLanguage
): boolean {
  if (!text.trim() || sourceLang === targetLang) return false;

  const evidence = getLanguageEvidence(text);
  if (sourceLang === 'Japanese') return evidence.japaneseCount >= 2;
  if (sourceLang === 'Arabic') return evidence.arabicCount >= 2;
  if (sourceLang === 'Simplified Chinese') {
    return targetLang !== 'Japanese' && evidence.cjkCount >= 2;
  }

  const sourceScore = evidence.scores[sourceLang];
  const targetScore = targetLang === 'English' || targetLang === 'French' || targetLang === 'Italian'
    ? evidence.scores[targetLang]
    : 0;
  const minimumSourceScore = 2;

  return sourceScore >= minimumSourceScore && sourceScore >= targetScore + 1;
}

export function detectSourceLanguageFromTexts(
  texts: string[],
  targetLang: SupportedLanguage,
  originalName?: string
): SupportedLanguage {
  const filenameLanguage = detectFilenameLanguage(originalName);
  if (filenameLanguage) return filenameLanguage;

  const sample = texts
    .filter(text => text && text.trim().length > 0)
    .slice(0, 300)
    .join('\n');
  const evidence = getLanguageEvidence(sample);
  const japaneseCount = evidence.japaneseCount;
  const cjkCount = evidence.cjkCount;
  const arabicCount = evidence.arabicCount;
  const latinCount = (sample.match(/[A-Za-z]/g) || []).length;

  if (japaneseCount >= 8) return 'Japanese';
  if (arabicCount >= 8) return 'Arabic';
  if (cjkCount >= 12 && cjkCount >= latinCount * 0.45) return 'Simplified Chinese';

  const scores = evidence.scores;
  const ranked = (Object.entries(scores) as Array<['English' | 'French' | 'Italian', number]>)
    .sort((a, b) => b[1] - a[1]);
  const [bestLanguage, bestScore] = ranked[0];
  const secondScore = ranked[1]?.[1] || 0;

  if (bestScore >= 3 && bestScore - secondScore >= 1) return bestLanguage;
  if (bestScore >= 5) return bestLanguage;
  return targetLang === 'English' && scores.French > 0 ? 'French' : 'English';
}
