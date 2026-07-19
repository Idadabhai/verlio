import { classifyDiff, draftDocUpdate, shouldActOnClassification, MIN_CONFIDENCE_TO_OPEN_PR } from '../lib/ai.js';
import { getMergedPR, listCandidateDocFiles, openDocPR, type RepoRef } from '../lib/github.js';

export interface PipelineResult {
  repo: string;
  pr: number;
  relevant: boolean;
  /** True when the verdict was both relevant and confident enough to proceed to drafting. */
  acted_on: boolean;
  confidence_threshold: number;
  classification: {
    confidence: number;
    rationale: string;
    doc_signals: string[];
  };
  draft: null | {
    should_draft: boolean;
    summary: string;
    files: string[];
  };
  pr_opened: null | { url: string; number: number };
  dry_run: boolean;
  usage: {
    classify: { cache_read_input_tokens: number; cache_creation_input_tokens: number };
    draft: { cache_read_input_tokens: number; cache_creation_input_tokens: number } | null;
  };
}

export async function runPipeline(ref: RepoRef, prNumber: number, opts: { dryRun: boolean }): Promise<PipelineResult> {
  const pr = await getMergedPR(ref, prNumber);

  const { result: classification, usage: classifyUsage } = await classifyDiff({
    prTitle: pr.title,
    prBody: pr.body,
    diff: pr.diff,
  });

  const base: PipelineResult = {
    repo: `${ref.owner}/${ref.repo}`,
    pr: prNumber,
    relevant: classification.relevant,
    acted_on: shouldActOnClassification(classification),
    confidence_threshold: MIN_CONFIDENCE_TO_OPEN_PR,
    classification: {
      confidence: classification.confidence,
      rationale: classification.rationale,
      doc_signals: classification.doc_signals,
    },
    draft: null,
    pr_opened: null,
    dry_run: opts.dryRun,
    usage: {
      classify: {
        cache_read_input_tokens: classifyUsage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: classifyUsage.cache_creation_input_tokens ?? 0,
      },
      draft: null,
    },
  };

  // Relevant-but-unconfident stops here: staying quiet costs an invisible miss, while a wrong PR
  // costs a maintainer's trust. The verdict is still returned in the JSON for observability.
  if (!shouldActOnClassification(classification)) return base;

  const candidateDocs = await listCandidateDocFiles(ref, pr.baseBranch);
  const { result: draft, usage: draftUsage } = await draftDocUpdate({
    prTitle: pr.title,
    prBody: pr.body,
    diff: pr.diff,
    candidateDocs,
  });

  base.draft = {
    should_draft: draft.should_draft,
    summary: draft.summary,
    files: draft.edits.map((e) => e.path),
  };
  base.usage.draft = {
    cache_read_input_tokens: draftUsage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: draftUsage.cache_creation_input_tokens ?? 0,
  };

  if (draft.should_draft && draft.edits.length > 0 && !opts.dryRun) {
    const opened = await openDocPR({
      ref,
      baseBranch: pr.baseBranch,
      triggeringPr: { number: pr.number, title: pr.title, url: `https://github.com/${ref.owner}/${ref.repo}/pull/${pr.number}` },
      classificationRationale: classification.rationale,
      edits: draft.edits,
      summary: draft.summary,
    });
    base.pr_opened = opened;
  }

  return base;
}
