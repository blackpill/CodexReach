import type { TurnActionContext } from './action-collector.js';

export type PrefilterSignal =
  | 'turn_failed'
  | 'query_only'
  | 'local_only'
  | 'production_change'
  | 'deployment'
  | 'seo_change'
  | 'release_change'
  | 'explicit_follow_up';

export type PrefilterResult = {
  eligible: boolean;
  score: number;
  signals: PrefilterSignal[];
  reasons: string[];
};

const patterns = {
  failed: /^(任务|执行|构建|部署)?.{0,12}(失败|已中断|已取消)|\b(failed|interrupted|cancelled)\b/i,
  queryOnly: /^(查看|查询|解释|分析一下|告诉我|是什么|为什么|how|what|why|check status)/i,
  localOnly: /未部署|尚未部署|只在本地|local only|not deployed|draft only/i,
  deployment: /已部署|部署成功|已上线|发布成功|production deploy|deployed to production|live in production/i,
  productionChange: /生效|上线|发布|投放|调整价格|配置已更新|rolled out|released|launched/i,
  seo: /\bSEO\b|title|description|canonical|structured data|schema\.org|sitemap|robots\.txt|内链|索引|重定向/i,
  release: /新功能|功能上线|性能优化|错误率|转化流程|支付流程|注册流程|缓存|基础设施|feature release|performance|conversion/i,
  followUp: /后续观察|稍后检查|需要评估|验证效果|观察效果|follow.?up|evaluate later|monitor/i,
  completedAction: /已修改|已更新|已修复|已调整|已新增|已删除|改动完成|配置完成|implemented|updated|changed|fixed/i,
};

export function prefilterActionContext(context: TurnActionContext): PrefilterResult {
  const text = context.evidenceText.trim();
  const signals: PrefilterSignal[] = [];
  const reasons: string[] = [];
  let score = 0;

  if (context.turnStatus === 'failed' || context.turnStatus === 'interrupted' || patterns.failed.test(context.agentResult)) {
    signals.push('turn_failed');
    reasons.push('回合没有成功完成');
    return { eligible: false, score: 0, signals, reasons };
  }

  if (!text) return { eligible: false, score: 0, signals: ['query_only'], reasons: ['回合没有可判断的行动证据'] };

  if (
    patterns.queryOnly.test(context.userIntent.trim())
    && !patterns.completedAction.test(context.agentResult)
    && !patterns.deployment.test(context.agentResult)
    && !patterns.productionChange.test(context.agentResult)
  ) {
    signals.push('query_only');
    reasons.push('仅查询或解释，没有文件或部署证据');
    score -= 0.5;
  }
  if (patterns.localOnly.test(text)) {
    signals.push('local_only');
    reasons.push('修改尚未进入真实环境');
    score += 0.15;
  }
  if (patterns.productionChange.test(context.agentResult)) {
    signals.push('production_change');
    reasons.push('存在真实环境变更信号');
    score += 0.35;
  }
  if (patterns.deployment.test(context.agentResult)) {
    signals.push('deployment');
    reasons.push('存在生产部署信号');
    score += 0.45;
  }
  if (patterns.seo.test(text)) {
    signals.push('seo_change');
    reasons.push('存在 SEO 相关变更');
    score += 0.25;
  }
  if (patterns.release.test(text)) {
    signals.push('release_change');
    reasons.push('存在功能、性能或发布相关变更');
    score += 0.25;
  }
  if (patterns.followUp.test(text)) {
    signals.push('explicit_follow_up');
    reasons.push('明确提出需要后续观察或评估');
    score += 0.35;
  }
  if (context.git.changedFiles?.length) {
    reasons.push(`检测到 ${context.git.changedFiles.length} 个变更文件`);
    score += 0.1;
  }

  score = Math.max(0, Math.min(1, score));
  const meaningfulSignal = signals.some((signal) => ['production_change', 'deployment', 'seo_change', 'release_change', 'explicit_follow_up'].includes(signal));
  return { eligible: meaningfulSignal && !signals.includes('query_only'), score, signals, reasons };
}
