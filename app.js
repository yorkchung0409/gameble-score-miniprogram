const CLOUD_ENV = 'cloudbase-d8guua73779173a0c';
const CLOUD_SERVICE = 'express-drsy';

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
  },

  onLaunch() {
    wx.cloud.init({
      env: CLOUD_ENV,
      traceUser: true,
    });
  },

  request,

  async login() {
    const result = await request({
      path: '/api/mahjong/auth/wechat',
      method: 'POST',
      data: {},
    });
    this.globalData.user = result.user;
    return result;
  },
});
