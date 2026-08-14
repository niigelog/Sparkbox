import { existsSync } from 'node:fs';
import pg from 'pg';

if (existsSync('.env')) process.loadEnvFile('.env');

export const pool = new pg.Pool({
  host: process.env.APP_POSTGRES_HOST,
  port: Number(process.env.APP_POSTGRES_PORT ?? 5432),
  database: process.env.APP_POSTGRES_DB,
  user: process.env.APP_POSTGRES_USER,
  password: process.env.APP_POSTGRES_PASSWORD,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 8_000,
});

pool.on('error', (e) => console.error('[db] 空闲连接出错', e.message));

/**
 * V1 还没有登录体系，所有数据挂在一个固定用户下。
 * 接真实鉴权时，把这里换成从 token 解析出的 user_id 即可 ——
 * 下面所有 SQL 都已经按 user_id 隔离，不用改。
 */
export const DEFAULT_USER_ID =
  process.env.APP_DEFAULT_USER_ID ?? '00000000-0000-0000-0000-000000000001';

export const query = (text, params) => pool.query(text, params);
