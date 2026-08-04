import { getTranslationConcurrency, runWithConcurrency } from './translator.js';

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
