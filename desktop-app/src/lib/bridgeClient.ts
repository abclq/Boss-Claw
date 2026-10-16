// 与 OpenClaw 本地桥接（Node）通信的渲染端客户端。
// 桥接为可选模块：PDF 在渲染进程内用纯 JS 解析；DOCX 走桥接（mammoth 在 Node 侧）。
// H2：渲染层不再持有桥接 token、不再直连 127.0.0.1——统一经主进程 jc:bridge-call 代理
// （token 每次启动随机生成且只在主进程内存中；桥服务端已去掉 CORS，浏览器跨域无法调用）。

export interface BridgeResumeResult {
  ok: boolean;
  text?: string;
  method?: string;
  error?: string;
}

type BridgeCall = (route: string, method?: 'GET' | 'POST', body?: unknown, timeoutMs?: number) => Promise<any>;

function bridgeCallFn(): BridgeCall | null {
  return (typeof window !== 'undefined' && window.electron?.bridgeCall) || null;
}

/** 调用 OpenClaw 桥（主进程代理）；桥不可用时抛错，由调用方兜底 */
export async function bridgeCall(route: string, method: 'GET' | 'POST' = 'GET', body?: unknown, timeoutMs = 15000): Promise<any> {
  const fn = bridgeCallFn();
  if (!fn) throw new Error('bridgeCall 不可用（非 Electron 环境）');
  const data = await fn(route, method, body, timeoutMs);
  // 主进程代理在桥未启动 / 超时时返回 { unavailable: true }：按旧版 fetch 失败语义抛出，交调用方兜底
  if (!data || typeof data !== 'object' || data.unavailable) throw new Error('本地桥接不可用或超时');
  return data;
}

export async function bridgeParseResume(dataUrl: string, name: string): Promise<BridgeResumeResult> {
  // P21：超时 + 失败兜底，与 bridgeStatus 保持一致，桥未启动时返回 {ok:false} 而非抛未处理异常
  try {
    const data = await bridgeCall('/resume-text', 'POST', { dataUrl, name }, 15000);
    if (!data || typeof data !== 'object') throw new Error('bad response');
    return data as BridgeResumeResult;
  } catch {
    return { ok: false, method: 'bridge', error: '本地桥接不可用或超时，请启动 OpenClaw 桥接服务' };
  }
}

export async function bridgeStatus(): Promise<{ ok: boolean; [k: string]: unknown }> {
  try {
    // P30：超时兜底——桥半开时 3s 后按「未连接」处理（超时由主进程代理强制）
    const data = await bridgeCall('/status', 'GET', undefined, 3000);
    return data && typeof data === 'object' ? data : { ok: false };
  } catch {
    return { ok: false };
  }
}
