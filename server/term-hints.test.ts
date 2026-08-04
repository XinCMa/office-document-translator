import { buildSegmentTermHints, validateSegmentTermHints } from './glossary.js';
import type { ExtractedTextItem, GlossaryTerm } from './db.js';

const glossary: GlossaryTerm[] = [
  { source: 'Change Order', target: '变更单', status: 'active' },
  { source: 'Order', target: '订单', status: 'active' },
  { source: 'Order', target: '排序方式', status: 'candidate' }
];

const hints = buildSegmentTermHints([
  { segmentId: 'S1', sourceText: 'Submit the Change Order.' },
  { segmentId: 'S2', sourceText: 'Change the sort Order.' }
], glossary);

if (!hints.S1?.some(hint => hint.source === 'Change Order' && hint.mode === 'strict')) {
  throw new Error('Expected a strict segment hint for Change Order.');
}
if (!hints.S2?.some(hint => hint.source === 'Order' && hint.mode === 'candidate')) {
  throw new Error('Expected an advisory candidate hint for ambiguous Order.');
}

const resolvedHints = buildSegmentTermHints(
  [{ segmentId: 'S3', sourceText: 'The Order is approved.' }],
  [
    { source: 'Order', target: '订单', status: 'ai_selected', confidence: 0.94 },
    { source: 'Order', target: '排序方式', status: 'candidate' }
  ]
);
if (!resolvedHints.S3?.some(hint => hint.target === '订单' && hint.mode === 'strict')) {
  throw new Error('Expected a high-confidence AI-selected term to become strict.');
}

const item: ExtractedTextItem = {
  id: '1',
  segmentId: 'S1',
  slideNum: 1,
  originalText: 'Submit the Change Order.',
  translatedText: '提交变更单。',
  status: 'translated'
};
const report = validateSegmentTermHints([item], { S1: '提交变更单。' }, hints);
if (report.misses !== 0 || report.hits !== 1) {
  throw new Error(`Unexpected segment hint QA report: ${JSON.stringify(report)}`);
}

console.log('segment term hints: ok');
