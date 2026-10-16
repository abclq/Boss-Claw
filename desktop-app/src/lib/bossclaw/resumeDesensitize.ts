// 原简历「解析文字 → 渲染层 Canvas 直接排布 → 导出无敏感信息图片」。
//
// 输入为简历中心解析出的纯文本 resumeText。流程：
//   - desensitizeResumeText：剔除「电话:/邮箱:/微信:/身份证:…」这类「标签:值」整行（标签一并消失），
//     并在剩余正文里把散落的手机号/邮箱/身份证 全部替换为同等长度的 *（不留任何明文）；可选再隐藏姓名。
//   - 实际成图由 resumeToImage.ts 用 <canvas> 在渲染层直接绘制（不依赖 Electron 截屏，稳定不出错）。
//
// 安全不变量（对齐 AGENTS.md 2.1）：结果为脱敏后的投递/展示用副本，不改本地原始简历；无 AI、无缓存依赖。

export interface DesensitizeOptions {
  /** 是否同时隐藏姓名（默认 false：投递保留姓名，仅剔除联系方式等敏感项） */
  hideName?: boolean;
}

// M9 修复：手机号兼容 +86 / 86 / 0086 前缀与 3-4-4 分隔（138-1234-5678、138 1234 5678、+86 138…）。
// 前瞻/后顾排除相邻数字，避免误伤更长的数字串（订单号、学号等）。
const PHONE_SRC = String.raw`(?<![\d+])(?:(?:\+|00)?86[\s-]?)?1[3-9]\d(?:[\s-]?\d{4}){2}(?!\d)`;
const PHONE_RE = new RegExp(PHONE_SRC, 'g');
// 邮箱：带 g 的只用于 replace；判定一律用无 g 的版本——带 g 的正则做 .test() 会残留 lastIndex，
// 连续调用时交替漏判（旧 isBareContactLine 的 bug）
const EMAIL_SRC = String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`;
const EMAIL_RE = new RegExp(EMAIL_SRC, 'g');
const IDCARD_SRC = String.raw`(?<!\d)\d{17}[\dXx](?!\d)`;
const IDCARD_RE = new RegExp(IDCARD_SRC, 'g');
// 行内「微信/QQ/VX：账号」（不在行首也要打码，旧实现只认行首标签）
const IM_INLINE_RE = /((?:微信号?|WeChat|VX|WX|QQ|扣扣|钉钉)\s*[:：]?\s*)([A-Za-z][A-Za-z0-9_-]{4,31}|\d{5,12})/gi;
// 「标签:值」整行标签（命中即剔除整行，连同标签一起消失）；补「联系方式/Tel/Phone/Mobile/电子邮箱/手机号码」
const STRIP_LEAD_RE =
  /^\s*(姓名|电话|联系电话|联系方式|联系|手机|手机号|手机号码|Tel|Phone|Mobile|Cell|邮箱|电子邮箱|E-mail|Email|Mail|微信|微信号|WeChat|VX|vx|WX|wx|QQ|扣扣|钉钉|地址|住址|现居|现居住地|所在城市|所在|户籍|家庭住址|身份证|身份证号)\s*[:：]/i;
// 链接（输出过滤用）：http(s)://、www.、以及常见顶级域裸域名
const URL_RE = /(?:https?:\/\/|www\.)\S+|(?<![@\w.])[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|cn|net|org|io|me|cc|top|xyz|co)(?:\/\S*)?(?![\w.])/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 整行仅由手机号/邮箱/身份证组成 → 整行删除（避免残留）。全部用锚定、无 g 的正则 */
function isBareContactLine(line: string): boolean {
  const s = line.trim();
  if (!s) return false;
  return (
    new RegExp(`^${PHONE_SRC}$`).test(s) ||
    new RegExp(`^${EMAIL_SRC}$`).test(s) ||
    new RegExp(`^${IDCARD_SRC}$`).test(s) ||
    /^(?:微|微信)[A-Za-z0-9_-]{2,32}$/i.test(s)
  );
}

/** 任意位置把联系方式全打成 *（同长度，不留明文） */
function fullMaskLine(line: string): string {
  return line
    .replace(PHONE_RE, (m) => '*'.repeat(m.length))
    .replace(EMAIL_RE, (m) => '*'.repeat(m.length))
    .replace(IDCARD_RE, (m) => '*'.repeat(m.length))
    .replace(IM_INLINE_RE, (_m, label: string, id: string) => label + '*'.repeat(id.length));
}

/** 对任意文本做联系方式打码（不剔除行）：喂给第三方 LLM 的上下文（画像 JSON、沟通信息等）用 */
export function maskContactInfo(text: string): string {
  return String(text || '').split('\n').map(fullMaskLine).join('\n');
}

export type PiiKind = 'phone' | 'email' | 'idcard' | 'im' | 'url';

/**
 * H7 输出硬过滤：检测文本里是否含联系方式 / 链接。命中返回类别列表（空数组 = 干净）。
 * 自动发送（打招呼语 / AI 跟聊）前必须过这一关，命中即不发送、转人工。
 */
export function detectContactInfo(text: string): PiiKind[] {
  const s = String(text || '');
  const hits: PiiKind[] = [];
  if (new RegExp(PHONE_SRC).test(s)) hits.push('phone');
  if (new RegExp(EMAIL_SRC).test(s)) hits.push('email');
  if (new RegExp(IDCARD_SRC).test(s)) hits.push('idcard');
  if (new RegExp(IM_INLINE_RE.source, 'i').test(s)) hits.push('im');
  if (URL_RE.test(s)) hits.push('url');
  return hits;
}

/** 脱敏纯文本：剔除敏感「标签:值」整行 + 全打码散落号码；可选隐藏姓名 */
export function desensitizeResumeText(raw: string, opts: DesensitizeOptions = {}): string {
  const hideName = Boolean(opts.hideName);
  const lines = String(raw || '').replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const s = line.trim();
    if (STRIP_LEAD_RE.test(s)) continue; // 电话:/邮箱:… 整行剔除（标签一起消失）
    if (hideName && /^姓\s*名\s*[:：]/.test(s)) continue;
    if (s && isBareContactLine(s)) continue; // 单独一行的号码/邮箱也删
    kept.push(fullMaskLine(line)); // 剩余正文全打码散落号码
  }
  let out = kept.join('\n');

  if (hideName) {
    // 首行孤立 2-4 汉字姓名，整词替换
    const firstLine = out.split('\n').map((l) => l.trim()).find(Boolean);
    if (firstLine && /^[\u4e00-\u9fa5·]{2,4}$/.test(firstLine)) {
      const re = new RegExp(`(?<![\\u4e00-\\u9fa5])${escapeRegExp(firstLine)}(?![\\u4e00-\\u9fa5])`, 'g');
      out = out.replace(re, '**');
    }
  }
  return out;
}