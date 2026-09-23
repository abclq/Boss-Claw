// 福利筛选：用户多选「必须含有的福利/工作制度标签」，按 AND 逻辑真实匹配。
// 与岗位 welfare 字段（采集来源：BOSS job/card.json 的 welfareList 与详情页标签区）配合，
// 用于在「加入任务」与投递前拦截不满足福利要求的岗位，避免浪费每日打招呼配额。
//
// 设计口径（对齐 interviewModeFilter 的「宽松不误杀」约定）：
//   1. AND 语义：welfareMust 中每个所选标签都必须命中，缺任一即视为不满足；
//   2. 未采集不误杀：岗位 welfare 为空 / 未识别时一律判为「合格」，不据以拦截
//      （BOSS 部分岗位卡片不返回 welfareList，拦截会把大量正常岗位错杀）；
//   3. 归一容错：BOSS 标签文本形态不统一（「周末双休」/「双休」、「五险一金」/「五险」），
//      统一用正则吸收同义写法，不要求字面完全相等。
import type { JobMeta } from './types';

/** 福利标签的内部 key（设置项持久化值，勿随意改动）。 */
export type WelfareTag =
  | 'weekend_off'
  | 'social_insurance'
  | 'housing_fund'
  | 'year_end_bonus'
  | 'paid_leave'
  | 'no_overtime'
  | 'flexible'
  | 'meal'
  | 'housing'
  | 'transport'
  | 'physical_exam'
  | 'equity';

/** 每个标签的识别正则（对单条 welfare 文本做 test；命中任意一条正则即算该标签命中）。 */
export const WELFARE_TAG_PATTERNS: Record<WelfareTag, RegExp[]> = {
  // 「周末双休 / 双休」；「大小周」「单休」不含「双休」故不误命中
  weekend_off: [/双休/, /做五休二/, /周末休息/],
  // 「五险一金 / 六险一金 / 三险 / 四险 / 社会保险」——注意只匹配「险」，不与公积金重复。
  // 中文数字（三/四/五/六/七）与阿拉伯数字（3-6）都要覆盖：BOSS 既有「五险一金」也有「5险1金」写法。
  social_insurance: [/[三四五六七3-7]\s*险/, /社会保险/, /社保/],
  // 「住房公积金 / 住房补贴 / N险N金形式的第二金」。
  // 注意：「五险一金」「六险一金」中的「一金」即住房公积金，同样命中（语义正确，非误命中）。
  // 只有纯社保表述（如「五险」「三险」，无「金」）不命中本条，由 social_insurance 覆盖。
  housing_fund: [/公积金/, /住房补贴/, /[一二两3-5]\s*金/],
  year_end_bonus: [/年终奖/, /年底双薪/, /第?\s*1[234]\s*薪/, /十三薪|十四薪|十五薪/],
  paid_leave: [/年假/],
  no_overtime: [/不加班/, /少加班/, /无加班/, /准点下班/],
  flexible: [/弹性/, /灵活办公/],
  meal: [/包吃/, /餐补/, /饭补/, /免费餐/, /工作餐/, /伙食/],
  housing: [/包住/, /住宿/, /房补/, /员工宿舍/, /公寓/],
  transport: [/交通/, /通讯补|通讯补贴/, /班车/, /油补/, /打车/],
  physical_exam: [/体检/],
  equity: [/期权/, /股权/, /股票/],
};

