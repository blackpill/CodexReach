import type { EvaluationConclusion } from './types.js';

export type ExtractedEvaluationResult = {
  conclusion: EvaluationConclusion;
  confidence: number;
  summary: string;
  recommendation: string;
  evidence: Record<string, unknown>;
};

function normalizeConclusion(value: unknown): EvaluationConclusion | undefined {
  const aliases: Record<string, EvaluationConclusion> = {
    effective: 'effective', 有效: 'effective', 倾向有效: 'effective',
    negative: 'negative', 负向: 'negative', 倾向负向: 'negative',
    no_material_change: 'no_material_change', 无明显变化: 'no_material_change',
    insufficient_data: 'insufficient_data', 数据不足: 'insufficient_data',
    not_attributable: 'not_attributable', 无法归因: 'not_attributable',
    technical_issue: 'technical_issue', 技术异常: 'technical_issue',
  };
  return typeof value === 'string' ? aliases[value.trim()] : undefined;
}

function findJson(text: string): Record<string, unknown> | undefined {
  const candidates = [
    ...[...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1]),
    text.trim(),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* try next candidate */ }
  }
  return undefined;
}

function inferConclusion(text: string): EvaluationConclusion {
  if (/数据不足|样本不足|观察时间不足|insufficient data/i.test(text)) return 'insufficient_data';
  if (/无法归因|混杂因素|cannot attribute|not attributable/i.test(text)) return 'not_attributable';
  if (/技术异常|抓取失败|未收录|接口失败|technical issue/i.test(text)) return 'technical_issue';
  if (/负向|明显下降|恶化|变差|negative impact/i.test(text)) return 'negative';
  if (/无明显变化|基本持平|没有显著变化|no material change/i.test(text)) return 'no_material_change';
  if (/倾向有效|明显改善|有所提升|变好|effective/i.test(text)) return 'effective';
  return 'not_attributable';
}

export function extractEvaluationResult(text: string): ExtractedEvaluationResult {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Evaluation result is empty');
  const structured = findJson(trimmed);
  const conclusion = normalizeConclusion(structured?.conclusion) ?? inferConclusion(trimmed);
  const rawConfidence = Number(structured?.confidence);
  const confidence = Number.isFinite(rawConfidence) && rawConfidence >= 0 && rawConfidence <= 1
    ? rawConfidence
    : conclusion === 'not_attributable' || conclusion === 'insufficient_data' ? 0.4 : 0.65;
  const summary = typeof structured?.summary === 'string' && structured.summary.trim()
    ? structured.summary.trim().slice(0, 2000)
    : trimmed.slice(0, 2000);
  const recommendation = typeof structured?.recommendation === 'string'
    ? structured.recommendation.trim().slice(0, 1000)
    : '请根据证据和结论决定是否保留、延期观察或设计下一轮行动。';
  const evidence = structured?.evidence && typeof structured.evidence === 'object' && !Array.isArray(structured.evidence)
    ? structured.evidence as Record<string, unknown>
    : { rawText: trimmed.slice(0, 8000) };
  return { conclusion, confidence, summary, recommendation, evidence };
}
