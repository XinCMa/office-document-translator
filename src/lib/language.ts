// Single source of truth for user-facing language labels. App.tsx,
// UploadView.tsx and ReviewTable.tsx all render language names through this
// helper so labels never drift apart between views.
export function displayLanguageLabel(language?: string | null): string {
    const normalized = String(language || '').toLowerCase();
    if (normalized.includes('simplified chinese'))
        return '简体中文';
    if (normalized.includes('english'))
        return '英语';
    if (normalized.includes('french'))
        return '法语';
    if (normalized.includes('japanese'))
        return '日语';
    if (normalized.includes('italian'))
        return '意大利语';
    if (normalized.includes('arabic'))
        return '阿拉伯语';
    return language || '自动检测';
}
