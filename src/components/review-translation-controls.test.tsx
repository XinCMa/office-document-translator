import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReviewTable from './ReviewTable.js';
import type { ProjectSummary } from '../types.js';

const textItems = [
  { id: '1', slideNum: 1, originalText: 'Hello', translatedText: '你好', status: 'translated' as const },
  { id: '2', slideNum: 1, originalText: 'World', translatedText: '', status: 'pending' as const }
];

function render(status: ProjectSummary['status'], isTranslating: boolean): string {
  return renderToStaticMarkup(
    <ReviewTable
      projectId="test"
      textItems={textItems}
      onUpdateItem={async () => undefined}
      isUpdatingItem={null}
      isTranslating={isTranslating}
      translationStatus={status}
      onPauseTranslation={async () => undefined}
      onResumeTranslation={async () => undefined}
      onNextStep={() => undefined}
      onPrevStep={() => undefined}
      onTranslatePending={async () => undefined}
    />
  );
}

const translating = render('translating', true);
if (!translating.includes('aria-label="暂停翻译"') || translating.includes('aria-label="继续翻译"')) {
  throw new Error('Translating state must expose only the pause control.');
}

const translatingBeforeDetailSync = render('uploaded', true);
if (!translatingBeforeDetailSync.includes('aria-label="暂停翻译"')) {
  throw new Error('An active translation must expose pause before the project detail status catches up.');
}

const pausing = render('pausing', true);
if (!pausing.includes('aria-label="正在暂停"') || pausing.includes('aria-label="暂停翻译"') || pausing.includes('aria-label="继续翻译"')) {
  throw new Error('Pausing state must expose only the non-interactive pausing indicator.');
}

const paused = render('paused', false);
if (!paused.includes('aria-label="继续翻译"') || paused.includes('aria-label="暂停翻译"') || paused.includes('补译剩余待翻译项')) {
  throw new Error('Paused state must expose only the resume control.');
}

const completed = render('completed', false);
if (completed.includes('aria-label="暂停翻译"') || completed.includes('aria-label="继续翻译"') || completed.includes('aria-label="正在暂停"')) {
  throw new Error('Completed state must not expose translation controls.');
}

console.log('review translation controls: ok');
