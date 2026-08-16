import * as esbuild from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

// 配置从 .env 读取，构建时注入。注意：这些值最终会明文出现在 dist 里，
// 任何人解压插件都能拿到 —— 详见 README「安全边界」。
if (existsSync('.env')) process.loadEnvFile('.env');

const target = process.env.SYNC_TARGET ?? 'local';
if (!['local', 'supabase'].includes(target)) {
  console.error(`\nSYNC_TARGET 只能是 local 或 supabase，当前是 "${target}"\n`);
  process.exit(1);
}

// 只在对应模式下要求对应的配置
const required =
  target === 'supabase'
    ? ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'DEFAULT_EMAIL', 'DEFAULT_PASSWORD']
    : ['SYNC_ENDPOINT'];

const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(
    `\nSYNC_TARGET=${target} 缺少环境变量: ${missing.join(', ')}\n请复制 .env.example 为 .env 并填写。\n`
  );
  process.exit(1);
}

const define = Object.fromEntries(
  required.map((k) => [`__${k}__`, JSON.stringify(process.env[k])])
);
// 调试日志默认开着，联调阶段需要靠它定位卡在哪一环；DEBUG=0 可关掉
define.__DEBUG__ = String(process.env.DEBUG !== '0');

// 构建时决定同步目标，让没用到的那个 sink 完全不进 bundle
const alias = { '#sink': resolve(`src/background/sinks/${target}.js`) };

const common = { bundle: true, define, alias, target: 'chrome120', logLevel: 'info' };

// content script 不能是 ESM（MV3 的 content_scripts 只吃经典脚本），必须打成 IIFE
const builds = [
  { ...common, entryPoints: ['src/background/index.js'], outfile: `${outdir}/background.js`, format: 'esm' },
  { ...common, entryPoints: ['src/content/index.js'], outfile: `${outdir}/content.js`, format: 'iife' },
  { ...common, entryPoints: ['src/sidepanel/index.js'], outfile: `${outdir}/sidepanel.js`, format: 'esm' },
];

/**
 * host_permissions 里的后端地址必须和 SYNC_ENDPOINT 一致，否则请求会被 CORS 挡掉。
 * 手写两处必然会漂移 —— 直接从 endpoint 推导出来。
 */
async function writeManifest() {
  const manifest = JSON.parse(await readFile('src/manifest.json', 'utf8'));
  const fixed = ['https://x.com/*', 'https://twitter.com/*'];
  const extra = [];
  if (target === 'local') extra.push(`${new URL(process.env.SYNC_ENDPOINT).origin}/*`);
  else extra.push('https://*.supabase.co/*');
  manifest.host_permissions = [...new Set([...fixed, ...extra])];
  await writeFile(`${outdir}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
  return manifest.host_permissions;
}

async function copyStatic() {
  await cp('src/sidepanel/index.html', `${outdir}/sidepanel.html`);
  await cp('src/sidepanel/index.css', `${outdir}/sidepanel.css`);
}

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await copyStatic();
const hosts = await writeManifest();

if (watch) {
  const ctxs = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log(`watching... (sink: ${target})`);
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  console.log(
    `\n构建完成 → ${outdir}/  同步目标: ${target}` +
      (target === 'local' ? ` → ${process.env.SYNC_ENDPOINT}` : '') +
      `\nhost_permissions: ${hosts.join('  ')}` +
      `\n（chrome://extensions 里「加载已解压的扩展程序」选这个目录）`
  );
}
