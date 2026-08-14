// 模拟 X 时间线里一条「带图 + 引用推文」的帖子，结构按真实 DOM 的关键特征还原：
// - 头像和正文配图都是 pbs.twimg.com
// - emoji 是 <img alt>
// - 永久链接带 /photo/1 后缀
// - 引用推文包在 div[role="link"] 里
export const tweetWithQuote = `
<article data-testid="tweet">
  <div data-testid="User-Name">
    <a href="/elonmusk"><img src="https://pbs.twimg.com/profile_images/123/avatar.jpg" alt=""><span>Elon Musk</span></a>
    <a href="/elonmusk"><span>@elonmusk</span></a>
    <a href="/elonmusk/status/1234567890/photo/1"><time datetime="2026-08-10T09:30:00.000Z">2h</time></a>
  </div>
  <div data-testid="tweetText">这是主推文正文 <img alt="🚀" src="https://abs.twimg.com/emoji/rocket.svg"> 结束</div>
  <div data-testid="tweetPhoto">
    <img src="https://pbs.twimg.com/media/AAA111?format=jpg&name=small" alt="Image">
  </div>

  <div role="link" tabindex="0">
    <div data-testid="User-Name">
      <a href="/jack"><span>Jack</span></a>
      <a href="/jack"><span>@jack</span></a>
      <time datetime="2026-08-01T00:00:00.000Z">Aug 1</time>
    </div>
    <div data-testid="tweetText">这是被引用的推文，不应该被抓走</div>
    <div data-testid="tweetPhoto">
      <img src="https://pbs.twimg.com/media/QUOTE999?format=jpg" alt="Image">
    </div>
  </div>
</article>
`;

// 纯文字、无图、无引用；作者名里带 emoji
export const plainTweet = `
<article data-testid="tweet">
  <div data-testid="User-Name">
    <a href="/naval"><span>Naval</span><img alt="🧠" src="https://abs.twimg.com/emoji/brain.svg"></a>
    <a href="/naval"><span>@naval</span></a>
    <a href="/naval/status/9876543210"><time datetime="2026-08-12T11:00:00.000Z">1d</time></a>
  </div>
  <div data-testid="tweetText">第一行<br>第二行</div>
</article>
`;

// 视频帖：<video> 的 src 是 blob:，只有 poster 可用
export const videoTweet = `
<article data-testid="tweet">
  <div data-testid="User-Name">
    <a href="/nasa"><span>NASA</span></a>
    <a href="/nasa/status/5555555555"><time datetime="2026-08-13T08:00:00.000Z">3h</time></a>
  </div>
  <div data-testid="tweetText">发射直播</div>
  <div data-testid="videoPlayer">
    <video poster="https://pbs.twimg.com/ext_tw_video_thumb/555/img/poster.jpg" src="blob:https://x.com/abc-123"></video>
  </div>
</article>
`;
