import { GlossaryTerm, SegmentTermHint, TranslationDomain } from "./db.js";

interface DeepSeekMessage {
  role: 'system' | 'user';
  content: string;
}

const DEFAULT_TRANSLATION_CONCURRENCY = 6;
const MIN_TRANSLATION_CONCURRENCY = 1;
const MAX_TRANSLATION_CONCURRENCY = 12;

export function getTranslationConcurrency(value = process.env.TRANSLATION_CONCURRENCY): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_TRANSLATION_CONCURRENCY;
  return Math.min(MAX_TRANSLATION_CONCURRENCY, Math.max(MIN_TRANSLATION_CONCURRENCY, parsed));
}

class DeepSeekApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = 'DeepSeekApiError';
  }
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.max(0, retryAt - Date.now());
}

function cleanJsonResponse(str: string): string {
  let cleaned = str.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```[a-zA-Z0-9]*\r?\n?/, "");
    cleaned = cleaned.replace(/\s*```$/, "");
  }
  return cleaned.trim();
}

async function callDeepSeek(
  messages: DeepSeekMessage[],
  responseFormatJson: boolean = false,
  options: { maxTokens?: number } = {}
): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("未配置 DEEPSEEK_API_KEY。请复制 .env.example 为 .env，并填写你的 API Key。");
  }

  const baseUrl = process.env.DEEPSEEK_API_BASE || "https://api.deepseek.com/v1";
  const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  const payload: any = {
    model: model,
    messages: messages,
    temperature: 0.1,
  };

  if (options.maxTokens) {
    payload.max_tokens = options.maxTokens;
  }

  if (responseFormatJson) {
    payload.response_format = { type: "json_object" };
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new DeepSeekApiError(
      `DeepSeek API request failed with status ${response.status}: ${errorText}`,
      response.status,
      parseRetryAfterMs(response.headers.get('retry-after'))
    );
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Invalid or empty response structure from DeepSeek API");
  }

  return content;
}

export interface TranslationResult {
  original: string;
  translation: string;
}

export interface TranslationOccurrenceContext {
  locationLabel?: string;
  containerTitle?: string;
  nearbyTexts?: string[];
  role?: string;
  previousSegmentText?: string;
  nextSegmentText?: string;
}

export interface TranslationTextContext {
  documentType?: 'pptx' | 'docx' | 'pdf' | 'xlsx';
  occurrences: TranslationOccurrenceContext[];
}

export type TranslationContextMap = Record<string, TranslationTextContext>;

export interface TranslationSegmentRequest {
  segmentId: string;
  sourceText: string;
  context?: TranslationTextContext;
  /** Only terms matched in this segment; never the complete project glossary. */
  termHints?: SegmentTermHint[];
}

function parseTranslationItems(parsedObject: any): any[] {
  const finalItems = parsedObject?.translations || parsedObject;
  if (Array.isArray(finalItems)) return finalItems;
  if (finalItems && typeof finalItems === "object") {
    return Object.entries(finalItems).map(([key, value]) => ({
      original: key,
      translation: value
    }));
  }
  return [];
}

function normalizeTranslationDomain(_domain: unknown): TranslationDomain {
  return 'business';
}

function inferTranslationDirection(sourceLang: string, targetLang: string): string {
  return `${sourceLang || 'English'}-${targetLang || 'Simplified Chinese'}`;
}

function domainLabel(_domain: TranslationDomain): string {
  return 'business/training presentation';
}

function domainGuidance(_domain: TranslationDomain, targetLang: string): string {
  return `Use professional business/training ${targetLang}. Preserve product, process, system, role, KPI, compliance, and operational terminology consistently.`;
  const targetIsEnglish = String(targetLang || '').toLowerCase().includes('english');
  return targetIsEnglish
    ? 'Use professional business/training English. Preserve product, process, system, role, KPI, compliance, and operational terminology consistently.'
    : '使用专业的商务/培训中文。产品、流程、系统、角色、KPI、合规和运营术语必须保持一致。';
}

