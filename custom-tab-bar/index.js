Component({
  data: {
    selected: 0,
    items: [
      { pagePath: 'pages/home/home', text: '首页' },
      { pagePath: 'pages/profile/profile', text: '我的' },
    ],
  },

  lifetimes: {
    attached() {
      this.updateSelected();
    },
  },

  pageLifetimes: {
    show() {
      this.updateSelected();
    },
  },

  methods: {
    updateSelected() {
      const pages = getCurrentPages();
      const route = pages.length ? pages[pages.length - 1].route : '';
      const selected = this.data.items.findIndex((item) => item.pagePath === route);
      this.setData({ selected: selected < 0 ? 0 : selected });
    },

    switchTab(event) {
      const { index, path } = event.currentTarget.dataset;
      if (Number(index) === this.data.selected) return;
      wx.switchTab({ url: `/${path}` });
    },
  },
});
