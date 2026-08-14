// 用户从 x.com 线上页面复制的真实点赞按钮（已点赞状态）。
// 保留原样是为了固定住 X 的真实结构特征：data-testid 在 <button> 上、
// 类名是 Emotion 哈希、aria-label 本地化、图标是 svg > g > path。
export const likeButtonReal = `
<button aria-label="21 喜欢次数。喜欢了" role="button" class="css-g5y9jx r-1777fci r-bt1l66 r-bztko3 r-lrvibr r-1loqt21 r-1ny4l3l" data-testid="unlike" type="button"><div dir="ltr" class="css-146c3p1 r-bcqeeo r-1ttztb7 r-qvutc0 r-37j5jr r-a023e6 r-rjixqe r-16dba41 r-1awozwy r-6koalj r-1h0z5md r-o7ynqc r-clp7b1 r-3s2u2q" style="color: rgb(249, 24, 128);"><div class="css-g5y9jx r-xoduu5"><div class="css-g5y9jx r-xoduu5 r-1p0dtai r-1d2f490 r-u8s1d r-zchlnj r-ipm5af r-1niwhzg r-sdzlij r-xf4iuw r-o7ynqc r-6416eg r-1ny4l3l"></div><svg viewBox="0 0 24 24" aria-hidden="true" class="r-4qtqp9 r-yyyyoo r-dnmrzs r-bnwqim r-lrvibr r-m6rgpd r-1xvli5t r-1hdv0qi"><g><path d="M20.884 13.19c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z"></path></g></svg></div><div class="css-g5y9jx r-1udh08x"><span data-testid="app-text-transition-container"><span class="css-1jxf684"><span class="css-1jxf684">21</span></span></span></div></div></button>
`;

// 复用真实点赞按钮的结构，只换 data-testid，用来覆盖 like/unlike/bookmark/removeBookmark
function actionButton(testid) {
  return likeButtonReal.replace('data-testid="unlike"', `data-testid="${testid}"`);
}

/** X 侧边栏里的「个人资料」链接 —— readCurrentUser 从这里读当前登录用户 */
export const SIDEBAR = `
<nav role="navigation">
  <a href="/vica" role="link" data-testid="AppTabBar_Profile_Link"><span>个人资料</span></a>
  <div data-testid="SideNav_AccountSwitcher_Button">Vica 本人
@vica</div>
</nav>
`;

/**
 * 把若干动作按钮包进一条完整帖子的操作栏里。
 * @param testids 例如 ['like', 'bookmark']
 */
export function tweetWithButtons(...testids) {
  return `
<article data-testid="tweet">
  <div data-testid="User-Name"><a href="/vica"><span>Vica</span></a><a href="/vica/status/1111111111"><time datetime="2026-08-14T02:00:00.000Z">1h</time></a></div>
  <div data-testid="tweetText">正文</div>
  <div role="group">
    ${testids.map(actionButton).join('\n')}
  </div>
</article>
`;
}
