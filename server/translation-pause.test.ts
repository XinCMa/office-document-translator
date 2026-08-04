import { runWithConcurrency } from './translator.js';

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
