// 发送幂等账本（H5）
// ---------------------------------------------------------
// 背景：自动沟通会在「引擎异常」时重启 Camoufox 并重发当前岗位。旧实现把所有
// `!ok && code == null` 都当成引擎宕机——主进程 240s 超时、in-flight 拦截也命中，
// 而这些情况下消息很可能**已经发出**，重发就是给同一个 HR 连发两条。
//
// 账本按「平台 + jobId + 消息内容指纹」记录每一次发送尝试，独立于 pending 列表
// （删除 pending 记录不会让账本遗忘），并跨重启持久化：
//   - inflight：已发起、尚无结论（进程崩溃/关窗时停留在此态 → 视为结果未知）
//   - sent    ：确认已发送
//   - unknown ：结果未知（超时 / 传输中断 / 服务端异常），**绝不自动重发**，交人工核对
// 只有「确认未发出」（引擎未就绪、连接被拒、业务码明确拒绝）才 forget()，允许之后再发。
//
// 口径：同一 jobId 上「内容相同」的消息只允许自动发一次；AI 跟聊按「回复的那条 HR 消息」
// 指纹去重（同一条 HR 消息只自动回复一次，即使模型两次生成的文本不同）。

export type SendLedgerState = 'inflight' | 'sent' | 'unknown';

export interface SendLedgerEntry {
  state: SendLedgerState;
  at: number;
}

export const SEND_LEDGER_KEY = 'bossclaw-send-ledger-v1';
/** 条目保留期：90 天（远大于任何「同 HR 重复打招呼」的风险窗口） */
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** 条目上限：超出时按时间淘汰最旧条目，防 localStorage 无限增长 */
const MAX_ENTRIES = 20000;

/** 归一化后做 FNV-1a 32 位指纹（空白折叠，避免仅空格/换行差异被当成不同消息） */
export function contentFingerprint(text: string): string {
  const norm = String(text || '').replace(/\s+/g, ' ').trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i += 1) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16).padStart(8, '0')}:${norm.length}`;
}

/** 打招呼语去重键：平台 + jobId + 招呼语内容 */
export function greetingKey(platform: string, jobId: string, greeting: string): string {
  return `g|${platform || 'boss'}|${jobId}|${contentFingerprint(greeting)}`;
}

/** AI 跟聊去重键：平台 + jobId + 被回复的 HR 消息内容 */
export function replyKey(platform: string, jobId: string, hrMessage: string): string {
  return `r|${platform || 'boss'}|${jobId}|${contentFingerprint(hrMessage)}`;
}

function load(): Record<string, SendLedgerEntry> {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(SEND_LEDGER_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, SendLedgerEntry>) : {};
  } catch {
    return {};
  }
}

function save(map: Record<string, SendLedgerEntry>): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const now = Date.now();
    let entries = Object.entries(map).filter(([, e]) => e && now - Number(e.at || 0) < RETENTION_MS);
    if (entries.length > MAX_ENTRIES) {
      entries = entries.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ENTRIES);
    }
    // 同步直写（不走 persist 防抖）：发送前的 inflight 标记必须在网络请求发出前落盘，
    // 否则窗口崩溃时丢失标记，重启后又会重发
    localStorage.setItem(SEND_LEDGER_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* 配额异常：账本写失败不抛出（内存态仍可在本进程内去重） */
  }
}

// 内存镜像：localStorage 写失败时本进程内仍能去重
let memo: Record<string, SendLedgerEntry> | null = null;
function map(): Record<string, SendLedgerEntry> {
  if (!memo) memo = load();
  return memo;
}

/** 查询某次发送的既有记录（无记录返回 null） */
export function ledgerGet(key: string): SendLedgerEntry | null {
  const e = map()[key];
  return e && Date.now() - Number(e.at || 0) < RETENTION_MS ? e : null;
}

/**
 * 发送前登记（原子检查 + 占位）：已有任何记录（sent / unknown / inflight）→ 返回该记录，调用方不得发送；
 * 无记录 → 写入 inflight 并返回 null，调用方可以发送。
 */
export function ledgerBegin(key: string): SendLedgerEntry | null {
  const existing = ledgerGet(key);
  if (existing) return existing;
  const m = map();
  m[key] = { state: 'inflight', at: Date.now() };
  save(m);
  return null;
}

/** 发送有结论：sent = 确认已发；unknown = 结果未知（不再自动重发） */
export function ledgerSettle(key: string, state: 'sent' | 'unknown'): void {
  const m = map();
  m[key] = { state, at: Date.now() };
  save(m);
}

/** 确认未发出（引擎未就绪 / 连接被拒 / 业务码明确拒绝）→ 撤销占位，允许之后重试 */
export function ledgerForget(key: string): void {
  const m = map();
  if (!(key in m)) return;
  delete m[key];
  save(m);
}
