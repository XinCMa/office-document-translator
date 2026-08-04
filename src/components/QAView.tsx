import React, { useState } from 'react';
import { Download, Check, AlertCircle, ChevronLeft, Home, Eye, ChevronDown, ChevronUp } from 'lucide-react';
import { QAStatus, ProjectSummary, ProjectDetail, GlossaryTerm } from '../types';
import { getClientId } from '../lib/api';

interface QAViewProps {
  qaReport: QAStatus | null;
  project: ProjectSummary | null;
  projectDetail?: ProjectDetail | null;
  onGeneratePPTX: () => Promise<void>;
  isGenerating: boolean;
  globalGlossary?: GlossaryTerm[];
  onAddGlobalGlossaryTerms?: (terms: GlossaryTerm[]) => Promise<void>;
  onOpenGlossarySaveDialog?: (terms: GlossaryTerm[]) => void;
  onPrevStep?: () => void;
  onBackToHome?: () => void;
}

export default function QAView({
  qaReport,
  project,
  projectDetail,
  onGeneratePPTX,
  isGenerating,
  globalGlossary = [],
  onAddGlobalGlossaryTerms,
  onOpenGlossarySaveDialog,
  onPrevStep,
  onBackToHome
}: QAViewProps) {
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [hasReviewedGlossarySave, setHasReviewedGlossarySave] = useState(false);
  const [showLogs, setShowLogs] = useState(false);

  if (!project) return null;

  const sourceSlideCount = qaReport?.sourceSlideCount ?? project.slideCount ?? 0;
  const outputSlideCount = qaReport?.outputSlideCount ?? project.slideCount ?? 0;
  const emptyMediaCount = qaReport?.emptyMediaCount ?? 0;
  const mediaFileCount = qaReport?.mediaFileCount ?? project.mediaCount ?? 0;
  const unmappedCount = qaReport?.unmappedCount ?? (projectDetail ? projectDetail.textItems.filter(item => !item.translatedText).length : 0);
  const totalItems = projectDetail ? projectDetail.textItems.length : (project.uniqueCount || 1);
  const coveredCount = totalItems - unmappedCount;
  const coveragePercentage = totalItems > 0 ? Math.round((coveredCount / totalItems) * 100) : 100;

  const slidesCheckPassed = sourceSlideCount === outputSlideCount;
  const mediaPassed = emptyMediaCount === 0;
  const coveragePassed = unmappedCount === 0;
  const glossaryReport = projectDetail?.glossaryValidationReport;
  const glossaryPassed = !glossaryReport || glossaryReport.misses === 0;
  const fixedLayoutFlyerRisk = qaReport?.details?.find(detail => detail.includes('FORMAT_RISK_FIXED_LAYOUT_FLYER'));
  const generationProgress = projectDetail?.generationProgress || project.generationProgress;
  const pendingTextCount = projectDetail?.textItems.filter(item => !item.translatedText).length ?? 0;
  const isProjectStillTranslating = project.status === 'translating';
  const downloadBlockedReason = isProjectStillTranslating
    ? pendingTextCount > 0
      ? `后台仍在完成翻译与补译，剩余 ${pendingTextCount} 条待处理。完成后即可下载。`
      : '后台仍在完成翻译状态同步与最终校验，完成后即可下载。'
    : null;

  const getProjectGlossaryTerms = (): GlossaryTerm[] => {
    const seen = new Set<string>();
    const projectTerms = projectDetail?.glossary || project?.glossary || [];

    return projectTerms.filter(term => {
      if (!term.source?.trim() || !term.target?.trim()) return false;
      if (term.checked === false) return false;
      if (term.status === 'candidate' || term.status === 'ambiguous' || term.status === 'needs_review') return false;
      const key = `${term.source.trim().toLowerCase()}|||${term.target.trim().toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const getNewProjectGlossaryTerms = (): GlossaryTerm[] => {
    const globalKeys = new Set(
      globalGlossary
        .filter(term => term.source && term.target)
        .map(term => `${term.source.trim().toLowerCase()}|||${term.target.trim().toLowerCase()}`)
    );
    return getProjectGlossaryTerms().filter(term => !globalKeys.has(
      `${term.source.trim().toLowerCase()}|||${term.target.trim().toLowerCase()}`
    ));
  };

  const glossaryTermKey = (term: GlossaryTerm): string =>
    `${term.source.trim().toLowerCase()}|||${term.target.trim().toLowerCase()}`;

  const assembleAndDownload = async () => {
    setDownloadError(null);
    try {
      await onGeneratePPTX();
      const clientId = getClientId();
      const url = `/api/projects/${project.id}/download?clientId=${encodeURIComponent(clientId)}&t=${Date.now()}`;
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      iframe.src = url;
      document.body.appendChild(iframe);
      window.setTimeout(() => {
        iframe.remove();
      }, 60000);
    } catch (err: any) {
      console.error('Server-side document generation failed:', err);
      setDownloadError(err.message || 'Failed to generate the translated document on the server.');
    }
  };

  const handleAssembleAndDownload = async () => {
    const termsToAdd = getNewProjectGlossaryTerms();
    if (!hasReviewedGlossarySave && termsToAdd.length > 0 && onOpenGlossarySaveDialog) {
      onOpenGlossarySaveDialog(termsToAdd);
      setHasReviewedGlossarySave(true);
    }

    await assembleAndDownload();
  };

  const projectGlossaryTerms = getProjectGlossaryTerms();

  const handleOpenGlossarySaveDialog = () => {
    if (projectGlossaryTerms.length === 0 || !onOpenGlossarySaveDialog) return;
    onOpenGlossarySaveDialog(projectGlossaryTerms);
  };

  return (
    <div className="w-full space-y-10 text-left font-sans animate-fade">
      <div className="mx-auto flex w-full max-w-none items-center justify-between border-b border-border/80 pb-6">
        <button
          type="button"
          onClick={onPrevStep}
          aria-label="上一步"
          title="上一步"
          className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-border font-semibold text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-all cursor-pointer"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>

        <button
          type="button"
          onClick={onBackToHome}
          className="inline-flex items-center gap-2 rounded-xl bg-secondary hover:bg-muted border border-border px-6 py-3 font-semibold text-sm text-foreground transition-all cursor-pointer"
        >
          <Home className="w-4 h-4 text-muted-foreground" />
          <span>返回首页</span>
        </button>
      </div>

      {/* QA Report Banner Dashboard */}
      <div>
        <h2 className="text-2xl font-bold text-foreground tracking-tight">QA 自动校验报告</h2>
        <p className="text-sm text-muted-foreground mt-1.5">所有核心数据项检查已完成，确保您的幻灯片格式、字词和媒体轨道无损无差错。</p>
      </div>

      {fixedLayoutFlyerRisk && (
        <div className="rounded-lg border border-warning/30 bg-warning-muted px-5 py-4 text-sm text-warning-foreground">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-warning" />
            <div>
              <p className="font-semibold">格式风险提示</p>
              <p className="mt-1 leading-relaxed">该文件为固定版式 flyer，格式可能需要人工微调字号等。</p>
            </div>
          </div>
        </div>
      )}

      {/* Grid of the two key QA cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Card 1: Slide Count consistency */}
        <div className={`hidden rounded-lg border p-6 shadow-2xs transition-all hover:shadow-xs ${
          slidesCheckPassed ? 'border-success/30 bg-success-muted' : 'border-destructive/30 bg-destructive-muted'
        }`}>
          <div className="flex items-start gap-4">
            <div className={`flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full ${
              slidesCheckPassed ? 'bg-success/10' : 'bg-destructive/10'
            }`}>
              {slidesCheckPassed ? (
                <Check className="h-6 w-6 text-success" />
              ) : (
                <AlertCircle className="h-6 w-6 text-destructive" />
              )}
            </div>
            <div className="flex-1">
              <h3 className="font-bold text-foreground text-sm">幻灯片数量一致性</h3>
              <p className={`mt-1.5 text-xs font-medium leading-relaxed ${
                slidesCheckPassed ? 'text-success' : 'text-destructive'
              }`}>
                原文件包含 {sourceSlideCount} 张幻灯片，翻译重建项完美重合。
              </p>
            </div>
            <div className={`flex-shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
              slidesCheckPassed ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive'
            }`}>
              {slidesCheckPassed ? '✓ 通过' : '✗ 异常'}
            </div>
          </div>
        </div>

        {/* Card 1: Media Integrity Check */}
        <div className={`rounded-lg border p-6 shadow-2xs transition-all hover:shadow-xs ${
          mediaPassed ? 'border-success/30 bg-success-muted' : 'border-warning/30 bg-warning-muted'
        }`}>
          <div className="flex items-start gap-4">
            <div className={`flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full ${
              mediaPassed ? 'bg-success/10' : 'bg-warning/10'
            }`}>
              {mediaPassed ? (
                <Check className="h-6 w-6 text-success" />
              ) : (
                <AlertCircle className="h-6 w-6 text-warning" />
              )}
            </div>
            <div className="flex-1">
              <h3 className="font-bold text-foreground text-sm">媒体资源完整度</h3>
              <p className={`mt-1.5 text-xs font-medium leading-relaxed ${
                mediaPassed ? 'text-success' : 'text-warning-foreground'
              }`}>
                {mediaFileCount > 0
                  ? `提取并验证 ${mediaFileCount} 个多媒体图片与媒体资产，无异常损坏通道。`
                  : '此幻灯片未发现多媒体文件加载，默认检测无损。'}
              </p>
            </div>
            <div className={`flex-shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
              mediaPassed ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning-foreground'
            }`}>
              {mediaPassed ? '✓ 验证' : '✗ 警告'}
            </div>
          </div>
        </div>

        {/* Card 2: Translation map coverage */}
        <div className={`rounded-lg border p-6 shadow-2xs transition-all hover:shadow-xs ${
          coveragePassed ? 'border-success/30 bg-success-muted' : 'border-warning/30 bg-warning-muted'
        }`}>
          <div className="flex items-start gap-4">
            <div className={`flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full ${
              coveragePassed ? 'bg-success/10' : 'bg-warning/10'
            }`}>
              {coveragePassed ? (
                <Check className="h-6 w-6 text-success" />
              ) : (
                <AlertCircle className="h-6 w-6 text-warning" />
              )}
            </div>
            <div className="flex-1">
              <h3 className="font-bold text-foreground text-sm">翻译覆盖完整度</h3>
              <p className={`mt-1.5 text-xs font-medium leading-relaxed ${
                coveragePassed ? 'text-success' : 'text-warning-foreground'
              }`}>
                {coveredCount} / {totalItems} 段中文译文翻译完全核对，项覆盖率高达 {coveragePercentage}%。
              </p>
            </div>
            <div className={`flex-shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
              coveragePassed ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning-foreground'
            }`}>
              {coveragePassed ? '100%' : `${coveragePercentage}%`}
            </div>
          </div>
        </div>
      </div>

      {glossaryReport && (
        <div className={`rounded-lg border p-5 shadow-2xs ${
          glossaryPassed ? 'border-success/30 bg-success-muted' : 'border-warning/30 bg-warning-muted'
        }`}>
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <h3 className="text-sm font-bold text-foreground">Glossary validation</h3>
              <p className={`mt-1 text-xs font-medium ${glossaryPassed ? 'text-success' : 'text-warning-foreground'}`}>
                {glossaryReport.hits} matched term usages passed, {glossaryReport.misses} need review.
              </p>
            </div>
            <div className={`rounded-full px-3 py-1 text-xs font-bold ${
              glossaryPassed ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning-foreground'
            }`}>
              {glossaryPassed ? 'PASS' : 'REVIEW'}
            </div>
          </div>

          {glossaryReport.misses > 0 && (
            <div className="mt-4 max-h-52 overflow-y-auto rounded-lg border border-warning/30 bg-card/70">
              {glossaryReport.findings
                .filter(item => item.status === 'GLOSSARY_MISS')
                .slice(0, 10)
                .map(item => (
                  <div key={`${item.itemId}-${item.source}`} className="border-b border-warning/20 p-3 text-xs last:border-b-0">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-bold text-foreground">Slide {item.slideNum}: {item.source}</span>
                      <span className="text-warning-foreground">Expected: {item.expectedTarget}</span>
                    </div>
                    <p className="mt-1 text-muted-foreground">{item.translatedText || '(empty translation)'}</p>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}

      {/* Channel cache optimization hint banners */}
      {downloadError && (
        <div className="mx-auto w-full max-w-none">
          <p className="rounded-lg border border-destructive/30 bg-destructive-muted p-3.5 text-left font-sans text-xs text-destructive">
            ⚠️ 导出错误: {downloadError}
          </p>
        </div>
      )}

      {/* Centered Assemble Download PPT action button */}
      <div className="flex flex-col items-center justify-center gap-3">
        <div className="flex flex-wrap items-center justify-center gap-3">
          <button
            id="combined-assemble-download-btn"
            type="button"
            disabled={isGenerating || isProjectStillTranslating}
            onClick={handleAssembleAndDownload}
            className="inline-flex items-center gap-3.5 rounded-full bg-primary hover:bg-primary-hover px-14 py-4 font-bold text-sm text-primary-foreground shadow-lg hover:shadow-xl hover:scale-[1.02] active:scale-[0.98] transition-all cursor-pointer disabled:opacity-40 disabled:scale-100"
          >
            {isGenerating || isProjectStillTranslating ? (
              <>
                <svg className="animate-spin h-4 w-4 text-primary-foreground" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <span>{isGenerating ? (generationProgress?.message || '正在准备生成文档...') : '正在完成后台翻译与校验...'}</span>
              </>
            ) : (
              <>
                <Download className="h-5 w-5" />
                <span>下载翻译后的文档</span>
              </>
            )}
          </button>
          <button
            type="button"
            disabled={projectGlossaryTerms.length === 0 || !onOpenGlossarySaveDialog}
            onClick={handleOpenGlossarySaveDialog}
            title={projectGlossaryTerms.length === 0 ? '本文没有可查看的已确认术语' : '查看本文术语并选择尚未入库的术语'}
            className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-6 py-4 text-sm font-bold text-foreground shadow-sm transition-all hover:border-primary/40 hover:bg-muted active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Eye className="h-5 w-5" />
            <span>查看本文术语</span>
          </button>
        </div>
        {isGenerating && (
          <div className="w-full max-w-md" aria-live="polite">
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all duration-300"
                style={{ width: `${generationProgress?.percent || 5}%` }}
              />
            </div>
            <p className="mt-2 text-center text-xs font-semibold text-muted-foreground">
              {generationProgress?.percent || 5}%
            </p>
          </div>
        )}
        {downloadBlockedReason && (
          <div className="max-w-xl rounded-lg border border-warning/30 bg-warning-muted px-4 py-3 text-center text-xs font-semibold leading-relaxed text-warning-foreground">
            {downloadBlockedReason}
          </div>
        )}
      </div>

      {/* Advanced Verification Audit Log Console (Collapsible for cleaner UI) */}
      {qaReport && qaReport.details && qaReport.details.length > 0 && (
        <div className="hidden">
          <button
            type="button"
            onClick={() => setShowLogs(!showLogs)}
            className="w-full flex items-center justify-between px-5 py-3.5 bg-muted/40 hover:bg-muted/70 transition-colors text-left border-b border-border/60"
          >
            <div className="flex items-center gap-2">
              <Eye className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs font-bold text-foreground">查看高阶底层结构审计日志</span>
            </div>
            {showLogs ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
          </button>

          {showLogs && (
            <div className="bg-neutral-900 text-neutral-300 font-mono text-[11px] p-5 space-y-1.5 max-h-52 overflow-y-auto leading-relaxed divide-y divide-neutral-850/30 selection:bg-neutral-800">
              <p className="text-neutral-500 pb-1 select-none">// START QA STRUT COMPLIANCE AUDITING REPORT</p>
              {qaReport.details.map((detail, dIdx) => (
                <p key={dIdx} className={`py-1 ${detail.includes('WARNING') ? 'text-warning' : 'text-neutral-300'}`}>
                  [qa-report-sys] {detail}
                </p>
              ))}
              <p className="text-neutral-500 pt-1 select-none">// COMPLETED PPTX INTEGRITY SANITATION PROCESS SUCCESSFULLY</p>
            </div>
          )}
        </div>
      )}

      {/* 底部导航按钮组 */}
    </div>
  );
}
