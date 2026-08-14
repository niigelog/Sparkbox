// 用 Shadow DOM 隔离，免得被 X 的全局样式影响，也不污染宿主页面
let host = null;
let hideTimer = null;

function ensureHost() {
  if (host?.isConnected) return host;
  host = document.createElement('div');
  host.style.cssText = 'position:fixed;z-index:2147483647;left:0;bottom:0;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const box = document.createElement('div');
  box.id = 'toast';
  shadow.append(box);
  const style = document.createElement('style');
  style.textContent = `
    #toast {
      position: fixed; left: 24px; bottom: 24px;
      padding: 10px 16px; border-radius: 9999px;
      font: 500 14px/1.4 -apple-system, "PingFang SC", sans-serif;
      color: #fff; background: #1d9bf0;
      opacity: 0; transform: translateY(8px);
      transition: opacity .18s ease, transform .18s ease;
      pointer-events: none;
    }
    #toast.show { opacity: 1; transform: translateY(0); }
    #toast.error { background: #f4212e; max-width: 60vw; border-radius: 12px; }
  `;
  shadow.append(style);
  document.documentElement.append(host);
  host.__box = box;
  return host;
}

export function showToast(text, kind = 'info') {
  const box = ensureHost().__box;
  box.textContent = text;
  box.className = kind === 'error' ? 'error show' : 'show';
  clearTimeout(hideTimer);
  // 失败提示留久一点：没有重试队列兜底了，这条没看到就等于这次收藏白点了
  hideTimer = setTimeout(() => box.classList.remove('show'), kind === 'error' ? 5000 : 1800);
}
