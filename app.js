const CLOUD_ENV = 'prod-d4giemw445109b899';
const CLOUD_SERVICE = 'gamescore';
const DEVICE_ID_KEY = 'gameble_device_id';

function getDeviceId() {
  let deviceId = wx.getStorageSync(DEVICE_ID_KEY);
  if (deviceId) return deviceId;

  deviceId = `wx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  wx.setStorageSync(DEVICE_ID_KEY, deviceId);
  return deviceId;
}

function request({ path, method = 'GET', data }) {
  return new Promise((resolve, reject) => {
    wx.cloud.callContainer({
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
        reject(new Error(response.data?.error?.message || '请求失败'));
      },
      fail: (error) => {
        const message = error.errMsg || '';
        if (message.includes('102002')) {
          reject(new Error('云托管服务暂未就绪，请稍后重试'));
          return;
        }
        reject(new Error(message || '云托管服务暂不可用，请稍后重试'));
      },
    });
  });
}

App({
  globalData: {
    user: null,
    deviceId: '',
  },

  onLaunch() {
    this.globalData.deviceId = getDeviceId();
    wx.cloud.init({
      env: CLOUD_ENV,
      traceUser: true,
    });
  },

  request,

  async login() {
    if (this.globalData.user) return { user: this.globalData.user, isNewUser: false };
    const result = await request({
      path: '/api/mahjong/auth/wechat',
      method: 'POST',
      data: {},
    });
    this.globalData.user = result.user;
    return result;
  },

  async getPersonalDashboard() {
    const [summary, poker, mahjong, opponents] = await Promise.all([
      request({ path: '/api/mini/me/summary' }),
      request({ path: '/api/mini/me/poker-ledgers' }),
      request({ path: '/api/mini/me/mahjong-rooms' }),
      request({ path: '/api/mini/me/mahjong-opponents' }),
    ]);
    return {
      summary,
      pokerLedgers: poker.ledgers || [],
      mahjongRooms: mahjong.rooms || [],
      opponents: opponents.opponents || [],
    };
  },

  async getPersonalPokerLedgers() {
    const result = await request({ path: '/api/mini/me/poker-ledgers' });
    return result.ledgers || [];
  },
});
