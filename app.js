const API_BASE_URL = '';

function request({ path, method = 'GET', data }) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${API_BASE_URL}${path}`,
      method,
      data,
      header: { 'content-type': 'application/json' },
      success: (response) => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data);
          return;
        }
        reject(new Error(response.data?.error?.message || '请求失败'));
      },
      fail: () => reject(new Error('网络异常，请检查网络连接')),
    });
  });
}

App({
  globalData: {
    user: null,
  },

  request,

  async login() {
    const loginResult = await new Promise((resolve, reject) => {
      wx.login({ success: resolve, fail: reject });
    });
    if (!loginResult.code) {
      throw new Error('未获取到微信登录凭证');
    }
    const result = await request({
      path: '/api/mahjong/auth/wechat',
      method: 'POST',
      data: { code: loginResult.code },
    });
    this.globalData.user = result.user;
    return result;
  },
});