function localizationGenerationGuidance(targetLang: string): string {
  const normalizedTarget = String(targetLang || '').toLowerCase();
  const isSimplifiedChinese = normalizedTarget.includes('chinese') || normalizedTarget.includes('zh');

  const baseGuidance = `**LOCALIZATION QUALITY PRIORITY**:
1. Preserve the full meaning and factual accuracy of the source.
2. Apply glossary terms according to domain context; do not force a glossary term when it clearly does not fit the concept in context.
3. Produce natural, professional ${targetLang} for business readers.
4. Use literal source wording only when it improves clarity or protects a required term/code.`;

  if (!isSimplifiedChinese) return baseGuidance;

  return `${baseGuidance}

**SIMPLIFIED CHINESE LOCALIZATION RULES**:
- Do not mirror English clause order mechanically.
- Reconstruct sentence order for native Chinese readers when needed.
- Move time, condition, process, and channel modifiers before the main action when this is more natural in Chinese.
- Convert long English noun phrases into natural Chinese verb-object or modifier-head structures.
- Avoid machine-translation-like phrasing such as awkward stacked "的" phrases, "在在线期间", or "通过...流程" when a smoother business Chinese structure is possible.
- Keep glossary terms consistent, but prioritize the correct business concept over word-by-word term matching.`;
}

