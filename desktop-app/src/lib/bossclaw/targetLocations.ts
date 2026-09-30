// 「目标城市」唯一口径 —— 设置页（基础求职条件）与职业画像（hardConstraints.locations）**同源共用一份内容**。
//
// 为什么必须同源：
//   · 设置页的 config.targetLocations 是搜索采集 URL 的输入（searchUrl.ts / platformUrls.ts）；
//   · 画像的 profile.hardConstraints.locations 是投递前「岗位地点不在目标城市」硬约束的判定依据（jobMatch.ts）。
//   两份数据各自演化时会出现「按设置里的城市去采集、却按简历推断的城市拦截」的自相矛盾。
//   因此统一为：同一份内容 —— 任一侧新增即补齐另一侧，删除则两侧同步删除。
//
// 口径对齐：
//   · 与 `camoufox/platforms/filters.py` 的 NO_FILTER_WORDS、`platformUrls.ts` 的 isNoFilter 保持同一语义：
//     空 / 不限 / 全部 / 不限制 / 所有 / 全国 均视为「未指定城市」（不参与硬约束判定，也不拼进 URL）。
//   · 「全国」不写入配置：目标城市留空时由采集队列自行回退「全国」（见 searchUrl.ts buildSearchQueue），
//     避免把「全国」当成一个真实城市名，导致硬约束要求岗位 location 含「全国」而把全部岗位拦掉。
import type { Profile } from './types';

/** 「未指定城市」的同义值（与 filters.py NO_FILTER_WORDS / platformUrls.isNoFilter 同口径） */
export const NO_CITY_WORDS = ['', '不限', '全部', '不限制', '所有', '全国'];

/** 目标城市数量上限（与 profile.normalizeProfile 的 locations 上限 20 对齐） */
export const TARGET_LOCATION_LIMIT = 20;

/** 单个城市文本是否属于「未指定」 */
export function isNoCityFilter(value: unknown): boolean {
  return NO_CITY_WORDS.includes(String(value ?? '').trim());
}

/**
 * 归一化目标城市：兼容「逗号 / 顿号 / 分号分隔的字符串」与数组两种入参，
 * 去空白、去「未指定」同义值、去重且保持原顺序（保序便于用户识别新补进来的城市）。
 */
export function normalizeTargetLocations(value: unknown, limit = TARGET_LOCATION_LIMIT): string[] {
  if (value == null) return [];
  const raw: unknown[] = Array.isArray(value)
    ? value
    : String(value).split(/[,，、;；]/);
  const out: string[] = [];
  for (const item of raw) {
    const v = String(item ?? '').trim();
    if (!v || isNoCityFilter(v) || out.includes(v)) continue;
    out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

/** 解析设置页输入框文本（逗号 / 顿号分隔） */
export function parseTargetLocationsText(text: string): string[] {
  return normalizeTargetLocations(text);
}

/** 格式化为设置页输入框文本 */
export function formatTargetLocationsText(list: readonly string[]): string {
  return normalizeTargetLocations(list).join(',');
}

/**
 * 并集合并：用于「不同就相互补充」——已有城市顺序在前（用户当前设置优先），
 * 新推断出的城市追加在后（便于用户识别哪些是刚补进来的），随后可自行删除。
 */
export function mergeTargetLocations(...lists: unknown[]): string[] {
  const out: string[] = [];
  for (const list of lists) {
    for (const v of normalizeTargetLocations(list)) {
      if (!out.includes(v)) out.push(v);
    }
    if (out.length >= TARGET_LOCATION_LIMIT) break;
  }
  return out.slice(0, TARGET_LOCATION_LIMIT);
}

/** 两份城市列表内容是否一致（顺序敏感：保序才能识别是否被改动） */
export function sameTargetLocations(a: unknown, b: unknown): boolean {
  const x = normalizeTargetLocations(a);
  const y = normalizeTargetLocations(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** 取画像里的城市（缺失时返回空数组） */
export function profileTargetLocations(profile: Profile | null | undefined): string[] {
  return normalizeTargetLocations(profile?.hardConstraints?.locations);
}

// ==================== 区级条目（「城市·区」/「城市·区1/区2」）====================
// BOSS 直聘搜索页原生支持区级筛选：URL 参数 multiBusinessDistrict（6 位行政区划码，
// 逗号多选，如 multiBusinessDistrict=330110,330106）。2026-09 于杭州搜索页实测：
// 城市级城市码 + 区级勾选后 URL 即携带该参数。
// 条目写法（单条目标签内）：
//   杭州            —— 全市
//   杭州·余杭区      —— 城市 + 单区
//   杭州·余杭区/西湖区 —— 城市 + 多区（「/」分隔；不能用顿号/逗号——那是条目间分隔符）
//   杭州/余杭区/西湖区 —— 「/」亦可作城市与区的分隔（首个片段视为城市）
// 区级信息同时参与 jobMatch 的地点硬约束：岗位 location 形如「杭州·余杭区·仓前」，
// 命中规则 = 含城市名 且（未指定区 或 含任一所选区名）。

/** 城市 / 区段分隔符：BOSS location 与条目写法统一用「·」（兼容「•」与「/」；「/」兼任条目内多区分隔） */
const CITY_DISTRICT_SEPARATOR = /[·•/]/;

/** 「目标城市」条目解析结果 */
export interface ParsedLocationEntry {
  /** 城市名（条目只写区时为 ''） */
  city: string;
  /** 所选区名列表（全市时为 []） */
  districts: string[];
  /** 原始条目文本 */
  raw: string;
}

/**
 * 解析单条目标地点条目为「城市 + 区列表」。
 * 无法解析（空 / 未指定词）返回 null；纯区名条目 city 为 ''（仅参与硬约束，不生成搜索 URL）。
 */
export function parseLocationEntry(value: unknown): ParsedLocationEntry | null {
  const raw = String(value ?? '').trim();
  if (!raw || isNoCityFilter(raw)) return null;
  const segments = raw
    .split(CITY_DISTRICT_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!segments.length) return null;
  const [city = '', ...districts] = segments;
  return {
    city,
    districts: districts.filter((d) => d && !isNoCityFilter(d)),
    raw,
  };
}

/**
 * 判断岗位地点是否命中一条目标条目。
 * 岗位 location 形如「杭州·余杭区·仓前」/「浙江·杭州」/「杭州」：
 *   · 条目含城市 → location 必须含城市名；
 *   · 条目含区列表 → location 还须含任一所选区名（全市条目不设区要求）。
 * 纯城市条目保持旧语义（locText.includes(city)），向后兼容。
 */
export function locationEntryMatchesJob(entry: string, jobLocation: string): boolean {
  const parsed = parseLocationEntry(entry);
  if (!parsed) return false;
  const locText = String(jobLocation || '');
  if (!locText) return false;
  if (parsed.city && !locText.includes(parsed.city)) return false;
  if (parsed.districts.length && !parsed.districts.some((d) => locText.includes(d))) return false;
  return true;
}

/** 条目是否携带区级信息 */
export function hasDistrictInfo(entry: string): boolean {
  const parsed = parseLocationEntry(entry);
  return !!parsed && parsed.districts.length > 0;
}
