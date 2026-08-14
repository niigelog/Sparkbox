/**
 * 从 X 页面读当前登录用户的 handle 和显示名。
 *
 * 只作为可读信息用，真正的身份主键是 twid cookie 里的数字 ID（见 shared/identity.js）——
 * 这里读不到也不影响功能，最多是数据库里那行没有名字。
 */

/** 侧边栏的「个人资料」链接，href 就是 /handle，比解析账号切换器稳 */
function fromProfileLink() {
  const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
  if (!a) return null;
  return new URL(a.href, location.origin).pathname.match(/^\/([A-Za-z0-9_]{1,15})$/)?.[1] ?? null;
}

/** 窄屏下没有侧边栏，退回账号切换器；它的文本是「显示名\n@handle」 */
function fromAccountSwitcher() {
  const el = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
  if (!el) return null;
  const handle = el.innerText?.match(/@([A-Za-z0-9_]{1,15})/)?.[1] ?? null;
  const name = el.innerText?.split('\n').map((s) => s.trim()).filter(Boolean)[0] ?? null;
  return { handle, name: name?.startsWith('@') ? null : name };
}

export function readCurrentUser() {
  const switcher = fromAccountSwitcher();
  return {
    handle: fromProfileLink() ?? switcher?.handle ?? null,
    name: switcher?.name ?? null,
  };
}
