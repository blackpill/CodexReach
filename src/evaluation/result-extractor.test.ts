import { describe, expect, it } from 'vitest';
import { extractEvaluationResult } from './result-extractor.js';

describe('extractEvaluationResult', () => {
  it('prefers a structured JSON result', () => {
    const result = extractEvaluationResult('分析完成。\n```json\n{"conclusion":"effective","confidence":0.82,"summary":"点击增加","recommendation":"继续观察","evidence":{"clicks":120}}\n```');
    expect(result).toEqual({ conclusion: 'effective', confidence: 0.82, summary: '点击增加', recommendation: '继续观察', evidence: { clicks: 120 } });
  });

  it('falls back to conservative text inference', () => {
    expect(extractEvaluationResult('目前样本不足，建议继续观察。')).toMatchObject({ conclusion: 'insufficient_data', confidence: 0.4 });
    expect(extractEvaluationResult('指标明显下降，表现变差。').conclusion).toBe('negative');
    expect(extractEvaluationResult('有很多其他改动，暂时无法判断。').conclusion).toBe('not_attributable');
  });
});
