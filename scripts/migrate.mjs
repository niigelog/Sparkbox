#!/usr/bin/env node
/**
 * 数据库迁移工具。
 *
 *   npm run db:status    看哪些迁移已应用、哪些待应用
 *   npm run db:migrate   按文件名顺序应用所有未应用的迁移
 *   npm run db:migrate -- --dry-run   只打印会做什么，不真的执行
 *
 * 约定：
 *   * 迁移文件放 db/migrations/，命名 NNNN_描述.sql，按文件名排序执行
 *   * 每个迁移在**单独一个事务**里执行，失败整体回滚，不会留半截状态
 *   * 已应用的记录在 schema_migrations 表里，重复跑是安全的（幂等）
 *   * 迁移文件一旦应用过就不能再改 —— 内容哈希对不上会直接报错拦下来
 */
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const MIGRATIONS_DIR = 'db/migrations';

if (existsSync('.env')) process.loadEnvFile('.env');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const command = args.find((a) => !a.startsWith('--')) ?? 'up';

function config() {
  const {
    APP_POSTGRES_HOST: host,
    APP_POSTGRES_PORT: port,
    APP_POSTGRES_DB: database,
    APP_POSTGRES_USER: user,
    APP_POSTGRES_PASSWORD: password,
  } = process.env;

  const missing = Object.entries({ host, database, user, password })
    .filter(([, v]) => !v)
    .map(([k]) => `APP_POSTGRES_${k === 'database' ? 'DB' : k.toUpperCase()}`);
  if (missing.length) {
    console.error(`\n缺少环境变量: ${missing.join(', ')}\n请在 .env 里配置（参考 .env.example）\n`);
    process.exit(1);
  }
  return { host, port: Number(port ?? 5432), database, user, password };
}

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

async function loadMigrations() {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(join(MIGRATIONS_DIR, name), 'utf8');
      return { name, sql, hash: sha(sql) };
    })
  );
}

async function ensureMigrationsTable(client) {
  await client.query(`
    create table if not exists schema_migrations (
      name        text primary key,
      hash        text not null,
      applied_at  timestamptz not null default now(),
      duration_ms integer
    )
  `);
}

async function applied(client) {
  const { rows } = await client.query('select name, hash, applied_at from schema_migrations');
  return new Map(rows.map((r) => [r.name, r]));
}

/** 已应用的迁移被改过 = 线上和代码对不上，必须拦下来 */
function checkDrift(migrations, done) {
  const drifted = migrations.filter((m) => done.has(m.name) && done.get(m.name).hash !== m.hash);
  if (!drifted.length) return;
  console.error('\n以下迁移已经应用过，但文件内容变了：');
  for (const m of drifted) console.error(`  ✖ ${m.name}`);
  console.error(
    '\n已应用的迁移不能修改。要改结构请新建一个迁移文件。\n' +
      '（如果这是本机开发库、确定要重来，把库删了重建再跑 db:migrate）\n'
  );
  process.exit(1);
}

async function status(client, migrations) {
  const done = await applied(client);
  console.log(`\n迁移目录: ${MIGRATIONS_DIR}\n`);
  for (const m of migrations) {
    const rec = done.get(m.name);
    if (!rec) console.log(`  ○ ${m.name}  待应用`);
    else {
      const drift = rec.hash !== m.hash ? '  ⚠ 文件已被修改' : '';
      console.log(`  ● ${m.name}  ${new Date(rec.applied_at).toLocaleString('zh-CN')}${drift}`);
    }
  }
  const pending = migrations.filter((m) => !done.has(m.name)).length;
  console.log(`\n共 ${migrations.length} 个，待应用 ${pending} 个\n`);
}

async function up(client, migrations) {
  const done = await applied(client);
  checkDrift(migrations, done);

  const pending = migrations.filter((m) => !done.has(m.name));
  if (!pending.length) {
    console.log('\n没有待应用的迁移，数据库已是最新\n');
    return;
  }

  console.log(`\n待应用 ${pending.length} 个：`);
  for (const m of pending) console.log(`  ○ ${m.name}`);
  if (dryRun) return console.log('\n--dry-run，未执行\n');
  console.log('');

  for (const m of pending) {
    const t0 = Date.now();
    try {
      // 每个迁移单独一个事务：失败只回滚这一个，前面成功的保留
      await client.query('begin');
      await client.query(m.sql);
      const ms = Date.now() - t0;
      await client.query(
        'insert into schema_migrations (name, hash, duration_ms) values ($1, $2, $3)',
        [m.name, m.hash, ms]
      );
      await client.query('commit');
      console.log(`  ✔ ${m.name}  ${ms}ms`);
    } catch (e) {
      await client.query('rollback').catch(() => {});
      console.error(`  ✖ ${m.name}\n\n${e.message}\n`);
      console.error('已回滚这个迁移，前面成功的保持不变。修好后重新运行即可。\n');
      process.exit(1);
    }
  }
  console.log('\n迁移完成\n');
}

const cfg = config();
const client = new pg.Client({ ...cfg, connectionTimeoutMillis: 8000 });

try {
  await client.connect();
} catch (e) {
  console.error(`\n连不上数据库 ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);
  console.error(`  ${e.message}\n`);
  if (/ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|no route/i.test(e.message)) {
    console.error('常见原因：');
    console.error("  1. Postgres 只监听本机 —— postgresql.conf 里 listen_addresses = '*'");
    console.error('  2. pg_hba.conf 没放行你的网段 —— 加一行 host all all 192.168.101.0/24 scram-sha-256');
    console.error('  3. 服务器防火墙挡了 5432');
    console.error('  改完记得重启 Postgres。\n');
  }
  process.exit(1);
}

try {
  const migrations = await loadMigrations();
  await ensureMigrationsTable(client);
  console.log(`已连接 ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);

  if (command === 'status') await status(client, migrations);
  else if (command === 'up') await up(client, migrations);
  else {
    console.error(`未知命令: ${command}（可用: up | status）`);
    process.exit(1);
  }
} finally {
  await client.end();
}
