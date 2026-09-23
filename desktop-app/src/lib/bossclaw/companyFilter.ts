// 公司 / 招聘方黑名单（确定性过滤）
// 在「设置 → 求职偏好」中让用户输入不想投的公司名或不想沟通的招聘方姓名，
// 加入任务时按确定性规则跳过（不依赖 AI 判断，与「城市反选」同级的硬过滤）。
//
// 匹配策略：
// - 公司名做「双向子串匹配」：黑名单「腾讯」命中实际公司「腾讯科技（深圳）有限公司」，
//   反之黑名单全称「XX科技有限公司」也能命中采集到的简称「XX科技」；
// - 招聘方姓名做「单向子串匹配」：黑名单「王老师」命中「王老师（HR）」等带后缀展示。
// 均忽略空白与大小写差异。
import type { AppConfig } from './types';

const normalize = (v: string) => String(v || '').replace(/\s+/g, '').toLowerCase();

/** 双向子串匹配：value 含 entry 或 entry 含 value（用于公司名，兼容简称/全称差异） */
function matchEitherWay(value: string, entries: string[]): string | null {
  const v = normalize(value);
  if (!v) return null;
  for (const raw of entries) {
    const e = normalize(raw);
    if (!e) continue;
    if (v.includes(e) || e.includes(v)) return String(raw).trim();
  }
  return null;
}

/** 单向子串匹配：value 含 entry（用于招聘方姓名，兼容「王老师（HR）」等展示后缀） */
function matchContains(value: string, entries: string[]): string | null {
  const v = normalize(value);
  if (!v) return null;
  for (const raw of entries) {
    const e = normalize(raw);
    if (!e) continue;
    if (v.includes(e)) return String(raw).trim();
  }
  return null;
}

export interface CompanyBlacklistResult {
  excluded: boolean;
  /** 命中时的跳过原因（含命中的黑名单条目），未命中时为空字符串 */
  reason: string;
}

/**
 * 判断某岗位是否命中「公司 / 招聘方黑名单」。
 * - job.company 命中任一被排除的公司名（双向子串）→ 排除；
 * - job.recruiterName 命中任一被排除的招聘方姓名（单向子串）→ 排除。
 * 黑名单为空时恒不排除（返回 excluded:false）。
 * @returns excluded=true 表示该岗位应被跳过，不进入投递队列
 */
export function isCompanyExcluded(
  job: { company?: string | null; recruiterName?: string | null } | null | undefined,
  config: AppConfig
): CompanyBlacklistResult {
  const companies = config.excludedCompanies || [];
  const recruiters = config.excludedRecruiters || [];
  if (!companies.length && !recruiters.length) return { excluded: false, reason: '' };

  const company = String(job?.company || '').trim();
  const recruiter = String(job?.recruiterName || '').trim();

  if (companies.length && company) {
    const hit = matchEitherWay(company, companies);
    if (hit) return { excluded: true, reason: `公司「${company}」命中公司黑名单「${hit}」，已跳过` };
  }

  if (recruiters.length && recruiter) {
    const hit = matchContains(recruiter, recruiters);
    if (hit) return { excluded: true, reason: `招聘方「${recruiter}」命中招聘方黑名单「${hit}」，已跳过` };
  }

  return { excluded: false, reason: '' };
}

/* ============================ 同公司投递上限 ============================ */

/** 待判定的「已投递记录」最小结构（PendingItem 的超集，便于离线单测）。 */
export interface DeliveredLike {
  status?: string;
  sentAt?: number;
  job?: { company?: string | null } | null;
}

/** 取本地时区的自然日起点（毫秒时间戳）。用于「今日已投」判定，与单日投递上限同口径。 */
export function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 统计某公司在「今日」已成功投递的岗位数。
 * 口径：status === 'sent' 且 sentAt 落在今日（本地时区自然日）内计 1；
 * 公司名做与黑名单一致的双向子串归一（兼容「腾讯」与「腾讯科技（深圳）有限公司」）。
 */
export function countCompanyDeliveredToday(
  company: string | null | undefined,
  delivered: DeliveredLike[],
  now: number = Date.now()
): number {
  const target = normalize(String(company || ''));
  if (!target) return 0;
  const dayStart = startOfLocalDay(now);
  let n = 0;
  for (const item of delivered || []) {
    if (item?.status !== 'sent') continue;
    const sentAt = Number(item?.sentAt || 0);
    if (!sentAt || sentAt < dayStart) continue;
    const c = normalize(String(item?.job?.company || ''));
    if (!c) continue;
    // 双向子串：任一向包含即视为同一家公司
    if (c.includes(target) || target.includes(c)) n += 1;
  }
  return n;
}

export interface CompanyLimitResult {
  /** true = 已达到上限，该岗位应跳过 */
  limited: boolean;
  /** 达到上限时今日该公司已投递数 */
  count: number;
  reason: string;
}

/**
 * 同公司单日投递上限：防止同一家公司批量岗位（如某厂同时放 20 个 Java 岗）
 * 把每日招呼配额一次性耗光、也对 HR 形成重复骚扰。
 *
 * 约定（与 HR 活跃度 / 面试方式筛选一致，宽松不误杀）：
 * - 开关关闭（默认）时恒不限制；
 * - 岗位未采集到公司名时不限制（无法判断同公司，宁可放过）；
 * - limit <= 0 视为不限制（与「最低薪资 0 = 不限」的取值约定一致）；
 * - limit = 1 即「同公司今日最多投 1 个」。
 */
export function companyDailyLimitHit(
  job: { company?: string | null } | null | undefined,
  config: AppConfig,
  delivered: DeliveredLike[],
  now: number = Date.now()
): CompanyLimitResult {
  const limit = Number(config?.companyDailyLimit ?? 0);
  if (!(limit > 0)) return { limited: false, count: 0, reason: '' };
  const company = String(job?.company || '').trim();
  if (!company) return { limited: false, count: 0, reason: '' };
  const count = countCompanyDeliveredToday(company, delivered, now);
  if (count < limit) return { limited: false, count, reason: '' };
  return {
    limited: true,
    count,
    reason: `公司「${company}」今日已投递 ${count} 个岗位，达到设定的同公司单日上限 ${limit} 个，已跳过`,
  };
}
