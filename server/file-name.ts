import path from 'path';

function mojibakeScore(value: string): number {
  const controlBytes = value.match(/[\u0080-\u009f]/g)?.length || 0;
  const commonSequences = value.match(/(?:Ã|Â|Ð|Ñ|â|ð)[\u0080-\u00bf]/g)?.length || 0;
  return controlBytes * 3 + commonSequences * 2;
}

export function repairUtf8Mojibake(value: string): string {
  const original = String(value || '');
  const originalScore = mojibakeScore(original);
  if (originalScore === 0) return original;

  const repaired = Buffer.from(original, 'latin1').toString('utf8');
  if (!repaired || repaired.includes('\ufffd')) return original;
  return mojibakeScore(repaired) < originalScore ? repaired : original;
}

export function fileNameFromCacheKey(cacheKey?: string | null): string | null {
  const match = String(cacheKey || '').match(/^(.*)_\d+_key$/s);
  return match?.[1]?.trim() || null;
}

export function sanitizeOriginalFileName(value: string, fallback = 'document'): string {
  const repaired = repairUtf8Mojibake(String(value || '').replace(/\0/g, '').trim());
  const baseName = path.posix.basename(repaired.replace(/\\/g, '/')).trim();
  return baseName || fallback;
}

export function resolveUploadedFileName(options: {
  explicitName?: string | null;
  multerName?: string | null;
  cacheKey?: string | null;
}): string {
  const cacheName = fileNameFromCacheKey(options.cacheKey);
  return sanitizeOriginalFileName(options.explicitName || cacheName || options.multerName || 'document');
}

export function normalizeStoredFileName(originalName?: string | null, cacheKey?: string | null): string {
  const cacheName = fileNameFromCacheKey(cacheKey);
  const storedName = String(originalName || '');
  const preferredName = cacheName && mojibakeScore(storedName) > 0 ? cacheName : storedName;
  return sanitizeOriginalFileName(preferredName);
}
