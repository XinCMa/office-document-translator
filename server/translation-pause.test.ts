import { getModelApiConfig, getTranslationConcurrency, runWithConcurrency } from './translator.js';

const genericConfig = getModelApiConfig({
  AI_API_KEY: 'generic-key',
  AI_API_BASE: 'https://example.com/v1',
  AI_MODEL: 'example-model',
  AI_API_PROVIDER: 'Example Provider'
});

if (genericConfig.apiKey !== 'generic-key'
  || genericConfig.baseUrl !== 'https://example.com/v1'
  || genericConfig.model !== 'example-model'
  || genericConfig.providerName !== 'Example Provider') {
  throw new Error(`Generic model configuration was not preferred: ${JSON.stringify(genericConfig)}`);
}

const concurrencyCases: Array<[string | undefined, number]> = [
  [undefined, 6],
  ['8', 8],
  ['0', 1],
  ['99', 12],
  ['invalid', 6]
];

for (const [value, expected] of concurrencyCases) {
  const actual = getTranslationConcurrency(value);
  if (actual !== expected) {
    throw new Error(`Unexpected concurrency for ${String(value)}: expected ${expected}, got ${actual}`);
  }
}

let pauseRequested = false;
const started: number[] = [];

const results = await runWithConcurrency(
  8,
  2,
  async index => {
    started.push(index);
    await Promise.resolve();
    if (index === 0) pauseRequested = true;
    return index;
  },
  () => pauseRequested
);

if (started.length > 2) {
  throw new Error(`Pause dispatched too many batches: ${started.join(', ')}`);
}

if (results.length !== started.length) {
  throw new Error(`Expected every in-flight batch to finish before pause: ${JSON.stringify({ started, results })}`);
}

console.log('translation pause scheduler: ok');