function targetTermLanguage(targetLang: string): string {
  return targetLang || 'target language';
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function buildTranslationBatches(strings: string[], maxItems = 25, maxChars = 6000): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentChars = 0;

  for (const source of strings) {
    const nextChars = source.length;
    const wouldOverflow = current.length > 0 && (
      current.length >= maxItems || currentChars + nextChars > maxChars
    );
    if (wouldOverflow) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(source);
    currentChars += nextChars;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

function buildSegmentTranslationBatches(segments: TranslationSegmentRequest[], maxItems = 25, maxChars = 6000): TranslationSegmentRequest[][] {
  const batches: TranslationSegmentRequest[][] = [];
  let current: TranslationSegmentRequest[] = [];
  let currentChars = 0;

  for (const segment of segments) {
    const nextChars = segment.sourceText.length;
    const wouldOverflow = current.length > 0 && (
      current.length >= maxItems || currentChars + nextChars > maxChars
    );
    if (wouldOverflow) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(segment);
    currentChars += nextChars;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

function trimContextText(value: unknown, maxLength = 180): string | undefined {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function compactTranslationContext(context?: TranslationTextContext): TranslationTextContext | undefined {
  if (!context || !Array.isArray(context.occurrences) || context.occurrences.length === 0) {
    return undefined;
  }

  const occurrences = context.occurrences.slice(0, 3).map(occurrence => {
    const compactOccurrence: TranslationOccurrenceContext = {};
    const locationLabel = trimContextText(occurrence.locationLabel, 80);
    const containerTitle = trimContextText(occurrence.containerTitle, 160);
    const role = trimContextText(occurrence.role, 60);
    const previousSegmentText = trimContextText(occurrence.previousSegmentText, 160);
    const nextSegmentText = trimContextText(occurrence.nextSegmentText, 160);
    const nearbyTexts = (occurrence.nearbyTexts || [])
      .map(text => trimContextText(text, 120))
      .filter((text): text is string => Boolean(text))
      .slice(0, 6);

    if (locationLabel) compactOccurrence.locationLabel = locationLabel;
    if (containerTitle) compactOccurrence.containerTitle = containerTitle;
    if (role) compactOccurrence.role = role;
    if (previousSegmentText) compactOccurrence.previousSegmentText = previousSegmentText;
    if (nextSegmentText) compactOccurrence.nextSegmentText = nextSegmentText;
    if (nearbyTexts.length > 0) compactOccurrence.nearbyTexts = nearbyTexts;
    return compactOccurrence;
  }).filter(occurrence => Object.keys(occurrence).length > 0);

  if (occurrences.length === 0) return undefined;
  return {
    documentType: context.documentType,
    occurrences
  };
}

export async function runWithConcurrency<T>(
  total: number,
  limit: number,
  worker: (index: number) => Promise<T>,
  shouldStop?: () => boolean
): Promise<T[]> {
  const results: T[] = [];
  let nextIndex = 0;

  const runners = Array.from({ length: Math.min(limit, total) }, async () => {
    while (nextIndex < total) {
      if (shouldStop?.()) return;
      const index = nextIndex++;
      results.push(await worker(index));
    }
  });

  await Promise.all(runners);
  return results;
}

async function withExponentialRetry<T>(
  task: () => Promise<T>,
  label: string,
  maxAttempts = 3
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await task();
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts) break;
      const exponentialDelay = Math.min(8000, 800 * Math.pow(2, attempt - 1));
      const retryAfterDelay = err instanceof DeepSeekApiError && err.status === 429
        ? Math.min(60000, err.retryAfterMs ?? 0)
        : 0;
      const delay = Math.max(exponentialDelay, retryAfterDelay);
      console.warn(`${label} failed on attempt ${attempt}/${maxAttempts}. Retrying in ${delay}ms...`, err);
      await sleep(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} failed after ${maxAttempts} attempts.`);
}

export async function translateSegments(
  segments: TranslationSegmentRequest[],
  sourceLang: string,
  targetLang: string,
  tone: string,
  glossary: GlossaryTerm[],
  topic?: string,
  onBatchComplete?: (batchIndex: number, totalBatches: number, batchCount: number, newlyTranslated: Record<string, string>) => void,
  isIncremental: boolean = false,
  translationDomain: TranslationDomain = 'business',
  shouldPause?: () => boolean
): Promise<Record<string, string>> {
  if (segments.length === 0) return {};

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("未配置 DEEPSEEK_API_KEY。请复制 .env.example 为 .env，并填写你的 API Key。");
  }

  const results: Record<string, string> = {};
  const normalizedDomain = normalizeTranslationDomain(translationDomain);
  const direction = inferTranslationDirection(sourceLang, targetLang);
  const domain = domainLabel(normalizedDomain);
  const scenarioGuidance = domainGuidance(normalizedDomain, targetLang);
  const localizationGuidance = localizationGenerationGuidance(targetLang);
  const targetLanguage = targetTermLanguage(targetLang);
  const batches = buildSegmentTranslationBatches(segments, 25, 6000);
  // `glossary` remains in the function signature for API compatibility with
  // existing callers. Translation constraints now come from segment.termHints.
  void glossary;

  console.log(`Segment translation starting. Engine: DeepSeek exclusively. Total segments: ${segments.length}. Batches: ${batches.length}. Topic context: ${topic || "None"}. Incremental Flag: ${isIncremental}`);

  const translateBatch = async (batch: TranslationSegmentRequest[], bIndex: number) => withExponentialRetry(async () => {
    if (shouldPause?.()) return { bIndex, batchResults: {} };
    console.log(`Initiating segment translation batch ${bIndex + 1}/${batches.length} with ${batch.length} segment(s) (${batch.reduce((sum, segment) => sum + segment.sourceText.length, 0)} chars)...`);

    const batchPayload = batch.map((segment, itemIndex) => {
      const requestItemId = `b${bIndex + 1}_t${itemIndex + 1}`;
      const payloadItem: any = {
        requestItemId,
        id: requestItemId,
        segmentId: segment.segmentId,
        text: segment.sourceText
      };
      const context = compactTranslationContext(segment.context);
      if (context) payloadItem.context = context;
      const termHints = (segment.termHints || [])
        .filter(hint => hint.source && hint.target && hint.mode !== 'skipped')
        .map(hint => ({
          source: hint.source,
          target: hint.target,
          mode: hint.mode === 'candidate' ? 'candidate' : 'strict',
          ...(hint.explanation ? { explanation: hint.explanation } : {}),
          ...(hint.usageNote ? { usageNote: hint.usageNote } : {}),
          ...(hint.reason ? { reason: hint.reason } : {})
        }));
      if (termHints.length > 0) payloadItem.termHints = termHints;
      return payloadItem;
    });
    const idToSegment = new Map(batchPayload.map(item => [item.requestItemId, batch.find(segment => segment.segmentId === item.segmentId)!]));
    const segmentById = new Map(batch.map(segment => [segment.segmentId, segment]));

    const prompts: DeepSeekMessage[] = [
      {
        role: "system",
        content: `You are a business document localization assistant. Translate each occurrence-level segment from ${sourceLang} to ${targetLang}.

**TRANSLATION CONTEXT**:
- Direction: ${direction}
- Content scenario: ${domain}
- Target language: ${targetLang}. Every translated segment must be in ${targetLanguage}, except explicitly preserved names/codes/URLs.
- Tone: ${tone}
- Scenario guidance: ${scenarioGuidance}
${localizationGuidance}
${isIncremental ? `**CRITICAL INCREMENTAL DIRECTIVE**: This is a targeted retranslation request. Use the current document topic and the termHints attached to each segment. Do not reuse a previous translation if it conflicts with a strict term hint. Return a corrected translation for each input segment.` : ""}

**PRESERVATION RULES**:
${topic ? `- Document Core Topic: ${topic}\n` : ""}- Preserve URLs, raw technical parameters, SQL commands, variable names, unchanged file paths, product names, legal terms, formula notation, units, citations, and specific acronyms unless a glossary term explicitly says otherwise.
- Preserve tab characters (\\t) exactly in count and order. Translate the text around tabs, but do not replace tabs with spaces or remove them.
- Keep text concise. Do not add explanations that were not present in the source.
- Terminology is segment-scoped. Each input object may include a 'termHints' array. A hint with mode "strict" MUST be used when its source appears in that segment. A hint with mode "candidate" is advisory: choose the candidate that best fits the segment context, or use a natural translation when none fits. Never apply a term hint to another segment.

The user message is a JSON array of segment objects. Each object has:
- "requestItemId": stable request item id for this API call
- "segmentId": persistent occurrence-level segment id
- "text": exact source segment text to translate
- optional "context": document type and occurrence hints such as locationLabel, containerTitle, nearbyTexts, role, previousSegmentText, and nextSegmentText
- optional "termHints": only the glossary terms matched in this segment, each with source, target, mode, and optional explanation/usageNote/reason

Translate each segment as a standalone write-back unit, but use its context to produce natural localized target-language writing. The same source text may appear in multiple segments with different contexts and may need different translations.
You MUST return exactly one translation item for every input segmentId. Do not omit any segmentId. Do not change segmentId or requestItemId.
You MUST return a JSON object with a single "translations" key containing the array of translation results:
{
  "translations": [
    {
      "requestItemId": "same requestItemId from input",
      "segmentId": "same segmentId from input",
      "translation": "highly precise, translated counterpart"
    }
  ]
}
No other text outside this raw JSON structure.`
      },
      {
        role: "user",
        content: JSON.stringify(batchPayload)
      }
    ];

    const contentResponse = await callDeepSeek(prompts, true);
    const parsedObject = JSON.parse(cleanJsonResponse(contentResponse));
    const finalItems = parseTranslationItems(parsedObject);

    const batchResults: Record<string, string> = {};
    for (const item of finalItems) {
      if (!item) continue;
      const requestItemId = String(item.requestItemId || item.id || "");
      const segmentId = String(item.segmentId || "");
      const segment = segmentById.get(segmentId) || idToSegment.get(requestItemId);
      if (!segment) continue;
      batchResults[segment.segmentId] = String(item.translation || "").trim();
    }

    const missingSegments = batch.filter(segment => !batchResults[segment.segmentId] || batchResults[segment.segmentId].trim() === "");

    if (missingSegments.length > 0 && !shouldPause?.()) {
      console.warn(`DeepSeek segment batch ${bIndex + 1} omitted ${missingSegments.length} segment(s). Retrying individually...`);
      for (let i = 0; i < missingSegments.length; i++) {
        if (shouldPause?.()) break;
        const segment = missingSegments[i];
        const retryId = `retry_${bIndex + 1}_${i + 1}`;
        const retryMessages: DeepSeekMessage[] = [
          prompts[0],
          {
            role: "user",
            content: JSON.stringify([{
              requestItemId: retryId,
              id: retryId,
              segmentId: segment.segmentId,
              text: segment.sourceText,
              ...(compactTranslationContext(segment.context) ? { context: compactTranslationContext(segment.context) } : {}),
              ...(segment.termHints && segment.termHints.length > 0
                ? { termHints: segment.termHints.filter(hint => hint.mode !== 'skipped') }
                : {})
            }])
          }
        ];
        const retryTranslation = await withExponentialRetry(async () => {
          const retryResponse = await callDeepSeek(retryMessages, true);
          const retryParsed = JSON.parse(cleanJsonResponse(retryResponse));
          const retryItems = parseTranslationItems(retryParsed);
          const retryItem = retryItems.find(item => item && String(item.segmentId || "") === segment.segmentId)
            || retryItems.find(item => item && String(item.requestItemId || item.id || "") === retryId)
            || retryItems[0];
          const translated = retryItem?.translation ? String(retryItem.translation).trim() : "";
          if (!translated) {
            throw new Error(`DeepSeek segment batch ${bIndex + 1} did not return a translation for segment: ${segment.segmentId}`);
          }
          return translated;
        }, `DeepSeek segment individual retry ${retryId}`, 3);
        batchResults[segment.segmentId] = retryTranslation;
      }
    }

    if (onBatchComplete) {
      onBatchComplete(bIndex, batches.length, batch.length, batchResults);
    }

    return { bIndex, batchResults };
  }, `DeepSeek segment batch ${bIndex + 1}`, 3);

  const batchOuts = await runWithConcurrency(
    batches.length,
    getTranslationConcurrency(),
    index => translateBatch(batches[index], index),
    shouldPause
  );

  for (let bIndex = 0; bIndex < batches.length; bIndex++) {
    const batch = batches[bIndex];
    const match = batchOuts.find(o => o.bIndex === bIndex);
    const batchResults = match ? match.batchResults : {};

    for (const segment of batch) {
      if (batchResults[segment.segmentId]) {
        results[segment.segmentId] = batchResults[segment.segmentId];
      } else if (!shouldPause?.()) {
        throw new Error(`Missing translation result for segment: ${segment.segmentId}`);
      }
    }
  }

  return results;
}

export async function translateStrings(
  strings: string[],
  sourceLang: string,
  targetLang: string,
  tone: string,
  glossary: GlossaryTerm[],
  topic?: string,
  onBatchComplete?: (batchIndex: number, totalBatches: number, batchCount: number, newlyTranslated: Record<string, string>) => void,
  isIncremental: boolean = false,
  translationDomain: TranslationDomain = 'business',
  textContexts: TranslationContextMap = {}
): Promise<Record<string, string>> {
  if (strings.length === 0) return {};

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("未配置 DEEPSEEK_API_KEY。请复制 .env.example 为 .env，并填写你的 API Key。");
  }

  const results: Record<string, string> = {};
  const normalizedDomain = normalizeTranslationDomain(translationDomain);
  const direction = inferTranslationDirection(sourceLang, targetLang);
  const domain = domainLabel(normalizedDomain);
  const scenarioGuidance = domainGuidance(normalizedDomain, targetLang);
  const localizationGuidance = localizationGenerationGuidance(targetLang);
  const targetLanguage = targetTermLanguage(targetLang);

  // Group unique strings by both item count and character volume. Large Office
  // documents often contain long text boxes where a fixed item-count batch can
  // exceed the model's comfortable response size and cause omitted ids.
  const batches = buildTranslationBatches(strings, 25, 6000);

  // Build glossary text description. Active terms are binding; candidate terms
  // are contextual options for ambiguous abbreviations or unresolved conflicts.
  const strictGlossary = glossary.filter(term =>
    term.status !== 'candidate' && term.status !== 'ambiguous' && term.status !== 'needs_review'
  );
  const candidateGlossary = glossary.filter(term =>
    term.status === 'candidate' || term.status === 'ambiguous' || term.status === 'needs_review'
  );
  const formatGlossaryTerm = (term: GlossaryTerm) => {
    const explanation = term.explanation || (term as any).description || "";
    const source = String(term.source || '').trim();
    const lowerSource = source.toLowerCase();
    const derivedExamples = lowerSource.endsWith('e')
      ? [`${source}d`, `${source.slice(0, -1)}ing`, `${source.slice(0, -1)}ion`, `${source.slice(0, -1)}ions`]
      : [`${source}s`, `${source}ed`, `${source}ing`, `${source}ion`, `${source}ions`];
    const inflectionNote = String(sourceLang || '').toLowerCase().includes('english') && /^[a-z]+$/i.test(source) && source.length >= 4
      ? `\n  Also apply to normal inflected/derived forms such as ${derivedExamples.map(example => `"${example}"`).join(', ')} when they appear in source text.`
      : "";
    return `- Source: "${term.source}"\n  Target: "${term.target}"${inflectionNote}${explanation ? `\n  Explanation: "${explanation}"` : ""}`;
  };
  const strictGlossaryText = strictGlossary.length > 0
    ? strictGlossary.map(formatGlossaryTerm).join('\n')
    : "No strict glossary terms provided.";
  const candidateGlossaryText = candidateGlossary.length > 0
    ? candidateGlossary.map(formatGlossaryTerm).join('\n')
    : "No contextual glossary candidates provided.";

  console.log(`Translate system starting. Engine: DeepSeek exclusively. Total items: ${strings.length}. Batches: ${batches.length}. Topic context: ${topic || "None"}. Incremental Flag: ${isIncremental}`);

  // Run batches in parallel, but fail loudly if any batch cannot be translated.
  // Returning the original text as a silent fallback makes downstream QA look greener
  // than it really is, which is dangerous for a translation product.
  const translateBatch = async (batch: string[], bIndex: number) => withExponentialRetry(async () => {
    console.log(`Initiating translation batch ${bIndex + 1}/${batches.length} with ${batch.length} items (${batch.reduce((sum, text) => sum + text.length, 0)} chars)...`);

    const batchPayload = batch.map((text, itemIndex) => {
      const payloadItem: any = {
        id: `b${bIndex + 1}_t${itemIndex + 1}`,
        text
      };
      const context = compactTranslationContext(textContexts[text]);
      if (context) {
        payloadItem.context = context;
      }
      return payloadItem;
    });
    const idToSource = new Map(batchPayload.map(item => [item.id, item.text]));

    const prompts: DeepSeekMessage[] = [
      {
        role: "system",
        content: `You are a business presentation slide localization Assistant. Translate the input list of unique text fields from ${sourceLang} to ${targetLang}.

**TRANSLATION CONTEXT**:
- Direction: ${direction}
- Content scenario: ${domain}
- Target language: ${targetLang}. Every translated field must be in ${targetLanguage}, except explicitly preserved names/codes/URLs.
- Tone: ${tone}
- Scenario guidance: ${scenarioGuidance}
${localizationGuidance}
${isIncremental ? `**CRITICAL INCREMENTAL DIRECTIVE**: This is a targeted retranslation request. Use the current document topic, the provided glossary, and the latest terminology mappings. Do not reuse a previous translation if it conflicts with the glossary. Return a corrected translation for each input item.` : ""}

**PRESERVATION RULES**:
${topic ? `- Presentation Core Topic: ${topic}\n` : ""}- Preserve URLs, raw technical parameters, SQL commands, variable names, unchanged file paths, product names, legal terms, formula notation, units, citations, and specific acronyms unless a glossary term explicitly says otherwise.
- Preserve tab characters (\\t) exactly in count and order. Translate the text around tabs, but do not replace tabs with spaces or remove them.
- Keep slide text concise. Do not add explanations that were not present in the source.
- Strict Glossary Rules: You MUST use these terms whenever their source appears in the text. Use the target term consistently, adjusting only surrounding grammar when necessary, and use the explanation to understand scope:
${strictGlossaryText}

- Contextual Glossary Candidates: These are possible translations for ambiguous terms or abbreviations. Choose the target whose explanation best matches the current source text, document topic, and scenario. Do not blindly apply the first candidate:
${candidateGlossaryText}

The user message is a JSON array of objects. Each object has:
- "id": stable item id
- "text": exact source text to translate
- optional "context": document type and occurrence hints such as locationLabel, containerTitle, nearbyTexts, and role

Translate each text as a standalone write-back unit, but use both the source text and its context to produce natural localized target-language writing. Treat nearby texts, titles/headings, location labels, and roles as disambiguation signals for business objects, process steps, system UI labels, table cells, SmartArt nodes, and short phrases. Do not translate nearbyTexts themselves unless they are the item text.
You MUST return exactly one translation item for every input id. Do not omit any ids. Do not change ids.
You MUST return a JSON object with a single "translations" key containing the array of translation results:
{
  "translations": [
    {
      "id": "same id from input",
      "translation": "highly precise, translated counterpart"
    }
  ]
}
No other text outside this raw JSON structure.`
      },
      {
        role: "user",
        content: JSON.stringify(batchPayload)
      }
    ];

    const contentResponse = await callDeepSeek(prompts, true);
    const parsedObject = JSON.parse(cleanJsonResponse(contentResponse));
    const finalItems = parseTranslationItems(parsedObject);

    const batchResults: Record<string, string> = {};
    for (const item of finalItems) {
      if (!item) continue;
      if (item.id && idToSource.has(String(item.id))) {
        const source = idToSource.get(String(item.id))!;
        batchResults[source] = String(item.translation || "").trim();
      } else if (item.original && batch.includes(item.original)) {
        // Backward-compatible fallback if the model returns the older format.
        batchResults[item.original] = String(item.translation || "").trim();
      }
    }

    const missingSources: string[] = [];
    for (const source of batch) {
      if (!batchResults[source] || batchResults[source].trim() === "") {
        missingSources.push(source);
      }
    }

    if (missingSources.length > 0) {
      console.warn(`DeepSeek batch ${bIndex + 1} omitted ${missingSources.length} items. Retrying individually...`);
      for (let i = 0; i < missingSources.length; i++) {
        const source = missingSources[i];
        const retryId = `retry_${bIndex + 1}_${i + 1}`;
        const retryMessages: DeepSeekMessage[] = [
          prompts[0],
          {
            role: "user",
            content: JSON.stringify([{
              id: retryId,
              text: source,
              ...(compactTranslationContext(textContexts[source]) ? { context: compactTranslationContext(textContexts[source]) } : {})
            }])
          }
        ];
        const retryTranslation = await withExponentialRetry(async () => {
          const retryResponse = await callDeepSeek(retryMessages, true);
          const retryParsed = JSON.parse(cleanJsonResponse(retryResponse));
          const retryItems = parseTranslationItems(retryParsed);
          const retryItem = retryItems.find(item => item && String(item.id) === retryId) || retryItems[0];
          const translated = retryItem?.translation ? String(retryItem.translation).trim() : "";
          if (!translated) {
            throw new Error(`DeepSeek batch ${bIndex + 1} did not return a translation for: ${source}`);
          }
          return translated;
        }, `DeepSeek individual retry ${retryId}`, 3);
        batchResults[source] = retryTranslation;
        }
      }

      if (onBatchComplete) {
        onBatchComplete(bIndex, batches.length, batch.length, batchResults);
      }

    return { bIndex, batchResults };
  }, `DeepSeek batch ${bIndex + 1}`, 3);

  const batchOuts = await runWithConcurrency(
    batches.length,
    getTranslationConcurrency(),
    index => translateBatch(batches[index], index)
  );

  // Combine and map results back matching original inputs exactly
  for (let bIndex = 0; bIndex < batches.length; bIndex++) {
    const batch = batches[bIndex];
    const match = batchOuts.find(o => o.bIndex === bIndex);
    const batchResults = match ? match.batchResults : {};

    for (const str of batch) {
      if (batchResults[str]) {
        results[str] = batchResults[str];
      } else {
        throw new Error(`Missing translation result for: ${str}`);
      }
    }
  }

  return results;
}

export interface PreDetectResult {
  topic_keywords: string[];
  description: string;
  recommendedGlossary: {
    source: string;
    target: string;
    category: string;
    explanation?: string;
    sourceLang?: string;
    targetLang?: string;
    direction?: string | 'bidirectional';
  }[];
}

export interface GlossaryConflictDecision {
  source: string;
  selectedTarget: string;
  confidence: number;
  reason: string;
}

export async function resolveGlossaryConflicts(
  reviewCandidates: {
    source: string;
    occurrences: { slideNum: number; text: string }[];
    candidates: GlossaryTerm[];
  }[],
  topic?: string
): Promise<GlossaryConflictDecision[]> {
  if (reviewCandidates.length === 0) return [];

  const messages: DeepSeekMessage[] = [
    {
      role: "system",
      content: `You are a terminology disambiguation assistant for enterprise presentation translation.
For each ambiguous glossary source term, choose the best target-language term based on:
- document topic
- occurrence text and slide numbers
- candidate explanations, including acronym full forms when available

Return raw JSON only:
{
  "decisions": [
    {
      "source": "exact source term",
      "selectedTarget": "chosen target",
      "confidence": 0.0,
      "reason": "short reason grounded in the provided context"
    }
  ]
}

Use confidence >= 0.85 only when the context clearly supports one target. If context is weak, choose the most likely target but use a lower confidence.`
    },
    {
      role: "user",
      content: JSON.stringify({
        topic: topic || "Unknown",
        ambiguousTerms: reviewCandidates.slice(0, 40).map(candidate => ({
          source: candidate.source,
          occurrences: candidate.occurrences,
          candidates: candidate.candidates.map(term => ({
            target: term.target,
            explanation: term.explanation || (term as any).description || ""
          }))
        }))
      })
    }
  ];

  try {
    const content = await callDeepSeek(messages, true, { maxTokens: 10000 });
    const parsed = JSON.parse(cleanJsonResponse(content));
    return Array.isArray(parsed.decisions) ? parsed.decisions.map((decision: any) => ({
      source: String(decision.source || ""),
      selectedTarget: String(decision.selectedTarget || ""),
      confidence: Number(decision.confidence || 0),
      reason: String(decision.reason || "")
    })).filter((decision: GlossaryConflictDecision) => decision.source && decision.selectedTarget) : [];
  } catch (err) {
    console.error("DeepSeek glossary conflict resolution failed:", err);
    return [];
  }
}

export async function runPreDetection(
  texts: string[],
  sourceLang: string = "English",
  targetLang: string = "Simplified Chinese",
  translationDomain: TranslationDomain = 'business'
): Promise<PreDetectResult> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("未配置 DEEPSEEK_API_KEY。请复制 .env.example 为 .env，并填写你的 API Key。");
  }

  // Clean up empty strings or ultra-short ones. Pre-detection runs during upload,
  // so keep the sample compact and representative rather than exhaustive.
  const uniqueTexts = Array.from(new Set(texts)).filter(t => t && t.trim().length > 1);
  const sampleTexts: string[] = [];
  let sampleChars = 0;
  for (const text of uniqueTexts) {
    if (sampleTexts.length >= 40 || sampleChars >= 6000) break;
    const compact = text.replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!compact) continue;
    sampleTexts.push(compact);
    sampleChars += compact.length;
  }

  const normalizedDomain = normalizeTranslationDomain(translationDomain);
  const direction = inferTranslationDirection(sourceLang, targetLang);
  const domain = domainLabel(normalizedDomain);
  const termLanguage = targetTermLanguage(targetLang);

  console.log(`Pre-detection analysis starting. Engine: DeepSeek exclusively. Direction: ${direction}. Domain: ${normalizedDomain}.`);

  const messages: DeepSeekMessage[] = [
    {
      role: "system",
      content: `# Role
You are a senior terminology and enterprise localization analyst for ${domain} document translation.

# Task
# Task
Analyze the provided document text and build a high-value, context-aware glossary for translation from ${sourceLang} to ${targetLang}.

Your goal is NOT to extract many words.
Your goal is to identify terms that, if translated inconsistently or literally, would cause business misunderstanding, review rework, or machine-translation-like output.

### 1. Document Profiling
- **Keywords**: 1 to 5 core topical keywords. Extract fewer if the text is short.
- **Description**: A 1-sentence summary of the content and context.

### 2. Terminology Extraction
- **Rule**: Extract ONLY specialized, unique, high-value terms that should be translated consistently (Max 15).
- **Domain focus**: Include product, system, process, role, KPI, compliance, finance, operations, sales, training, implementation, and company-specific business terms.
- **Filter**: Strictly EXCLUDE common everyday words, human names, and locations.
- **Note**: Quality over quantity. Output 0 terms if no meaningful business terminology exists.

For each term, provide:
- \`source\`: Exact source term in ${sourceLang}.
- \`target\`: Recommended ${termLanguage} translation.
- \`category\`: Exactly one of: [Product / System, Code / Acronym, Domain Term, Company / Internal, Other]
- \`explanation\`: Concise explanation in ${targetLang}. Explain why this target term is suitable in the current business context. If acronym, include the full form when known.
- \`sourceLang\`: "${sourceLang}"
- \`targetLang\`: "${targetLang}"
- \`direction\`: "${direction}"

# Output Format
Output a single, valid, raw JSON object. No markdown code blocks (\`\`\`json), no conversational text.

{
  "topic_keywords": ["core topic"],
  "description": "A brief summary of the text.",
  "recommendedGlossary": [
    {
      "source": "exact term from source",
      "target": "recommended target term",
      "category": "Domain Term",
      "explanation": "Concise explanation.",
      "sourceLang": "${sourceLang}",
      "targetLang": "${targetLang}",
      "direction": "${direction}"
    }
  ]
}`
    },
    {
      role: "user",
      content: `Sample unique texts to inspect:\n${JSON.stringify(sampleTexts, null, 2)}`
    }
  ];

  try {
    const content = await callDeepSeek(messages, true, { maxTokens: 10000 });
    const parsed = JSON.parse(cleanJsonResponse(content));
    return {
      topic_keywords: Array.isArray(parsed.topic_keywords)
        ? parsed.topic_keywords.map((keyword: any) => String(keyword)).filter(Boolean).slice(0, 5)
        : (parsed.topic ? [String(parsed.topic)] : ["Presentation Slides"]),
      description: parsed.description || parsed.file_description || "Presentation document slides with structured context.",
      recommendedGlossary: parsed.recommendedGlossary || []
    };
  } catch (err) {
    console.error("DeepSeek Pre-detection failed:", err);
  }

// Safe fallback if the engine completely fails. Do not seed fake terminology.
  return {
    topic_keywords: ["Business Slide Deck"],
    description: `${domain} with structured slide context.`,
    recommendedGlossary: []
  };
}
