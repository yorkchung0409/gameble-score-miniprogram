const CLOUDBASE_FUNCTION_ENV = 'cloudbase-d8guua73779173a0c';
const BOOTSTRAP_FUNCTION_NAME = 'gameble-bootstrap-probe';
const DEVICE_ID_KEY = 'gameble_device_id';
const SHELL_READ_CACHE_TTL_MS = 1000;

let loginPromise = null;
let bootstrapProbePromise = null;
const inFlightReadRequests = new Map();
const recentReadResponses = new Map();
let readCacheGeneration = 0;

function getErrorMessage(error) {
  return String(error?.errMsg || error?.message || '');
}

function getDeviceId() {
  let deviceId = wx.getStorageSync(DEVICE_ID_KEY);
  if (deviceId) return deviceId;

  deviceId = `wx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  wx.setStorageSync(DEVICE_ID_KEY, deviceId);
  return deviceId;
}

function createCoreFunctionError(result) {
  const error = new Error(result?.error?.message || '云函数操作失败');
  error.coreFunction = true;
  error.coreBusiness = Boolean(result?.error?.code && result.error.code !== 'INTERNAL');
  error.code = result?.error?.code || '';
  return error;
}

function parseRoute(path) {
  const [pathname, queryString = ''] = String(path || '').split('?');
  const query = {};
  queryString.split('&').filter(Boolean).forEach((item) => {
    const [key, value = ''] = item.split('=');
    query[decodeURIComponent(key)] = decodeURIComponent(value);
  });
  return { pathname, query };
}

// The Mini Program still uses a small request-shaped adapter so page code stays
// compact, but every mapped route is now a Cloud Function action. No request
// in this adapter reaches Cloud Hosting.
function functionActionForRequest({ path, method, data }) {
  const { pathname, query } = parseRoute(path);
  const normalizedMethod = String(method || 'GET').toUpperCase();
  const payload = data || {};
  const pokerMatch = pathname.match(/^\/api\/mini\/poker\/ledgers\/([^/]+)(?:\/(.*))?$/);
  const mahjongMatch = pathname.match(/^\/api\/mahjong\/rooms\/([^/]+)(?:\/(.*))?$/);
  if (pathname === '/api/mini/poker/ledgers' && normalizedMethod === 'POST') return { action: 'createPokerLedger', ...payload };
  if (pokerMatch) {
    const roomCode = decodeURIComponent(pokerMatch[1]);
    const suffix = pokerMatch[2] || '';
    if (!suffix && normalizedMethod === 'GET') return { action: 'getPokerLedger', roomCode, gameLimit: query.gameLimit, gameOffset: query.gameOffset };
    if (suffix === 'settings' && normalizedMethod === 'PATCH') return { action: 'updatePokerSettings', roomCode, ...payload };
    if (suffix === 'players' && normalizedMethod === 'POST') return { action: 'addPokerPlayer', roomCode, ...payload };
    const playerMatch = suffix.match(/^players\/([^/]+)$/);
    if (playerMatch && normalizedMethod === 'DELETE') return { action: 'deletePokerPlayer', roomCode, playerId: decodeURIComponent(playerMatch[1]) };
    if (suffix === 'games' && normalizedMethod === 'POST') return { action: 'createPokerGame', roomCode, ...payload };
    const gameMatch = suffix.match(/^games\/([^/]+)$/);
    if (gameMatch && normalizedMethod === 'PUT') return { action: 'updatePokerGame', roomCode, gameId: decodeURIComponent(gameMatch[1]), ...payload };
    if (gameMatch && normalizedMethod === 'DELETE') return { action: 'deletePokerGame', roomCode, gameId: decodeURIComponent(gameMatch[1]) };
  }
  if (pathname === '/api/mini/me/dashboard') return { action: 'getPersonalDashboard', historyLimit: query.historyLimit };
  if (pathname === '/api/mini/me/recent') return { action: 'getPersonalRecentActivity' };
  if (pathname === '/api/mini/me/poker-ledgers') return { action: 'getPersonalPokerLedgers', limit: query.limit, offset: query.offset };
  if (pathname === '/api/mini/me/mahjong-rooms') return { action: 'getPersonalMahjongRooms', limit: query.limit, offset: query.offset, activeOnly: query.activeOnly === 'true' };
  if (pathname === '/api/mini/me/mahjong-opponents') return { action: 'getMahjongOpponents', limit: query.limit, offset: query.offset };
  if (pathname === '/api/mini/operations/overview') return { action: 'getOperationsOverview' };
  if (pathname === '/api/mahjong/auth/wechat') return { action: 'login' };
  if (pathname === '/api/mahjong/rooms' && normalizedMethod === 'POST') return { action: 'createMahjongRoom', ...payload };
  if (mahjongMatch) {
    const roomCode = decodeURIComponent(mahjongMatch[1]);
    const suffix = mahjongMatch[2] || '';
    if (!suffix && normalizedMethod === 'GET') return { action: 'getMahjongRoom', roomCode, limit: query.transactionLimit, offset: query.transactionOffset };
    if (suffix === 'join' && normalizedMethod === 'POST') return { action: 'joinMahjongRoom', roomCode };
    if (suffix === 'mode' && normalizedMethod === 'POST') return { action: 'updateMahjongMode', roomCode, ...payload };
    if (suffix === 'tea-fee-rule' && normalizedMethod === 'PATCH') return { action: 'updateTeaFeeRule', roomCode, ...payload };
    if (suffix === 'seats/sit' && normalizedMethod === 'POST') return { action: 'sitDown', roomCode, ...payload };
    if (suffix === 'seats/leave' && normalizedMethod === 'POST') return { action: 'leaveSeat', roomCode };
    if (suffix === 'leave' && normalizedMethod === 'POST') return { action: 'leaveMahjongRoom', roomCode };
    if (suffix === 'transactions' && normalizedMethod === 'POST') return { action: 'createMahjongTransaction', roomCode, ...payload };
    const reversalMatch = suffix.match(/^transactions\/([^/]+)\/reverse$/);
    if (reversalMatch && normalizedMethod === 'POST') return { action: 'reverseMahjongTransaction', roomCode, transactionId: decodeURIComponent(reversalMatch[1]) };
  }
  if (/^\/api\/mahjong\/users\/[^/]+\/profile$/.test(pathname) && normalizedMethod === 'PATCH') return { action: 'updateMahjongUserProfile', ...payload };
  throw new Error(`当前版本没有对应的云函数操作：${pathname}`);
}

function callCoreFunction(data) {
  if (typeof wx.cloud.callFunction !== 'function') {
    return Promise.reject(new Error('当前基础库不支持云函数调用'));
  }
  return wx.cloud.callFunction({
    name: BOOTSTRAP_FUNCTION_NAME,
    data,
    config: { env: CLOUDBASE_FUNCTION_ENV },
  }).then((response) => {
    const result = response?.result;
    if (result?.coreVersion !== 2) {
      throw new Error('云函数核心版本尚未部署');
    }
    if (!result.ok) throw createCoreFunctionError(result);
    return result;
  });
}

function request({ path, method = 'GET', data, retry, timeout, cacheTtl = 0 }) {
  const normalizedMethod = String(method).toUpperCase();
  const isRead = normalizedMethod === 'GET' || normalizedMethod === 'HEAD';
  const executeOnce = () => {
    const requestPromise = callCoreFunction(functionActionForRequest({ path, method: normalizedMethod, data }));
    const timeoutMs = Number(timeout);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return requestPromise;
    return Promise.race([
      requestPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('请求超时，请重试')), timeoutMs)),
    ]);
  };
  const retryCount = isRead
    ? Math.min(Math.max(Number.isInteger(retry) ? retry : 1, 0), 2)
    : 0;
  const execute = async () => {
    let attempt = 0;
    while (true) {
      try {
        return await executeOnce();
      } catch (error) {
        if (attempt >= retryCount) throw error;
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
  };
  if (!isRead) {
    return execute().then((result) => {
      // Any completed write can change the small shell payloads shown on home
      // and profile, so stale responses must not survive it.
      readCacheGeneration += 1;
      recentReadResponses.clear();
      return result;
    });
  }

  const cacheKey = `${normalizedMethod}:${path}`;
  const now = Date.now();
  const ttl = Number.isInteger(cacheTtl) ? Math.max(0, cacheTtl) : 0;
  if (ttl === 0) recentReadResponses.delete(cacheKey);
  const cached = recentReadResponses.get(cacheKey);
  if (ttl > 0 && cached && now - cached.savedAt < ttl) {
    return Promise.resolve(cached.data);
  }

  const inFlight = inFlightReadRequests.get(cacheKey);
  if (inFlight) return inFlight;

  const requestGeneration = readCacheGeneration;
  const pending = execute()
    .then((result) => {
      if (ttl > 0 && requestGeneration === readCacheGeneration) {
        recentReadResponses.set(cacheKey, { data: result, savedAt: Date.now() });
      }
      return result;
    })
    .finally(() => {
      inFlightReadRequests.delete(cacheKey);
    });
  inFlightReadRequests.set(cacheKey, pending);
  return pending;
}

App({
  globalData: {
    user: null,
    deviceId: '',
    warmed: false,
    pendingMahjongRooms: {},
    bootstrapProbe: null,
    startupMetrics: {
      launchedAt: 0,
      cloudFunction: null,
      cloudHostingReady: null,
      login: null,
      mahjongActions: {},
    },
  },

  onShareAppMessage() {
    return this.getDefaultShareMessage();
  },

  onLaunch() {
    this.globalData.deviceId = getDeviceId();
    this.globalData.startupMetrics.launchedAt = Date.now();
    wx.cloud.init({
      // The function and room-update watcher share this CloudBase environment.
      // Cloud Hosting is no longer part of the Mini Program request path.
      env: CLOUDBASE_FUNCTION_ENV,
      traceUser: true,
    });
    this.probeBootstrap();
  },

  onShow() {},

  warmUp() {
    this.globalData.warmed = true;
    return Promise.resolve(true);
  },

  request,

  probeBootstrap() {
    if (bootstrapProbePromise) return bootstrapProbePromise;

    if (typeof wx.cloud.callFunction !== 'function') {
      const unavailable = { ok: false, totalElapsedMs: 0, error: '当前基础库不支持云函数调用' };
      this.globalData.bootstrapProbe = unavailable;
      this.globalData.startupMetrics.cloudFunction = unavailable;
      return Promise.resolve(unavailable);
    }

    const startedAt = Date.now();
    bootstrapProbePromise = callCoreFunction({ action: 'bootstrap' })
      .then((result) => {
        // The Cloud Function receives a trusted OpenID from WeChat, so its
        // bootstrap user is the same authenticated identity login() needs.
        if (result?.user) this.globalData.user = result.user;
        this.globalData.bootstrapProbe = {
          ok: Boolean(result?.ok),
          totalElapsedMs: Date.now() - startedAt,
          serverElapsedMs: Number(result?.metrics?.serverElapsedMs) || 0,
          result,
        };
        this.globalData.startupMetrics.cloudFunction = this.globalData.bootstrapProbe;
        return this.globalData.bootstrapProbe;
      })
      .catch((error) => {
        this.globalData.bootstrapProbe = {
          ok: false,
          totalElapsedMs: Date.now() - startedAt,
          error: getErrorMessage(error),
        };
        this.globalData.startupMetrics.cloudFunction = this.globalData.bootstrapProbe;
        return this.globalData.bootstrapProbe;
      })
      .finally(() => {
        bootstrapProbePromise = null;
      });

    return bootstrapProbePromise;
  },

  async getBootstrapRecentActivity() {
    const probe = await this.probeBootstrap();
    if (!probe.ok || !probe.result?.recent) return null;
    return {
      mahjongRooms: Array.isArray(probe.result.recent.mahjongRooms)
        ? probe.result.recent.mahjongRooms
        : [],
      pokerLedgers: Array.isArray(probe.result.recent.pokerLedgers)
        ? probe.result.recent.pokerLedgers
        : [],
    };
  },

  async mahjongCore(action, data = {}) {
    const startedAt = Date.now();
    return callCoreFunction({ action, ...data })
      .then((result) => {
        this.globalData.startupMetrics.mahjongActions[action] = {
          ok: true,
          totalElapsedMs: Date.now() - startedAt,
          serverElapsedMs: Number(result?.metrics?.serverElapsedMs) || 0,
        };
        return result;
      })
      .catch((error) => {
        this.globalData.startupMetrics.mahjongActions[action] = {
          ok: false,
          totalElapsedMs: Date.now() - startedAt,
          error: getErrorMessage(error),
        };
        throw error;
      });
  },

  async login() {
    if (this.globalData.user) {
      if (!this.globalData.startupMetrics.login) {
        this.globalData.startupMetrics.login = {
          ok: true,
          source: this.globalData.bootstrapProbe?.ok ? 'cloud_function' : 'cached',
          totalElapsedMs: this.globalData.startupMetrics.launchedAt
            ? Date.now() - this.globalData.startupMetrics.launchedAt
            : 0,
          sinceLaunchMs: this.globalData.startupMetrics.launchedAt
            ? Date.now() - this.globalData.startupMetrics.launchedAt
            : 0,
        };
      }
      return { user: this.globalData.user, isNewUser: false };
    }
    if (loginPromise) return loginPromise;

    const startedAt = Date.now();
    const saveLogin = (result, source) => {
      this.globalData.user = result.user;
      this.globalData.startupMetrics.login = {
        ok: true,
        source,
        totalElapsedMs: Date.now() - startedAt,
        sinceLaunchMs: this.globalData.startupMetrics.launchedAt
          ? Date.now() - this.globalData.startupMetrics.launchedAt
          : 0,
      };
      return result;
    };
    loginPromise = this.probeBootstrap()
      .then((probe) => {
        if (probe.ok && probe.result?.user) return saveLogin(probe.result, 'cloud_function');
        return this.mahjongCore('login').then((result) => saveLogin(result, 'cloud_function'));
      })
      .catch((error) => {
        this.globalData.startupMetrics.login = {
          ok: false,
          totalElapsedMs: Date.now() - startedAt,
          error: getErrorMessage(error),
        };
        throw error;
      })
      .finally(() => {
        loginPromise = null;
      });
    return loginPromise;
  },

  createOperationId(prefix = 'op') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  },

  getDefaultShareMessage() {
    return {
      title: '打牌记分房',
      path: '/pages/home/home',
    };
  },

  getDefaultTimelineShare() {
    return {
      title: '打牌记分房',
      query: '',
    };
  },

  async getPersonalDashboard(options = {}) {
    const historyLimit = Number.isInteger(options.historyLimit) ? options.historyLimit : 1;
    const result = await request({
      path: `/api/mini/me/dashboard?historyLimit=${historyLimit}`,
      cacheTtl: options.force ? 0 : SHELL_READ_CACHE_TTL_MS,
    });
    const { summary, poker, mahjong } = result;
    return {
      summary,
      canAccessOperations: Boolean(result.canAccessOperations),
      pokerLedgers: poker.ledgers || [],
      pokerPage: { total: poker.total || 0, hasMore: Boolean(poker.hasMore), nextOffset: poker.nextOffset || 0 },
      mahjongRooms: mahjong.rooms || [],
      mahjongPage: { total: mahjong.total || 0, hasMore: Boolean(mahjong.hasMore), nextOffset: mahjong.nextOffset || 0 },
    };
  },

  async getRecentActivity(options = {}) {
    const result = await request({
      path: '/api/mini/me/recent',
      cacheTtl: options.force ? 0 : SHELL_READ_CACHE_TTL_MS,
    });
    return {
      pokerLedgers: result.poker?.ledgers || [],
      mahjongRooms: result.mahjong?.rooms || [],
    };
  },

  async getPersonalPokerLedgers(options = {}) {
    const limit = Number.isInteger(options.limit) ? options.limit : 20;
    const offset = Number.isInteger(options.offset) ? options.offset : 0;
    return request({ path: `/api/mini/me/poker-ledgers?limit=${limit}&offset=${offset}` });
  },

  async getPersonalMahjongRooms(options = {}) {
    const limit = Number.isInteger(options.limit) ? options.limit : 20;
    const offset = Number.isInteger(options.offset) ? options.offset : 0;
    const activeOnly = options.activeOnly ? '&activeOnly=true' : '';
    return request({ path: `/api/mini/me/mahjong-rooms?limit=${limit}&offset=${offset}${activeOnly}` });
  },
});