export const WELFARE_TAG_OPTIONS: { value: WelfareTag; label: string; hint: string }[] = [
  { value: 'weekend_off', label: '周末双休', hint: '识别「周末双休 / 双休」；大小周、单休不算' },
  { value: 'social_insurance', label: '五险一金（社保）', hint: '识别「五险一金 / 六险一金 / 三险 / 社会保险」' },
  { value: 'housing_fund', label: '住房公积金', hint: '识别「住房公积金 / 住房补贴」' },
  { value: 'year_end_bonus', label: '年终奖', hint: '识别「年终奖 / 年底双薪 / 13薪」等' },
  { value: 'paid_leave', label: '带薪年假', hint: '识别「带薪年假 / 年假」' },
  { value: 'no_overtime', label: '不加班', hint: '识别「不加班 / 少加班 / 准点下班」' },
  { value: 'flexible', label: '弹性工作', hint: '识别「弹性工作 / 灵活办公」' },
  { value: 'meal', label: '包吃 / 餐补', hint: '识别「包吃 / 餐补 / 饭补 / 工作餐」' },
  { value: 'housing', label: '包住 / 房补', hint: '识别「包住 / 员工宿舍 / 房补」' },
  { value: 'transport', label: '交通 / 通讯补贴', hint: '识别「交通补 / 通讯补 / 班车」' },
  { value: 'physical_exam', label: '定期体检', hint: '识别「定期体检 / 年度体检」' },
  { value: 'equity', label: '股票期权', hint: '识别「股票期权 / 股权 / 期权」' },
];

export const WELFARE_TAG_LABEL: Record<WelfareTag, string> = WELFARE_TAG_OPTIONS.reduce(
  (acc, o) => {
    acc[o.value] = o.label;
    return acc;
  },
  {} as Record<WelfareTag, string>
);

/** 非法 / 越界的标签值在读取时被丢弃（历史脏数据或手改 localStorage 时不炸）。 */
export function normalizeWelfareMust(raw: unknown): WelfareTag[] {
  if (!Array.isArray(raw)) return [];
  const valid = new Set<WelfareTag>(WELFARE_TAG_OPTIONS.map((o) => o.value));
  const out: WelfareTag[] = [];
  for (const v of raw) {
    if (typeof v === 'string' && valid.has(v as WelfareTag) && !out.includes(v as WelfareTag)) {
      out.push(v as WelfareTag);
    }
  }
  return out;
}

/** 单条福利文本命中哪些标签（供 UI 预览与调试）。 */
export function tagsOfWelfareText(text: string): WelfareTag[] {
  const t = String(text || '').trim();
  if (!t) return [];
  return (Object.keys(WELFARE_TAG_PATTERNS) as WelfareTag[]).filter((k) =>
    WELFARE_TAG_PATTERNS[k].some((re) => re.test(t))
  );
}

/** 岗位 welfare 数组归一出的「已命中标签集合」。 */
export function welfareTagsOfJob(job: JobMeta | null | undefined): Set<WelfareTag> {
  const set = new Set<WelfareTag>();
  const raw = job?.welfare;
  if (!Array.isArray(raw)) return set;
  for (const w of raw) {
    for (const k of tagsOfWelfareText(String(w))) set.add(k);
  }
  return set;
}

export interface WelfareMatchResult {
  /** true = 满足（含未采集到福利信息的宽松放行） */
  ok: boolean;
  /** 不满足时缺失的标签（已按用户所选顺序） */
  missing: WelfareTag[];
  /** 岗位侧是否压根没有福利信息（空 / 非数组）——用于区分「未采集」与「不满足」 */
  noSignal: boolean;
}

/**
 * AND 匹配：must 中每个标签都必须在岗位 welfare 中命中。
 * 岗位 welfare 为空 → noSignal=true 且 ok=true（宽松放行，不误杀）。
 */
export function matchWelfareTags(
  job: JobMeta | null | undefined,
  must: WelfareTag[] | undefined | null
): WelfareMatchResult {
  const wanted = normalizeWelfareMust(must);
  if (wanted.length === 0) return { ok: true, missing: [], noSignal: false };
  const raw = job?.welfare;
  const noSignal = !Array.isArray(raw) || raw.length === 0;
  if (noSignal) return { ok: true, missing: [], noSignal: true };
  const has = welfareTagsOfJob(job);
  const missing = wanted.filter((k) => !has.has(k));
  return { ok: missing.length === 0, missing, noSignal: false };
}

/** 把 must 标签列表转成可读文案（错误提示 / 日志用）。 */
export function welfareFilterLabel(must: WelfareTag[] | undefined | null): string {
  const wanted = normalizeWelfareMust(must);
  if (wanted.length === 0) return '不限';
  return wanted.map((k) => WELFARE_TAG_LABEL[k]).join(' + ');
}
