import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createSafePersistStorage } from '@/lib/persistSafe';
import { electronApi } from '@/lib/electronApi';
import { useRuntimeLogsStore } from '@/store/useRuntimeLogsStore';
import type { AppConfig } from '@/lib/bossclaw/types';
import { DEFAULT_CONFIG } from '@/lib/bossclaw/defaults';
import { PROVIDER_DEFAULTS, type LLMProvider } from '@/lib/bossclaw/providerPresets';
import {
  applyMigrations,
  extractLegacyBatchDelivery,
  RETIRED_DEEPSEEK_MODEL_MAP,
  type LegacyBatchDelivery,
} from './migrations/settingsMigrations';

// P1-10：模型提供商预设已收敛到 providerPresets.ts 单一来源，此处只 re-export 供设置页等
// 既有 import（`import { PROVIDER_DEFAULTS } from '@/store/useSettingsStore'`）兼容使用。
export { PROVIDER_DEFAULTS, type ProviderPreset, type LLMProvider } from '@/lib/bossclaw/providerPresets';

export interface LLMConfig {
  provider: LLMProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type { LegacyBatchDelivery };

/** merge 时剥离到的旧分批配置（仅老用户升级后的首次启动存在，消费后置空） */
export let legacyBatchDelivery: LegacyBatchDelivery | null = null;

/** App 启动调用：取走一次性的旧分批配置（幂等；已消费后返回 null）。 */
export function consumeLegacyBatchDelivery(): LegacyBatchDelivery | null {
  const v = legacyBatchDelivery;
  legacyBatchDelivery = null;
  return v;
}

interface SettingsState {
  config: AppConfig;
  setConfig: (patch: Partial<AppConfig>) => void;
  setModel: (patch: Partial<AppConfig['model']>) => void;
  applyProviderDefaults: (p: LLMProvider) => void;
  isLLMConfigured: () => boolean;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      config: DEFAULT_CONFIG,
      setConfig: (patch) => set((s) => ({ config: { ...s.config, ...patch } })),
      setModel: (patch) => set((s) => ({ config: { ...s.config, model: { ...s.config.model, ...patch } } })),
      applyProviderDefaults: (p) =>
        set((s) => ({
          config: {
            ...s.config,
            model: {
              ...s.config.model,
              provider: p,
              baseUrl: PROVIDER_DEFAULTS[p].baseUrl,
              model: PROVIDER_DEFAULTS[p].model,
            },
          },
        })),
      isLLMConfigured: () => {
        const { model } = get().config;
        return Boolean(model.apiKey && model.baseUrl && model.model);
      },
    }),
    {
      // v2 命名空间：本次回滚强制重置旧 bossclaw-settings（含已被删除的 engineMode:'cloak' 持久化值）
      name: 'bossclaw-settings-v2',
      // P30：安全持久化——config 变更（含暂停冷却 pausedUntil 等安全字段）不得因 localStorage
      // 配额异常向上抛错中断引擎/UI；防抖合批也避免高频 setConfig 触发全量序列化
      storage: createSafePersistStorage(),
      // 浅合并持久化配置到最新 DEFAULT_CONFIG，自动补齐新增的安全字段
      // （老用户 localStorage 中缺少 maxDailySent 等字段时回退到安全默认值）。
      // P2-06：历史迁移收敛到 migrations/settingsMigrations.ts 注册表；
      // 本函数回归「纯合并」——batchDelivery 剥离走 extractLegacyBatchDelivery（不改写入参），
      // 其余迁移走 applyMigrations（只读入参、不改写）。
      merge: (persisted, current) => {
        const p = (persisted || {}) as Partial<SettingsState>;
        const pc = (p.config || {}) as Partial<AppConfig>;
        // 一次性剥离退役字段 batchDelivery：转存到模块级变量，由 App 启动迁移为定时任务（幂等）
        const legacy = extractLegacyBatchDelivery(pc);
        if (legacy.artifact) legacyBatchDelivery = legacy.artifact;
        // 剩余历史迁移（纯函数，只读入参）：每日目标/平台归一/模型名义/看门狗时长
        const migrated = applyMigrations(legacy.cleaned, {
          current: (current as SettingsState).config,
          deepseekMap: RETIRED_DEEPSEEK_MODEL_MAP,
        });
        return {
          ...current,
          ...p,
          config: {
            ...(current as SettingsState).config,
            ...legacy.cleaned,
            ...migrated,
          },
        };
      },
    }
  )
);

export const getLLMConfig = (): LLMConfig & AppConfig['model'] => {
  const { model } = useSettingsStore.getState().config;
  return model;
};

// ===== M6：API Key 加密存储同步 =====
// 真实 Key 只在主进程（safeStorage 加密落盘）；config.model.apiKey 只保存掩码（••••末四位），
// 仅用于「是否已配置」判断与界面展示，主进程代理请求时忽略渲染层传入的值。
export const LLM_KEY_MASK_PREFIX = '••••';
export const isMaskedApiKey = (k: unknown): boolean => String(k || '').startsWith(LLM_KEY_MASK_PREFIX);

/** 启动时调用：旧版明文 Key 迁移到主进程加密存储；掩码与主进程状态对齐（备份恢复/清空后不留假「已配置」）。 */
export async function syncLlmKeyWithMain(): Promise<void> {
  const st = await electronApi.llmKey.status();
  if (!st) return; // 非 Electron 环境
  const { model } = useSettingsStore.getState().config;
  const cur = String(model.apiKey || '').trim();
  if (cur && !isMaskedApiKey(cur)) {
    const r = await electronApi.llmKey.set(cur, model.baseUrl);
    useSettingsStore.getState().setModel({ apiKey: r.ok && r.masked ? r.masked : '' });
    if (!r.ok) {
      useRuntimeLogsStore
        .getState()
        .addLog('warn', `API Key 迁移到加密存储失败（${r.error || '未知原因'}），已从本地明文配置中移除，请在设置页重新填写。`);
    }
    return;
  }
  const masked = st.configured ? String(st.masked || '') : '';
  if (cur !== masked) useSettingsStore.getState().setModel({ apiKey: masked });
}
