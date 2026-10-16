import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

// L3：生产构建注入 CSP（兜底防 XSS）。只在 build 生效：dev 模式下 Vite/React Refresh 需要内联脚本与 HMR websocket。
// index.html 里唯一的内联脚本（暗色首帧预置）按内容 sha256 放行，其余脚本只允许同源文件。
// style-src 需要 'unsafe-inline'：antd CSS-in-JS 运行时插入 <style>。
// <webview> 访问的招聘站点不受宿主页面 CSP 约束（白名单另由 BrowserView / 主进程 M5 拦截）。
function cspPlugin(): Plugin {
  return {
    name: 'bossclaw-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const hashes: string[] = [];
      html.replace(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g, (_m, body: string) => {
        hashes.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
        return _m;
      });
      const csp = [
        "default-src 'self'",
        `script-src 'self' ${hashes.join(' ')}`.trim(),
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self' data: blob:",
        "media-src 'self' data: blob:",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; ');
      return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`);
    },
  };
}

// 渲染进程构建配置：开发用 Vite dev server（Electron 加载 localhost），
// 生产打包输出到 dist/，Electron 加载 file://dist/index.html。
export default defineConfig({
  plugins: [react(), cspPlugin()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // antd 全家桶 + icons 作为独立 vendor chunk，体积约 730KB（桌面端本地加载，可接受）
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        // 函数式分包：按 node_modules 实际路径精确分组，
        // 修复对象式 manualChunks 中 react/react-dom 只捕获入口门面（产出 0.03KB 空 chunk）的问题。
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) {
            return 'react-vendor';
          }
          if (
            id.includes('/antd/') ||
            id.includes('/@ant-design/') ||
            id.includes('/@rc-component/') ||
            id.includes('/rc-')
          ) {
            return 'antd-vendor';
          }
          // 其余（dayjs、classnames、zustand 等）交回 Rollup 自动分配；
          // mammoth 通过动态 import 单独成 chunk，按需加载。
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
