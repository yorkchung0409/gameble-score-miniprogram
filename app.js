const CLOUD_ENV = 'prod-d4giemw445109b899';
const CLOUD_SERVICE = 'gamescore';
const DEVICE_ID_KEY = 'gameble_device_id';
const WARMUP_PATH = '/health/ready';
const WARMUP_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_READ_RETRIES = 3;
const WARMUP_RETRIES = 5;
const RETRY_DELAYS_MS = [800, 1200, 1800, 2600, 3600];
const CONTAINER_SOCKET_TIMEOUT_MS = 8000;

let warmupPromise = null;
let lastWarmupAt = 0;
let loginPromise = null;

function getErrorMessage(error) {
  return String(error?.errMsg || error?.message || '');
}

function getErrorCode(error) {
  const candidates = [error?.errCode, error?.code, error?.statusCode, error?.status];
  for (const candidate of candidates) {
    const code = Number(candidate);
    if (Number.isFinite(code)) return code;
  }
  return 0;
}

function isRetryableError(error) {
  const code = getErrorCode(error);
  const message = getErrorMessage(error);
  if ([102002, 502, 503, 504].includes(code)) return true;
  return /102002|timeout|network|request:fail|callcontainer:fail|econnreset|econnrefused/i.test(message);
}

function responseMessage(data) {
  if (typeof data === 'string') return data;
  return data?.error?.message || data?.message || '请求失败';
}

function createResponseError(response) {
  const error = new Error(responseMessage(response.data));
  error.statusCode = Number(response.statusCode) || 0;
  error.responseData = response.data;
  return error;
}

function getDeviceId() {
  let deviceId = wx.getStorageSync(DEVICE_ID_KEY);
  if (deviceId) return deviceId;

  deviceId = `wx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  wx.setStorageSync(DEVICE_ID_KEY, deviceId);
  return deviceId;
}

function callContainerOnce({ path, method, data, timeout }) {
  return new Promise((resolve, reject) => {
    const options = {
      config: { env: CLOUD_ENV },
      path,
      method,
      data,
      header: {
        'content-type': 'application/json',
        'X-WX-SERVICE': CLOUD_SERVICE,
      },
      success: (response) => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data);
          return;
        }
        reject(createResponseError(response));
      },
      fail: reject,
    };
    if (Number.isInteger(timeout) && timeout > 0) options.timeout = timeout;
    wx.cloud.callContainer(options);
  });
}

function friendlyRequestError(error) {
  if (isRetryableError(error)) {
    return new Error('云托管服务正在启动，请稍候重试');
  }
  const message = getErrorMessage(error);
  return new Error(message || responseMessage(error?.responseData));
}

function request({ path, method = 'GET', data, retry, timeout }) {
  const normalizedMethod = String(method).toUpperCase();
  const isRead = normalizedMethod === 'GET' || normalizedMethod === 'HEAD';
  const maxRetries = Number.isInteger(retry) ? Math.max(0, retry) : (isRead ? DEFAULT_READ_RETRIES : 0);
  const waitForWarmup = path !== WARMUP_PATH && warmupPromise;

  const run = (attempt) => callContainerOnce({ path, method: normalizedMethod, data, timeout }).catch((error) => {
    if (attempt < maxRetries && isRetryableError(error)) {
      const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
      return new Promise((resolve) => setTimeout(resolve, delay)).then(() => run(attempt + 1));
    }
    throw friendlyRequestError(error);
  });

  // A page opened during the app warmup shares that request instead of
  // creating a second cold-start request at the same time.
  return (waitForWarmup ? warmupPromise.catch(() => null) : Promise.resolve()).then(() => run(0));
}

App({
  globalData: {
    user: null,
    deviceId: '',
    warmed: false,
    pendingMahjongRooms: {},
  },

  onLaunch() {
    this.globalData.deviceId = getDeviceId();
    wx.cloud.init({
      env: CLOUD_ENV,
      traceUser: true,
    });
    this.warmUp();
  },

  onShow() {
    if (Date.now() - lastWarmupAt >= WARMUP_COOLDOWN_MS) {
      this.warmUp();
    }
  },

  warmUp() {
    if (warmupPromise || Date.now() - lastWarmupAt < WARMUP_COOLDOWN_MS) return warmupPromise;

    lastWarmupAt = Date.now();
    warmupPromise = request({ path: WARMUP_PATH, method: 'GET', retry: WARMUP_RETRIES })
      .then(() => {
        this.globalData.warmed = true;
        return true;
      })
      .catch(() => {
        this.globalData.warmed = false;
        lastWarmupAt = 0;
        return false;
      })
      .finally(() => {
        warmupPromise = null;
      });

    return warmupPromise;
  },

  request,

  connectContainer(path) {
    if (typeof wx.cloud.connectContainer !== 'function') {
      return Promise.reject(new Error('当前微信基础库不支持云托管 WebSocket'));
    }
    return wx.cloud.connectContainer({
      config: { env: CLOUD_ENV },
      service: CLOUD_SERVICE,
      path,
      timeout: CONTAINER_SOCKET_TIMEOUT_MS,
      tcpNoDelay: true,
    });
  },

  async login() {
    if (this.globalData.user) return { user: this.globalData.user, isNewUser: false };
    if (loginPromise) return loginPromise;

    loginPromise = request({
      path: '/api/mahjong/auth/wechat',
      method: 'POST',
      data: {},
      retry: DEFAULT_READ_RETRIES,
    })
      .then((result) => {
        this.globalData.user = result.user;
        return result;
      })
      .finally(() => {
        loginPromise = null;
      });
    return loginPromise;
  },

  createOperationId(prefix = 'op') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  },

  async getPersonalDashboard(options = {}) {
    const historyLimit = Number.isInteger(options.historyLimit) ? options.historyLimit : 1;
    const result = await request({ path: `/api/mini/me/dashboard?historyLimit=${historyLimit}` });
    const { summary, poker, mahjong } = result;
    return {
      summary,
      pokerLedgers: poker.ledgers || [],
      pokerPage: { total: poker.total || 0, hasMore: Boolean(poker.hasMore), nextOffset: poker.nextOffset || 0 },
      mahjongRooms: mahjong.rooms || [],
      mahjongPage: { total: mahjong.total || 0, hasMore: Boolean(mahjong.hasMore), nextOffset: mahjong.nextOffset || 0 },
    };
  },

  async getRecentActivity() {
    const result = await request({ path: '/api/mini/me/recent' });
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
