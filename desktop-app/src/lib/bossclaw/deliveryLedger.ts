// 投递账本（M7）
// ---------------------------------------------------------
// 旧实现：每日上限、同公司单日上限、入队去重都从 pending 列表现算。pending 可以被删除
// （MCP pendingRemove / 页面清理），删掉已发记录就会「退回」当日额度，同一岗位还能重新入队再发一次。
//
// 本账本只追加不删除（仅按保留期自然过期），与 pending 解耦：
//   - 每次招呼语确认发出（sentAt 落地）时记一条：平台 + 岗位标识 + 公司 + 发送时间
//   - 上限计数与去重以账本为准；pending 里的已发记录会被补登进账本（兼容升级前的历史数据）
// 「清空全部数据 / 恢复出厂」时随业务数据一起清除（storage.ts 登记表）。

export const DELIVERY_LEDGER_KEY = 'bossclaw-delivery-ledger-v1';
/** 保留 90 天：覆盖「同岗位再次入队」的现实窗口；按日计数只看当天 */
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 20000;

export interface DeliveryRecord {
  platform: string;
  company: string;
  sentAt: number;
  /** URL 别名条目：仅用于去重命中，不参与计数 */
  alias?: boolean;
}

interface JobLike {
  platform?: string | null;
  jobId?: string | null;
  url?: string | null;
  company?: string | null;
  title?: string | null;
}

interface SentLike {
  status?: string;
  sentAt?: number;
  job?: JobLike | null;
}

/** 岗位唯一键：平台 + jobId（缺失时用去 query/hash 的 URL；都缺失返回空串，不登记） */
export function deliveryKey(job: JobLike | null | undefined): string {
  if (!job) return '';
  const platform = String(job.platform || 'boss').toLowerCase();
  const jid = String(job.jobId || '').trim().toLowerCase();
  if (jid) return `${platform}|id:${jid}`;
  const url = String(job.url || '').split(/[?#]/)[0].trim().toLowerCase();
  return url ? `${platform}|url:${url}` : '';
}

function urlKeyOf(job: JobLike | null | undefined): string {
  if (!job) return '';
  const url = String(job.url || '').split(/[?#]/)[0].trim().toLowerCase();
  return url ? `${String(job.platform || 'boss').toLowerCase()}|url:${url}` : '';
}

let memo: Record<string, DeliveryRecord> | null = null;

function map(): Record<string, DeliveryRecord> {
  if (memo) return memo;
  memo = {};
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(DELIVERY_LEDGER_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') memo = parsed as Record<string, DeliveryRecord>;
    }
  } catch {
    memo = {};
  }
  return memo;
}

function save(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const now = Date.now();
    let entries = Object.entries(map()).filter(([, r]) => r && now - Number(r.sentAt || 0) < RETENTION_MS);
    if (entries.length > MAX_ENTRIES) entries = entries.sort((a, b) => b[1].sentAt - a[1].sentAt).slice(0, MAX_ENTRIES);
    memo = Object.fromEntries(entries);
    localStorage.setItem(DELIVERY_LEDGER_KEY, JSON.stringify(memo));
  } catch {
    /* 配额异常：内存态仍可在本进程内生效 */
  }
}

function put(m: Record<string, DeliveryRecord>, job: JobLike | null | undefined, sentAt: number): boolean {
  const key = deliveryKey(job);
  if (!key || m[key]) return false;
  const rec: DeliveryRecord = {
    platform: String(job?.platform || 'boss').toLowerCase(),
    company: String(job?.company || '').trim(),
    sentAt,
  };
  m[key] = rec;
  // URL 别名：同一岗位后续采集若只拿到 URL（或 jobId 变化），也能命中去重
  const alias = urlKeyOf(job);
  if (alias && alias !== key && !m[alias]) m[alias] = { ...rec, alias: true };
  return true;
}

/** 登记一次投递（同一岗位只保留首次记录，不覆盖） */
export function recordDelivery(job: JobLike | null | undefined, sentAt: number = Date.now()): void {
  if (!(sentAt > 0)) return;
  if (put(map(), job, sentAt)) save();
}

/** 把 pending/传入列表中已发记录补登进账本（升级前的历史数据；只增不减） */
export function syncDeliveriesFrom(items: SentLike[] | null | undefined): void {
  if (!items || !items.length) return;
  const m = map();
  let changed = false;
  const now = Date.now();
  for (const it of items) {
    if (it?.status !== 'sent') continue;
    const sentAt = Number(it.sentAt || 0);
    if (!sentAt || now - sentAt >= RETENTION_MS) continue;
    if (put(m, it.job, sentAt)) changed = true;
  }
  if (changed) save();
}

/** 该岗位是否已经投递过（保留期内） */
export function wasDelivered(job: JobLike | null | undefined): boolean {
  const m = map();
  const key = deliveryKey(job);
  if (key && m[key]) return true;
  const alias = urlKeyOf(job);
  return Boolean(alias && m[alias]);
}

/** 账本中的真实投递记录（不含 URL 别名） */
export function deliveryRecords(): DeliveryRecord[] {
  return Object.values(map()).filter((r) => r && !r.alias);
}

/** 测试/清空用：丢弃内存镜像（下次读取重新从 localStorage 加载） */
export function resetDeliveryLedgerCache(): void {
  memo = null;
}
