/**
 * 当前登录 X 的是谁。
 *
 * **这是识别，不是认证。** 后端没有任何办法验证插件报上来的身份 ——
 * 任何能访问接口的进程都能冒充任意用户。在只绑 127.0.0.1 的自用环境里这没问题；
 * 要给别人用或对外暴露时，必须换成 X OAuth，由服务端去 X 那边验。
 *
 * 用 twid cookie 里的数字 ID 作为主标识：handle 用户随时能改，数字 ID 终身不变。
 */

const X_URLS = ['https://x.com/', 'https://twitter.com/'];

/** twid 的值形如 "u%3D1234567890" */
function parseTwid(value) {
  if (!value) return null;
  return decodeURIComponent(value).match(/u=(\d+)/)?.[1] ?? null;
}

/**
 * 读取当前 X 用户的数字 ID。没登录 X 或读不到 cookie 时返回 null。
 * Service Worker 和侧边栏都用这个 —— 两边必须认同一个身份，否则会读写到不同用户下。
 */
export async function currentXUserId() {
  for (const url of X_URLS) {
    try {
      const cookie = await chrome.cookies.get({ url, name: 'twid' });
      const id = parseTwid(cookie?.value);
      if (id) return id;
    } catch {
      // 没有 cookies 权限或该域名没有 cookie，换下一个
    }
  }
  return null;
}

/** 附在请求头上，服务端据此定位/创建用户 */
export async function identityHeaders(extra = {}) {
  const xUserId = await currentXUserId();
  if (!xUserId) return {};
  const headers = { 'x-sparkbox-user-id': xUserId };
  // handle 和显示名只是给人看的，可能拿不到，拿不到就不发
  if (extra.handle) headers['x-sparkbox-handle'] = extra.handle;
  // 显示名可能含非 ASCII，头部必须编码
  if (extra.name) headers['x-sparkbox-name'] = encodeURIComponent(extra.name);
  return headers;
}
