// 默认关注的基金清单：初始为空，由用户在 App 内按需添加
// （旧版本保存的清单会在新版本首次启动时自动清空）
window.DEFAULT_FUNDS = [];

// 看板顶部展示的全球主要指数（东财行情代码）
window.DEFAULT_INDICES = [
  { secid: '1.000001', name: '上证指数' },
  { secid: '0.399001', name: '深证成指' },
  { secid: '0.399006', name: '创业板指' },
  { secid: '1.000688', name: '科创50' },
  { secid: '100.NDX', name: '纳斯达克' },
  { secid: '100.N225', name: '日经225' },
  { secid: '100.KS11', name: '韩国KOSPI' },
  { secid: '103.NQ00Y', name: '纳斯达克期货' }
];
