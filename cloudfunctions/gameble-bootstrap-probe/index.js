'use strict';

const cloud = require('wx-server-sdk');
const mysql = require('mysql2/promise');
const { CoreError, dispatchMahjongAction, loadRecentActivity } = require('./mahjong-core');
const { dispatchPokerAction } = require('./poker-core');
const { dispatchProfileAction } = require('./profile-core');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

let pool;

function readDatabaseConfig(env = process.env) {
  const host = String(env.DB_HOST || '').trim();
  const port = Number(env.DB_PORT || '3306');
  const user = String(env.DB_USER || '').trim();
  const password = env.DB_PASSWORD;
  const database = String(env.DB_NAME || 'gameble_score').trim();

  if (!host || !user || password === undefined) {
    throw new Error('Database environment variables are incomplete.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('DB_PORT must be a valid TCP port.');
  }
  return { host, port, user, password, database };
}

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      ...readDatabaseConfig(),
      charset: 'utf8mb4',
      timezone: '+08:00',
      waitForConnections: true,
      connectionLimit: 2,
      queueLimit: 4,
      // The free Cloud Function environment caps execution at three seconds.
      // Fail early on an unavailable database instead of being terminated mid-call.
      connectTimeout: 2000,
      enableKeepAlive: true,
    });
  }
  return pool;
}

exports.main = async (event = {}) => {
  const startedAt = Date.now();
  try {
    const { OPENID: openId } = cloud.getWXContext();
    if (!openId) throw new Error('Missing WeChat OpenID.');

    const connection = await getPool().getConnection();
    try {
      const action = String(event?.action || 'bootstrap');
      const result = action.startsWith('getPersonal') || action === 'getMahjongOpponents' || action === 'getOperationsOverview'
        ? await dispatchProfileAction(connection, openId, event)
        : action.includes('Poker')
          ? await dispatchPokerAction(connection, openId, event)
          : await dispatchMahjongAction(connection, openId, event);
      return {
        ok: true,
        coreVersion: 2,
        ...result,
        metrics: { serverElapsedMs: Date.now() - startedAt },
      };
    } finally {
      connection.release();
    }
  } catch (error) {
    if (error instanceof CoreError) {
      return {
        ok: false,
        coreVersion: 2,
        error: { code: error.code, message: error.message },
        metrics: { serverElapsedMs: Date.now() - startedAt },
      };
    }

    // CloudBase otherwise converts unexpected errors to an opaque -504002.
    // Return only the provider error code so clients can diagnose safely.
    const providerCode = typeof error?.code === 'string' && error.code ? error.code : 'UNKNOWN';
    console.error('Mahjong core unexpected error', { action: event?.action, providerCode });
    return {
      ok: false,
      coreVersion: 2,
      error: { code: 'INTERNAL', message: `云函数内部错误（${providerCode}）` },
      metrics: { serverElapsedMs: Date.now() - startedAt },
    };
  }
};

exports.__test__ = { readDatabaseConfig, loadRecentActivity };
