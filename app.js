const CLOUD_ENV = 'prod-d4giemw445109b899';
const CLOUD_SERVICE = 'express-drsy';
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
      fail: (error) =>
        reject(new Error(error.errMsg || '云托管服务暂不可用，请稍后重试')),
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

  async getPokerVisits() {
    const deviceId = this.globalData.deviceId;
    const result = await request({
      path: `/api/room-visits?deviceId=${encodeURIComponent(deviceId)}&gameType=texas&limit=8`,
    });
    return result.visits || [];
  },

  recordPokerVisit(room) {
    return request({
      path: '/api/room-visits',
      method: 'POST',
      data: {
        deviceId: this.globalData.deviceId,
        roomId: room.id,
        gameType: 'texas',
        roomCode: room.roomCode,
        roomName: room.roomName,
      },
    });
  },
});
