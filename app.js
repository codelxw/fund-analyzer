(function () {
  'use strict';

  const APP_VERSION = 4;
  const QUICK_TICK_MS = 10 * 1000;   // 行情预估自动刷新间隔
  const NAV_CHECK_EVERY = 6;          // 每 6 个 tick（约 60 秒）检查一次净值更新
  let quickTicks = 0;

  // ================= 基础工具 =================
  const $ = sel => document.querySelector(sel);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtPct = (v, d = 2) => (v == null || isNaN(v)) ? '--' : (v > 0 ? '+' : '') + v.toFixed(d) + '%';
  const cls = v => (v > 0.005) ? 'up' : (v < -0.005 ? 'down' : 'flat');

  // 图表配色（跟随白天/黑夜主题）
  function T() {
    const light = document.documentElement.dataset.theme === 'light';
    return light ? {
      text: '#1b2b45',
      muted: '#5f6f8a',
      line: '#c7d2e3',
      lineSoft: 'rgba(120,140,170,.35)',
      accent: '#0ea5e9'
    } : {
      text: '#e6edf7',
      muted: '#8b9bb4',
      line: '#263352',
      lineSoft: 'rgba(38,51,82,.5)',
      accent: '#38bdf8'
    };
  }

  function shortName(n) {
    if (!n) return '';
    return n
      .replace(/[（(]QDII[）)]/g, '')
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/(混合|股票|债券|指数)(人民币|美元|美元现汇|美元现钞)?(A|C|D|E|F|I)?$/, '')
      .replace(/(人民币|美元|现汇|现钞)$/, '')
      .trim();
  }

  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  };

  function fmtDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function fmtClock(ts) {
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
  }

  function maxEstClock() {
    let best = '';
    for (const b of state.bundles.values()) {
      if (b.estimate && b.estimate.updatedAt) {
        const c = fmtClock(b.estimate.updatedAt);
        if (c > best) best = c;
      }
    }
    return best ? '，预估更新于 ' + best : '';
  }

  function estBasisText(b) {
    const basis = b.estimate && b.estimate.basis;
    if (!basis) return '预估';
    if (basis.method === 'holdings') return '持仓测算' + (basis.corr != null ? '（拟合' + Math.round(basis.corr * 100) + '%）' : '');
    if (basis.method === 'blend') return '持仓+趋势（疑似调仓·拟合' + Math.round(basis.corr * 100) + '%）';
    return '近期均值';
  }

  // 基金是否 QDII（净值按 T+2 披露，比 A股 T+1 晚一个交易日）
  function isQDIIFund(b) {
    return /QDII/i.test((b && b.name) || '');
  }

  // 统一口径：净值日期是“当天”（工作日）才算已更新，否则就是待更新。
  // A股(T+1)、QDII(T+2)都适用；QDII 披露慢，多数时间会显示“待更新 + 今日预估涨幅”。
  // 周末没有新的净值，回退到最近一个交易日（上周五）判断。
  function expectedNavDate() {
    const d = new Date();
    const day = d.getDay(); // 0 周日 ~ 6 周六
    if (day === 0 || day === 6) {
      const t = new Date(d);
      t.setDate(t.getDate() - (day === 0 ? 2 : 1));
      return fmtDate(t);
    }
    return fmtDate(d);
  }

  // 是否已更新：净值日期达到/超过该基金今天应有的日期
  function isFundUpdated(b) {
    return !!(b && b.navDate && b.navDate >= expectedNavDate(b));
  }

  // A股今日是否已开盘（9:15 集合竞价起视为已开盘；周末不开盘）
  function aShareOpenNow() {
    const d = new Date();
    const day = d.getDay();
    if (day === 0 || day === 6) return false;
    const t = d.getHours() * 60 + d.getMinutes();
    return t >= 9 * 60 + 15;
  }

  // 该基金是否应该展示预估（净值日之后有未定价交易；A股还需今日已开盘）
  function isShowEstimate(b) {
    if (!b || !b.estimate || b.estimate.pct == null || !b.estimate.date) return false;
    if (!(b.estimate.date > b.navDate)) return false;
    if (isQDIIFund(b)) return true;
    return aShareOpenNow();
  }

  // 预估标签：统一为“今日预估涨幅”（已更新/待更新按 A股 T+1、QDII T+2 口径判断）
  function estTimeLabel() {
    return '今日预估涨幅';
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 2800);
  }

  // ================= 网络层 =================
  const MOB = 'deviceid=Wap&plat=Wap&product=EFund&version=2.0.0';
  const urlPeriod = c => `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNPeriodIncrease?FCODE=${c}&${MOB}`;
  const urlHold = c => `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition?FCODE=${c}&${MOB}`;
  const urlPzd = c => `https://fund.eastmoney.com/pingzhongdata/${c}.js?v=${Date.now()}`;

  async function fetchJson(url, timeout = 15000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error('请求失败 HTTP ' + res.status);
      const j = await res.json();
      if (j && j.Success === false) throw new Error(j.ErrMsg || '接口返回失败');
      return j;
    } finally { clearTimeout(timer); }
  }

  let cbSeq = 0;
  function jsonp(url) {
    return new Promise((resolve, reject) => {
      const name = '__gfc' + (++cbSeq) + '_' + Date.now();
      let s = null;
      const cleanup = () => { delete window[name]; if (s && s.parentNode) s.parentNode.removeChild(s); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('请求超时')); }, 20000);
      window[name] = data => { clearTimeout(timer); cleanup(); resolve(data); };
      s = document.createElement('script');
      s.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + name;
      s.onerror = () => { clearTimeout(timer); cleanup(); reject(new Error('加载失败')); };
      document.head.appendChild(s);
    });
  }

  let pzdChain = Promise.resolve();
  function loadPzd(code) {
    pzdChain = pzdChain.then(() => new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = urlPzd(code);
      const timer = setTimeout(() => { if (s.parentNode) s.parentNode.removeChild(s); reject(new Error('净值数据加载超时')); }, 25000);
      s.onload = () => {
        clearTimeout(timer);
        if (window.fS_code !== code) {
          if (s.parentNode) s.parentNode.removeChild(s);
          reject(new Error('数据错乱，请重试'));
          return;
        }
        const d = {
          name: window.fS_name || code,
          netWorthTrend: Array.isArray(window.Data_netWorthTrend) ? window.Data_netWorthTrend : [],
          assetAllocation: window.Data_assetAllocation || null,
          managers: Array.isArray(window.Data_currentFundManager) ? window.Data_currentFundManager : [],
          rankSeries: window.Data_rateInSimilarType || [],
          rankPctSeries: window.Data_rateInSimilarPersent || [],
          grandTotal: window.Data_grandTotal || null,
          holderStructure: window.Data_holderStructure || null,
          sharesPositions: window.Data_fundSharesPositions || []
        };
        if (s.parentNode) s.parentNode.removeChild(s);
        resolve(d);
      };
      s.onerror = () => { clearTimeout(timer); if (s.parentNode) s.parentNode.removeChild(s); reject(new Error('净值数据加载失败')); };
      document.head.appendChild(s);
    }));
    return pzdChain;
  }

  // ================= 数据转换 =================
  function navSeries(nwt) {
    return (nwt || []).filter(p => p && p.y != null).map(p => ({
      d: fmtDate(new Date(p.x)),
      nav: p.y,
      chg: p.equityReturn != null ? p.equityReturn : null
    }));
  }

  const PERIOD_MAP = { Z: '1w', Y: '1m', '3Y': '3m', '6Y': '6m', '1N': '1y', JN: 'ytd', LN: 'incep', '2N': '2y', '3N': '3y', '5N': '5y' };
  function parsePeriods(pi) {
    const out = {};
    for (const it of (pi && pi.Datas) || []) {
      const key = PERIOD_MAP[it.title];
      if (!key) continue;
      out[key] = {
        ret: parseFloat(it.syl),
        avg: (it.avg === '' || it.avg == null) ? null : parseFloat(it.avg),
        hs300: (it.hs300 === '' || it.hs300 == null) ? null : parseFloat(it.hs300),
        rank: (it.rank === '' || it.rank == null) ? null : parseInt(it.rank, 10),
        total: (it.sc === '' || it.sc == null) ? null : parseInt(it.sc, 10),
        diff: (it.diff === '' || it.diff == null) ? null : parseInt(it.diff, 10)
      };
    }
    return out;
  }

  function periodFromSeries(series, days) {
    if (!series.length) return null;
    const last = series[series.length - 1].nav;
    const target = new Date(series[series.length - 1].d);
    target.setDate(target.getDate() - days);
    const ts = target.getTime();
    let base = null;
    for (let i = series.length - 1; i >= 0; i--) {
      if (new Date(series[i].d + 'T00:00:00').getTime() <= ts) { base = series[i].nav; break; }
    }
    if (base == null) base = series[0].nav;
    return (last / base - 1) * 100;
  }

  function fallbackPeriods(series) {
    if (!series.length) return {};
    return {
      '1w': { ret: periodFromSeries(series, 7) },
      '1m': { ret: periodFromSeries(series, 30) },
      '3m': { ret: periodFromSeries(series, 91) },
      '6m': { ret: periodFromSeries(series, 182) },
      '1y': { ret: periodFromSeries(series, 365) },
      ytd: { ret: (() => {
        const year = series[series.length - 1].d.slice(0, 4);
        const jan1 = new Date(year + '-01-01T00:00:00').getTime();
        const last = series[series.length - 1].nav;
        let base = series[0].nav;
        for (let i = series.length - 1; i >= 0; i--) {
          if (new Date(series[i].d + 'T00:00:00').getTime() < jan1) { base = series[i].nav; break; }
        }
        return (last / base - 1) * 100;
      })() }
    };
  }

  const MARKET = { 0: 'A股', 1: 'A股', 5: '港股', 6: 'A股', 7: '美股' };
  function parseHoldings(j) {
    if (!j || !j.Datas || !Array.isArray(j.Datas.fundStocks)) return null;
    const rows = j.Datas.fundStocks.map(s => ({
      code: s.GPDM,
      name: s.GPJC,
      weight: parseFloat(s.JZBL),
      type: s.PCTNVCHGTYPE || '',
      change: (s.PCTNVCHG === '--' || s.PCTNVCHG == null) ? null : parseFloat(s.PCTNVCHG),
      market: MARKET[s.TEXCH] || (s.TEXCH ? '其他' : ''),
      industry: (s.INDEXNAME && s.INDEXNAME !== '--') ? s.INDEXNAME : ''
    }));
    return { date: j.Expansion || '', rows };
  }

  function lastNonNull(arr) {
    if (!Array.isArray(arr)) return null;
    for (let i = arr.length - 1; i >= 0; i--) {
      const v = arr[i];
      if (v && v.y != null && v.y !== '' && v.y !== '-') return v;
    }
    return null;
  }

  function parseRankDaily(pzd) {
    const r = lastNonNull(pzd.rankSeries);
    const p = lastNonNull(pzd.rankPctSeries);
    if (!r) return null;
    return {
      rank: r.y,
      total: r.sc,
      percentile: p && p.y != null ? p.y : null,
      date: fmtDate(new Date(r.x))
    };
  }

  function parseTsPairs(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.filter(p => p && p[0] != null && p[1] != null).map(p => ({
      d: fmtDate(new Date(p[0])),
      y: p[1]
    }));
  }

  function parseAssetAlloc(aa) {
    if (!aa || !Array.isArray(aa.categories) || !Array.isArray(aa.series)) return null;
    const out = [];
    for (let i = 0; i < aa.categories.length; i++) {
      const row = { date: aa.categories[i] };
      for (const s of aa.series) row[s.name] = s.data[i] != null ? s.data[i] : null;
      out.push(row);
    }
    return out;
  }

  function parseHolderStructure(hs) {
    if (!hs || !Array.isArray(hs.categories) || !Array.isArray(hs.series)) return null;
    const names = hs.series.map(s => s.name);
    return hs.categories.map((c, i) => {
      const row = { date: c };
      hs.series.forEach(s => { row[s.name] = s.data[i] != null ? s.data[i] : null; });
      return row;
    });
  }

  function maxDD(series, days) {
    if (!series.length) return null;
    const target = new Date(series[series.length - 1].d);
    target.setDate(target.getDate() - days);
    const ts = target.getTime();
    let peak = -Infinity, mdd = 0;
    for (const p of series) {
      if (new Date(p.d + 'T00:00:00').getTime() < ts) continue;
      if (p.nav > peak) peak = p.nav;
      const dd = (p.nav / peak - 1) * 100;
      if (dd < mdd) mdd = dd;
    }
    return mdd;
  }

  function vol1y(series) {
    if (series.length < 10) return null;
    const rets = [];
    for (let i = 1; i < series.length; i++) {
      const r = series[i].nav / series[i - 1].nav - 1;
      if (isFinite(r)) rets.push(r);
    }
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const v = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
    return Math.sqrt(v) * Math.sqrt(252) * 100;
  }

  function compareHoldings(cur, prev) {
    if (!cur) return null;
    const sumTop = rows => rows.slice(0, 10).reduce((a, r) => a + (r.weight || 0), 0);
    const c = { conc: sumTop(cur.rows) };
    c.added = cur.rows.filter(r => r.type === '新增').length;
    c.inc = cur.rows.filter(r => r.type === '增持').length;
    c.dec = cur.rows.filter(r => r.type === '减持').length;
    c.hold = cur.rows.filter(r => r.type === '不变').length;
    if (prev && prev.rows.length && prev.date !== cur.date) {
      const prevCodes = new Set(prev.rows.slice(0, 10).map(r => r.code));
      const curCodes = cur.rows.slice(0, 10).map(r => r.code);
      c.prevConc = sumTop(prev.rows);
      c.overlap = curCodes.filter(x => prevCodes.has(x)).length;
      c.exited = prev.rows.slice(0, 10).filter(r => !curCodes.includes(r.code)).map(r => r.name);
      c.prevDate = prev.date;
    }
    return c;
  }

  // ================= 状态与缓存 =================
  const state = {
    funds: LS.get('gfc:funds', []),
    bundles: new Map(),
    boardGroup: 'all',
    boardRange: '1w',
    boardOrder: 'desc',
    updateGroup: 'updated',
    updateGroupTouched: false,
    updateSort: 'ret',
    expandedCodes: new Set(),
    trendRange: '3m',
    trendGroup: 'all',
    trendSel: [],
    fitFund: null,
    holdFund: null,
    holdGroup: 'all',
    refreshing: false,
    detailCode: null,
    stockCode: null,
    detailRange: '1y',
    detailTab: 'perf',
    currentTab: 'board',
    themePref: 'dark'
  };
  const charts = {};

  function saveFunds() { LS.set('gfc:funds', state.funds); }
  function bundleFromCache(code) {
    const b = LS.get('gfc:bundle:' + code, null);
    if (b && b.series && b.series.length) return b;
    return null;
  }
  function bundleFresh(b) {
    if (!b) return false;
    const age = Date.now() - new Date(b.fetchedAt).getTime();
    const navAge = b.navDate ? Date.now() - new Date(b.navDate + 'T00:00:00').getTime() : 1e12;
    return age < 8 * 3600e3 && navAge < 2 * 86400e3;
  }
  function fundOf(code) { return state.funds.find(f => f.code === code); }

  async function fetchBundle(code) {
    const [piJson, holdJson, pzd] = await Promise.all([
      fetchJson(urlPeriod(code)).catch(e => ({ error: e.message })),
      fetchJson(urlHold(code)).catch(() => null),
      loadPzd(code)
    ]);
    const series = navSeries(pzd.netWorthTrend);
    if (!series.length) throw new Error('净值数据为空');
    const last = series[series.length - 1];
    let periods = parsePeriods(piJson);
    const fb = fallbackPeriods(series);
    for (const k of Object.keys(fb)) {
      if (!periods[k]) periods[k] = fb[k];
      else if (periods[k].ret == null) periods[k].ret = fb[k].ret;
    }
    const rankDaily = parseRankDaily(pzd);
    const holders = parseHoldings(holdJson);

    let prev = null;
    const snap = LS.get('gfc:snap:' + code, null);
    if (holders && holders.date) {
      if (snap && snap.date && snap.date !== holders.date) prev = snap;
      LS.set('gfc:snap:' + code, {
        date: holders.date,
        rows: holders.rows.slice(0, 10).map(r => ({ code: r.code, name: r.name, weight: r.weight }))
      });
    }
    const compare = compareHoldings(holders, prev);
    const mgr = pzd.managers && pzd.managers[0] ? pzd.managers[0] : null;

    const perfTrend = (Array.isArray(pzd.grandTotal) ? pzd.grandTotal : [])
      .map(e => ({ name: (e.name || '').trim(), points: parseTsPairs(e.data) }));
    const sharesPositions = parseTsPairs(pzd.sharesPositions);
    const rankTrend = parseTsPairs(pzd.rankPctSeries);

    return {
      code,
      name: pzd.name || code,
      fetchedAt: new Date().toISOString(),
      navDate: last.d,
      nav: last.nav,
      dailyChange: last.chg,
      series,
      periods,
      holders,
      holdingsApiOk: !!holders,
      rankDaily,
      compare,
      assetAlloc: parseAssetAlloc(pzd.assetAllocation),
      holderStructure: parseHolderStructure(pzd.holderStructure),
      perfTrend,
      sharesPositions,
      rankTrend,
      manager: mgr,
      estimate: null,
      stats: {
        maxDD1m: maxDD(series, 30),
        maxDD3m: maxDD(series, 91),
        maxDD6m: maxDD(series, 182),
        maxDD1y: maxDD(series, 365),
        vol1y: vol1y(series)
      }
    };
  }

  async function refreshAll(force) {
    if (state.refreshing) return;
    state.refreshing = true;
    setRefreshUI();
    const results = [];
    try {
      for (let i = 0; i < state.funds.length; i++) {
        const f = state.funds[i];
        try {
          const b = await fetchBundle(f.code);
          b.estimate = null;
          state.bundles.set(f.code, b);
          LS.set('gfc:bundle:' + f.code, b);
          results.push({ code: f.code, name: b.name, ok: true });
        } catch (e) {
          results.push({ code: f.code, name: f.name, ok: false, error: e.message });
          const old = bundleFromCache(f.code);
          if (old) state.bundles.set(f.code, old);
        }
        updateHeader();
      }
      await estimateFunds();
      for (const b of state.bundles.values()) {
        if (b.estimate) LS.set('gfc:bundle:' + b.code, b);
      }
      LS.set('gfc:meta', { updatedAt: new Date().toISOString(), results });
    } catch (e) {
      console.error('刷新失败', e);
      LS.set('gfc:meta', { updatedAt: new Date().toISOString(), results });
    } finally {
      state.refreshing = false;
      setRefreshUI();
      setStatus('');
      renderAll();
      const fail = results.filter(r => !r.ok);
      if (fail.length) toast(`更新完成，${fail.length} 只基金失败：` + fail.map(r => r.code).join('、'));
      else toast('数据已更新');
    }
  }

  // ---------- 当日行情预估（基于上季持仓 + 最新行情） ----------
  function symForStock(r) {
    const c = (r.code || '').trim();
    if (!c) return null;
    if (r.market === '美股' || /^[A-Z]/.test(c)) return 'us' + c.toUpperCase();
    if (r.market === '港股') return 'hk' + c;
    if (/^6\d{5}$/.test(c)) return 'sh' + c;
    if (/^[03]\d{5}$/.test(c)) return 'sz' + c;
    return null;
  }

  // 拉取各市场日 K 线（收盘价），用于从基金净值日到最新收盘的累计涨跌估算
  async function fetchKlines(symbols, days = 30) {
    const out = {};
    let idx = 0;
    const workers = [];
    const candidates = sym => {
      if (sym.startsWith('us')) return [sym + '.OQ', sym + '.N', sym];
      return [sym];
    };
    for (let w = 0; w < 6; w++) {
      workers.push((async () => {
        while (idx < symbols.length) {
          const sym = symbols[idx++];
          let pts = [];
          for (const cand of candidates(sym)) {
            try {
              const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + cand + ',day,,,' + days + ',qfq';
              const ctrl = new AbortController();
              const timer = setTimeout(() => ctrl.abort(), 15000);
              const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
              const j = await res.json();
              const d = j && j.data && j.data[cand];
              const arr = (d && (d.qfqday || d.day)) || [];
              pts = arr.filter(x => Array.isArray(x) && x.length >= 3 && x[0] && parseFloat(x[2]) > 0)
                .map(x => ({ d: String(x[0]), close: parseFloat(x[2]) }));
              clearTimeout(timer);
            } catch (e) { /* 尝试下一个代码 */ }
            if (pts.length >= 5) break;
          }
          if (pts.length) out[sym.toUpperCase()] = pts;
        }
      })());
    }
    await Promise.all(workers);
    return out;
  }

  // 实时行情（最新价、涨跌幅、昨收/今开/最高/最低）
  async function fetchQuotes(symbols) {
    if (!symbols.length) return {};
    const out = {};
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch('https://qt.gtimg.cn/q=' + symbols.join(','), { cache: 'no-store', signal: ctrl.signal });
      const buf = await res.arrayBuffer();
      let txt;
      try { txt = new TextDecoder('gbk').decode(buf); } catch (e) { txt = new TextDecoder().decode(buf); }
      for (const m of txt.matchAll(/v_([A-Za-z0-9_]+)="([^"]*)"/g)) {
        const f = m[2].split('~');
        out[m[1].toUpperCase()] = {
          name: f[1] || '',
          price: parseFloat(f[3]),
          prevClose: parseFloat(f[4]),
          open: parseFloat(f[5]),
          high: parseFloat(f[33]),
          low: parseFloat(f[34]),
          chgAmt: parseFloat(f[31]),
          pct: parseFloat(f[32]),
          time: f[30] || '',
          currency: f[35] || ''
        };
      }
    } catch (e) { /* 超时或失败时返回已有数据 */ }
    finally { clearTimeout(timer); }
    return out;
  }

  function pearson(xs, ys) {
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      dx += (xs[i] - mx) ** 2;
      dy += (ys[i] - my) ** 2;
    }
    return (dx === 0 || dy === 0) ? null : num / Math.sqrt(dx * dy);
  }

  async function estimateFunds() {
    const symbols = new Set();
    for (const b of state.bundles.values()) {
      if (b.holders) {
        for (const r of b.holders.rows.slice(0, 10)) {
          const s = symForStock(r);
          if (s) symbols.add(s);
        }
      }
    }
    const klines = {};
    if (symbols.size) {
      try { Object.assign(klines, await fetchKlines([...symbols], 90)); } catch (e) { /* ignore */ }
      const missing = [...symbols].filter(s => !klines[s.toUpperCase()] || !klines[s.toUpperCase()].length);
      if (missing.length) {
        try { Object.assign(klines, await fetchKlines(missing, 90)); } catch (e) { /* ignore */ }
      }
    }
    let maxDate = '';
    for (const pts of Object.values(klines)) {
      if (pts.length && pts[pts.length - 1].d > maxDate) maxDate = pts[pts.length - 1].d;
    }
    if (!maxDate) maxDate = fmtDate(new Date());
    // 实时行情：让预估在美股开盘后能实时跟随（日K线当日可能还未生成）
    let quotes = {};
    if (symbols.size) {
      try { quotes = await fetchQuotes([...symbols]); } catch (e) { /* ignore */ }
    }
    const today = fmtDate(new Date());
    for (const b of state.bundles.values()) {
      let sum = 0, wsum = 0, n = 0;
      let fMax = '';
      const proxyByDate = new Map();
      if (b.holders && b.navDate) {
        const navTs = new Date(b.navDate + 'T00:00:00').getTime();
        for (const r of b.holders.rows.slice(0, 10)) {
          const sym = symForStock(r);
          const pts = sym && klines[sym.toUpperCase()];
          if (!pts || !pts.length || r.weight == null) continue;
          if (pts[pts.length - 1].d > fMax) fMax = pts[pts.length - 1].d;
          let base = null;
          for (let i = pts.length - 1; i >= 0; i--) {
            if (new Date(pts[i].d + 'T00:00:00').getTime() <= navTs) { base = pts[i].close; break; }
          }
          let last = pts[pts.length - 1].close;
          const q = sym && quotes[sym.toUpperCase()];
          if (q && q.price != null && q.price > 0) {
            last = q.price;
            if (today > fMax) fMax = today;
          }
          if (base && last > 0) {
            const chg = (last / base - 1) * 100;
            if (isFinite(chg)) { sum += r.weight * chg; wsum += r.weight; n++; }
          }
          // 披露持仓的“模拟组合”每日收益（近三个月），用于判断经理是否已调仓
          const recent = pts;
          for (let i = 1; i < recent.length; i++) {
            const d = recent[i].d;
            const ret = (recent[i].close / recent[i - 1].close - 1) * 100;
            if (!isFinite(ret)) continue;
            if (!proxyByDate.has(d)) proxyByDate.set(d, { s: 0, w: 0 });
            const o = proxyByDate.get(d);
            o.s += r.weight * ret;
            o.w += r.weight;
          }
        }
      }

      // 基金近一个月每日收益（趋势信号）
      const fSeries = b.series || [];
      const fundRet = [];
      for (let i = Math.max(1, fSeries.length - 23); i < fSeries.length; i++) {
        const r = fSeries[i].nav / fSeries[i - 1].nav - 1;
        if (isFinite(r)) fundRet.push({ d: fSeries[i].d, r: r * 100 });
      }
      const momentum = fundRet.length >= 5 ? fundRet.reduce((a, x) => a + x.r, 0) / fundRet.length : null;

      // 全窗口对齐序列（基金 vs 持仓模拟组合，约 90 天）
      const alignD = [], alignX = [], alignY = [];
      if (proxyByDate.size >= 5) {
        const fundAll = [];
        for (let i = Math.max(1, fSeries.length - 92); i < fSeries.length; i++) {
          const r = fSeries[i].nav / fSeries[i - 1].nav - 1;
          if (isFinite(r)) fundAll.push({ d: fSeries[i].d, r: r * 100 });
        }
        for (const f of fundAll) {
          const o = proxyByDate.get(f.d);
          if (o && o.w > 0) { alignD.push(f.d); alignX.push(o.s / o.w); alignY.push(f.r); }
        }
      }
      // 最新拟合度：最近 22 个交易日窗口
      let corr = null;
      if (alignX.length >= 22) corr = pearson(alignX.slice(-22), alignY.slice(-22));
      else if (alignX.length >= 5) corr = pearson(alignX, alignY);
      // 滚动拟合度趋势：每 22 天窗口逐日滚动计算
      const fitTrend = [];
      if (alignX.length >= 22) {
        for (let i = 21; i < alignX.length; i++) {
          const c = pearson(alignX.slice(i - 21, i + 1), alignY.slice(i - 21, i + 1));
          if (c != null) fitTrend.push({ d: alignD[i], corr: c });
        }
      }
      // 近一个月对比序列
      const fitFund = [], fitProxy = [];
      const fitStart = Math.max(0, alignX.length - 23);
      for (let i = fitStart; i < alignX.length; i++) {
        fitFund.push({ d: alignD[i], r: alignY[i] });
        fitProxy.push({ d: alignD[i], r: alignX[i] });
      }
      const newFit = { corr, fund: fitFund, proxy: fitProxy, fitTrend };
      if (newFit.fund.length >= 3) {
        newFit.updatedAt = Date.now();
        b.fit = newFit;
      } else if (!b.fit || !b.fit.fund || b.fit.fund.length < 3) {
        // 本次未取到数据且之前也没有：写入空值
        b.fit = newFit;
      }
      // 否则保留上一次的拟合数据，避免偶发网络失败导致“刷不出来”

      if (n >= 2 && wsum > 0) {
        const holdEst = sum / wsum;
        if (corr != null && corr < 0.6) {
          // 近期走势明显偏离披露持仓 → 推测经理已调仓，加大近期趋势权重
          const w = Math.max(0.2, corr);
          const pct = w * holdEst + (1 - w) * (momentum != null ? momentum : holdEst);
          b.estimate = { pct: +pct.toFixed(2), n, time: fMax || maxDate, date: fMax || maxDate, updatedAt: Date.now(), basis: { method: 'blend', corr: +corr.toFixed(2) } };
        } else {
          // 持仓解释力较好 → 以持仓为主，叠加少量近期趋势
          const pct = 0.85 * holdEst + 0.15 * (momentum != null ? momentum : holdEst);
          b.estimate = { pct: +pct.toFixed(2), n, time: fMax || maxDate, date: fMax || maxDate, updatedAt: Date.now(), basis: { method: 'holdings', corr: corr != null ? +corr.toFixed(2) : null } };
        }
      } else if (momentum != null) {
        b.estimate = { pct: +momentum.toFixed(2), n: 0, time: maxDate, date: maxDate, fallback: true, updatedAt: Date.now(), basis: { method: 'momentum' } };
      }
    }
  }

  async function estimateFundsAndSave() {
    try {
      await estimateFunds();
      for (const b of state.bundles.values()) {
        if (b.estimate) LS.set('gfc:bundle:' + b.code, b);
      }
      renderAll();
    } catch (e) { /* ignore */ }
  }

  // 每 10 秒的轻量刷新：只更新行情预估与界面数字，不重建图表
  async function quickRefreshTick() {
    quickTicks++;
    updateIndices();
    if (state.refreshing || !state.bundles.size) return;
    refreshVisibleHoldQuotes();
    refreshEstimateUI();
    if (quickTicks % NAV_CHECK_EVERY === 0) checkNavUpdates();
  }

  function refreshEstimateUI() {
    updateEstimateUI();
    updateUpdateStatusUI();
  }

  // 就地更新看板上的预估数字与更新状态（避免重建图表造成闪烁）
  function updateEstimateUI() {
    const ldate = latestNavDate();
    if (state.boardRange === 'est') updateEstBoard();
    document.querySelectorAll('#boardList .fund-row[data-code]').forEach(row => {
      const b = state.bundles.get(row.dataset.code);
      if (!b) return;
      const mainBox = row.querySelector('.fund-main');
      if (!mainBox) return;
      let estEl = mainBox.querySelector('.est-line');
      const showEst = isShowEstimate(b);
      if (showEst) {
        const txt = `预估 <span class="${cls(b.estimate.pct)}">${fmtPct(b.estimate.pct)}</span>（${estTimeLabel(b)} · ${estBasisText(b)}，仅供参考）`;
        if (!estEl) {
          estEl = document.createElement('div');
          estEl.className = 'est-line';
          mainBox.appendChild(estEl);
        }
        estEl.innerHTML = txt;
      } else if (estEl) {
        estEl.remove();
      }
    });
  }

  // “今日预估涨幅”模式下，每 10 秒就地更新排行、数字与柱状图
  function leadSummary(best, worst, rets) {
    if (!rets.length) return '暂无数据';
    const upN = rets.filter(r => r > 0).length;
    const downN = rets.filter(r => r < 0).length;
    const n = rets.length;
    const bestTxt = best ? esc(shortName(best.b.name)) + ' ' + fmtPct(best.ret) : '--';
    const worstTxt = worst ? esc(shortName(worst.b.name)) + ' ' + fmtPct(worst.ret) : '--';
    if (upN === n) return '全线飘红，领涨：' + bestTxt;
    if (downN === n) return '全线飘绿，领跌：' + worstTxt;
    if (upN === 0 && downN === 0) return '全部持平';
    return `领涨：${bestTxt}<span style="margin:0 10px;color:var(--muted)">|</span>领跌：${worstTxt}`;
  }

  function updateEstBoard() {
    const list = [...state.bundles.values()]
      .filter(b => state.boardGroup === 'all' || (fundOf(b.code) || {}).group === state.boardGroup)
      .map(b => ({ b, ret: isShowEstimate(b) ? b.estimate.pct : null }))
      .filter(x => x.ret != null);
    list.sort((a, b2) => state.boardOrder === 'desc' ? b2.ret - a.ret : a.ret - b2.ret);
    const rets = list.map(x => x.ret);
    const upN = rets.filter(r => r > 0).length;
    const avg = rets.length ? rets.reduce((a, b2) => a + b2, 0) / rets.length : null;
    let best = null, worst = null;
    for (const x of list) {
      if (!best || x.ret > best.ret) best = x;
      if (!worst || x.ret < worst.ret) worst = x;
    }
    $('#boardSummary').innerHTML = `
      <div class="sum-card wide">
        <div class="k">今日预估涨幅排行速览</div>
        <div class="v">${leadSummary(best, worst, rets)}</div>
        <div class="s">平均 ${fmtPct(avg)} ｜ 上涨 ${upN} 只 / 下跌 ${rets.length - upN} 只（共 ${rets.length} 只），按持仓与近期走势综合估算${maxEstClock()}，仅供参考</div>
      </div>`;
    const listEl = $('#boardList');
    list.forEach((x, i) => {
      const row = listEl.querySelector(`.fund-row[data-code="${x.b.code}"]`);
      if (!row) return;
      const badge = row.querySelector('.rank-badge');
      if (badge) { badge.textContent = i + 1; badge.className = 'rank-badge ' + (i < 3 ? 'r' + (i + 1) : 'other'); }
      const big = row.querySelector('.fund-ret .big');
      if (big) { big.textContent = fmtPct(x.ret); big.className = 'big ' + cls(x.ret); }
      const small = row.querySelector('.fund-ret .small');
      if (small) small.textContent = estBasisText(x.b);
      listEl.appendChild(row);
    });
    if (charts.boardChart) {
      charts.boardChart.setOption({
        yAxis: { data: list.map(x => shortName(x.b.name)).reverse() },
        series: [{ data: list.map(x => ({ value: x.ret, itemStyle: { color: x.ret >= 0 ? '#f4574d' : '#22c55e', borderRadius: [0, 4, 4, 0] } })).reverse() }]
      });
    } else {
      renderBoard();
    }
  }

  // 轻量检查基金公司是否公布了更新的净值（约每 60 秒一次）
  // ================= 当日更新状态卡片 =================
  function updateGroups() {
    const ldate = latestNavDate();
    const all = [...state.bundles.values()]
      .filter(b => state.boardGroup === 'all' || (fundOf(b.code) || {}).group === state.boardGroup);
    return {
      ldate,
      updated: all.filter(b => isFundUpdated(b)),
      pending: all.filter(b => !isFundUpdated(b))
    };
  }

  function updateMainVal(b, isUpdated) {
    if (isUpdated) return b.dailyChange;
    return isShowEstimate(b) ? b.estimate.pct : null;
  }

  function fundStatusDetail(b, isUpdated) {
    const p = b.periods || {};
    const cells = [];
    if (isUpdated) {
      cells.push(['当日涨幅', fmtPct(b.dailyChange), cls(b.dailyChange)]);
      cells.push(['净值', b.nav != null ? b.nav.toFixed(4) : '--', 'flat']);
      cells.push(['同类排名', rankText(b, '1y'), 'flat']);
    } else {
      cells.push([estTimeLabel(b), fmtPct(b.estimate ? b.estimate.pct : null), cls(b.estimate ? b.estimate.pct : null)]);
      cells.push(['同类排名', rankText(b, '1y'), 'flat']);
      cells.push(['近1年同类均值', fmtPct(p['1y'] && p['1y'].avg), 'flat']);
    }
    for (const [k, label] of [['1w', '近1周'], ['1m', '近1月'], ['3m', '近3月'], ['6m', '近半年'], ['1y', '近1年']]) {
      const v = p[k] && p[k].ret;
      cells.push([label, fmtPct(v), cls(v)]);
    }
    return `<div class="detail-grid">${cells.map(c => `
      <div class="metric"><div class="k">${c[0]}</div><div class="v ${c[2]}">${c[1]}</div></div>`).join('')}</div>`;
  }

  function renderUpdateStatus() {
    const chipsBox = $('#updateGroupChips');
    const box = $('#updateStatusList');
    if (!chipsBox || !box) return;
    if (!state.bundles.size) { chipsBox.innerHTML = ''; box.innerHTML = ''; return; }
    const { ldate, updated, pending } = updateGroups();
    if (!state.updateGroupTouched) {
      if (state.updateGroup === 'updated' && !updated.length && pending.length) state.updateGroup = 'pending';
      else if (state.updateGroup === 'pending' && !pending.length && updated.length) state.updateGroup = 'updated';
    }
    chipsBox.innerHTML = `
      <button class="chip ${state.updateGroup === 'updated' ? 'active' : ''}" data-g="updated">已更新（${updated.length}）</button>
      <button class="chip ${state.updateGroup === 'pending' ? 'active' : ''}" data-g="pending">待更新（${pending.length}）</button>`;
    chipsBox.querySelectorAll('.chip').forEach(c => c.onclick = () => {
      state.updateGroup = c.dataset.g;
      state.updateGroupTouched = true;
      state.expandedCodes.clear();
      renderUpdateStatus();
    });
    const sortBox = $('#updateSortChips');
    if (sortBox) {
      sortBox.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.dataset.sort === state.updateSort));
      sortBox.querySelectorAll('.chip').forEach(c => c.onclick = () => {
        state.updateSort = c.dataset.sort;
        renderUpdateStatus();
      });
    }
    const list = (state.updateGroup === 'updated' ? updated : pending).slice();
    if (state.updateSort === 'name') {
      list.sort((a, b) => shortName(a.name).localeCompare(shortName(b.name), 'zh'));
    } else {
      list.sort((a, b) => {
        const va = updateMainVal(a, isFundUpdated(a));
        const vb = updateMainVal(b, isFundUpdated(b));
        return (vb == null ? -Infinity : vb) - (va == null ? -Infinity : va);
      });
    }
    if (!list.length) {
      box.innerHTML = '<div class="note">该分组暂无基金</div>';
      return;
    }
    box.innerHTML = list.map(b => {
      const isUpdated = isFundUpdated(b);
      const expanded = state.expandedCodes.has(b.code);
      const v = updateMainVal(b, isUpdated);
      return `<div class="st-item" data-code="${b.code}">
        <div class="fund-row st-head">
          <div class="fund-main">
            <div class="fund-name">${esc(shortName(b.name))}${fundOf(b.code) && fundOf(b.code).group ? `<span class="tag group-tag">${esc(fundOf(b.code).group)}</span>` : ''}</div>
            <div class="fund-meta"><span>${b.code}</span><span>净值 ${b.nav != null ? b.nav.toFixed(4) : '--'} (${b.navDate || ''})</span>
              <span class="st-badge ${isUpdated ? 'ok' : 'wait'}">${isUpdated ? '已更新' : '待更新'}</span></div>
          </div>
          <div class="fund-ret">
            <div class="big ${cls(v)}">${fmtPct(v)}</div>
            <div class="small">${isUpdated ? '当日涨幅' : estTimeLabel(b)}</div>
          </div>
          <div class="st-arrow">${expanded ? '▾' : '▸'}</div>
        </div>
        ${expanded ? `<div class="st-detail">${fundStatusDetail(b, isUpdated)}</div>` : ''}
      </div>`;
    }).join('');
    box.querySelectorAll('.st-item').forEach(item => item.onclick = () => {
      const code = item.dataset.code;
      if (state.expandedCodes.has(code)) state.expandedCodes.delete(code);
      else state.expandedCodes.add(code);
      renderUpdateStatus();
    });
  }

  // 每 10 秒就地更新：数量、主数值、展开详情（不重建列表，避免收起已展开的行）
  function updateUpdateStatusUI() {
    const chipsBox = $('#updateGroupChips');
    const box = $('#updateStatusList');
    if (!chipsBox || !box || !state.bundles.size) return;
    const { ldate, updated, pending } = updateGroups();
    const cs = chipsBox.querySelectorAll('.chip');
    if (cs.length >= 2) {
      cs[0].textContent = '已更新（' + updated.length + '）';
      cs[1].textContent = '待更新（' + pending.length + '）';
    }
    box.querySelectorAll('.st-item').forEach(item => {
      const b = state.bundles.get(item.dataset.code);
      if (!b) return;
      const isUpdated = isFundUpdated(b);
      const head = item.querySelector('.st-head');
      if (!head) return;
      const badge = head.querySelector('.st-badge');
      if (badge) { badge.textContent = isUpdated ? '已更新' : '待更新'; badge.className = 'st-badge ' + (isUpdated ? 'ok' : 'wait'); }
      const big = head.querySelector('.fund-ret .big');
      const v = updateMainVal(b, isUpdated);
      if (big) { big.textContent = fmtPct(v); big.className = 'big ' + cls(v); }
      const small = head.querySelector('.fund-ret .small');
      if (small) small.textContent = isUpdated ? '当日涨幅' : estTimeLabel(b);
      const detail = item.querySelector('.st-detail');
      if (detail) detail.innerHTML = fundStatusDetail(b, isUpdated);
    });
    // 按当前排序方式就地重排
    const items = [...box.querySelectorAll('.st-item')]
      .map(item => ({ item, b: state.bundles.get(item.dataset.code) }))
      .filter(x => x.b);
    items.sort((x, y) => {
      if (state.updateSort === 'name') return shortName(x.b.name).localeCompare(shortName(y.b.name), 'zh');
      const vx = updateMainVal(x.b, isFundUpdated(x.b));
      const vy = updateMainVal(y.b, isFundUpdated(y.b));
      return (vy == null ? -Infinity : vy) - (vx == null ? -Infinity : vx);
    });
    items.forEach(x => box.appendChild(x.item));
  }

  let navChecking = false;
  async function checkNavUpdates() {
    if (navChecking) return;
    navChecking = true;
    try {
      for (const f of state.funds) {
        const b = state.bundles.get(f.code);
        if (!b) continue;
        try {
          const j = await fetchJson(urlPeriod(f.code)).catch(() => null);
          const time = j && j.Expansion && j.Expansion.TIME;
          if (time && time > b.navDate) {
            const fresh = await fetchBundle(f.code);
            fresh.estimate = b.estimate || null;
            state.bundles.set(f.code, fresh);
            LS.set('gfc:bundle:' + f.code, fresh);
            toast(shortName(fresh.name) + ' 净值已更新至 ' + fresh.navDate);
            renderAll();
          }
        } catch (e) { /* 单只失败跳过 */ }
      }
    } finally {
      navChecking = false;
    }
  }

  function setStatus(msg) { $('#setStatus').textContent = msg || ''; }
  function setRefreshUI() {
    const rb = $('#refreshBtn');
    if (rb) { rb.classList.toggle('loading', state.refreshing); rb.disabled = state.refreshing; }
    const ba = $('#btnRefreshAll');
    if (ba) ba.disabled = state.refreshing;
  }

  // ================= 数据备份 / 恢复 =================
  function buildBackupText() {
    return JSON.stringify({
      v: 1,
      app: '基金分析器',
      exportedAt: new Date().toISOString(),
      theme: state.themePref,
      funds: state.funds
    }, null, 2);
  }

  function closeBackup() {
    $('#backup').classList.remove('show');
  }

  function openBackup() {
    $('#backupTitle').textContent = '导出数据备份';
    $('#backupHint').innerHTML = '把下面的备份内容<b>复制保存</b>（或下载成文件）。重装 App 后到“我的 → 数据备份与恢复 → 恢复备份”粘贴即可找回基金、分组和主题。';
    $('#backupText').value = buildBackupText();
    $('#backupText').readOnly = true;
    $('#backupActions').style.display = '';
    $('#restoreActions').style.display = 'none';
    $('#backupStatus').textContent = '';
    $('#backup').classList.add('show');
  }

  function openRestore() {
    $('#backupTitle').textContent = '恢复备份';
    $('#backupHint').innerHTML = '粘贴之前导出的备份内容，点“恢复备份”。当前基金清单会被备份里的内容替换，恢复后自动重新拉取数据。';
    $('#backupText').value = '';
    $('#backupText').readOnly = false;
    $('#backupActions').style.display = 'none';
    $('#restoreActions').style.display = '';
    $('#backupStatus').textContent = '';
    $('#backup').classList.add('show');
  }

  function copyBackupText() {
    const t = $('#backupText').value;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(
        () => { $('#backupStatus').textContent = '已复制，请粘贴保存到备忘录 / 文件'; },
        () => legacyCopy(t)
      );
    } else {
      legacyCopy(t);
    }
  }

  function legacyCopy(t) {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    $('#backupStatus').textContent = ok ? '已复制，请粘贴保存到备忘录 / 文件' : '复制失败，请长按文本框手动复制';
  }

  function downloadBackup() {
    const blob = new Blob([$('#backupText').value], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '基金分析器备份-' + fmtDate(new Date()) + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 800);
    $('#backupStatus').textContent = '已生成备份文件（手机未自动下载时，请改用“复制备份”保存）';
  }

  function restoreBackup() {
    try {
      const obj = JSON.parse($('#backupText').value);
      const funds = Array.isArray(obj.funds) ? obj.funds.filter(f => f && f.code && f.name) : [];
      if (!funds.length) throw new Error('备份内容里没有基金清单');
      state.funds = funds;
      saveFunds();
      if (obj.theme && ['auto', 'dark', 'light'].includes(obj.theme)) applyTheme(obj.theme, true);
      state.bundles.clear();
      closeBackup();
      toast('已恢复 ' + funds.length + ' 只基金，正在刷新数据…');
      refreshAll(true);
    } catch (e) {
      $('#backupStatus').textContent = '恢复失败：' + (e && e.message ? e.message : '内容格式不正确');
    }
  }

  // ================= 全球主要指数 =================
  let indexData = [];
  function indexUrl() {
    const list = window.DEFAULT_INDICES || [];
    return 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=' +
      list.map(i => i.secid).join(',') + '&fields=f1,f2,f3,f4,f12,f13,f14';
  }

  async function fetchIndices() {
    const list = window.DEFAULT_INDICES || [];
    if (!list.length) return [];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(indexUrl(), { cache: 'no-store', signal: ctrl.signal });
      const j = await res.json();
      const diff = (j && j.data && j.data.diff) || [];
      const bySec = {};
      for (const d of diff) bySec[d.f13 + '.' + d.f12] = { price: d.f2, pct: d.f3 };
      return list.map(cfg => {
        const v = bySec[cfg.secid];
        return { name: cfg.name, secid: cfg.secid, price: v ? v.price : null, pct: v ? v.pct : null };
      });
    } catch (e) { return indexData; }
    finally { clearTimeout(timer); }
  }

  async function updateIndices() {
    const data = await fetchIndices();
    if (data.length) indexData = data;
    const strip = $('#indexStrip');
    if (!strip) return;
    const list = indexData.length ? indexData : (window.DEFAULT_INDICES || []);
    strip.innerHTML = list.map(it => `
      <div class="idx-card">
        <div class="idx-name">${esc(it.name)}</div>
        <div class="idx-price ${it.price == null ? 'flat' : ''}">${it.price != null ? it.price.toFixed(2) : '--'}</div>
        <div class="idx-pct ${cls(it.pct)}">${fmtPct(it.pct)}</div>
      </div>`).join('');
  }

  // ================= 渲染：看板 =================
  const BOARD_PERIODS = [
    { key: '1w', label: '近1周' }, { key: '1m', label: '近1月' }, { key: '3m', label: '近3月' },
    { key: '6m', label: '近半年' }, { key: '1y', label: '近1年' }, { key: 'ytd', label: '今年来' }
  ];

  function latestNavDate() {
    return [...state.bundles.values()].reduce((m, b) => !m || (b.navDate > m) ? b.navDate : m, null);
  }

  function renderBoard() {
    const groups = ['全部', ...state.funds.map(f => f.group).filter((g, i, a) => g && a.indexOf(g) === i)];
    if (state.boardGroup !== 'all' && !groups.includes(state.boardGroup)) state.boardGroup = 'all';
    $('#boardGroupChips').innerHTML = groups.map(g =>
      `<button class="chip ${(g === '全部' && state.boardGroup === 'all') || g === state.boardGroup ? 'active' : ''}" data-group="${g}">${g}</button>`).join('');
    $('#boardGroupChips').querySelectorAll('.chip').forEach(c => c.onclick = () => {
      state.boardGroup = c.dataset.group === '全部' ? 'all' : c.dataset.group;
      renderAll();
    });

    $('#boardPeriodChips').innerHTML = BOARD_PERIODS.map(p =>
      `<button class="chip ${p.key === state.boardRange ? 'active' : ''}" data-key="${p.key}">${p.label}</button>`).join('');
    $('#boardPeriodChips').querySelectorAll('.chip').forEach(c => c.onclick = () => {
      state.boardRange = c.dataset.key;
      renderBoard();
    });

    const noFunds = !state.funds.length || !state.bundles.size;
    $('#boardEmpty').hidden = !noFunds;
    $('#boardEmpty').style.display = noFunds ? '' : 'none';
    document.querySelectorAll('#panel-board .card').forEach(c => {
      if (c.id !== 'indexCard') c.style.display = noFunds ? 'none' : '';
    });
    $('#boardSummary').style.display = noFunds ? 'none' : '';
    if (noFunds) {
      $('#boardChart').innerHTML = '';
      $('#boardList').innerHTML = '';
      return;
    }

    const key = state.boardRange;
    const estMode = key === 'est';
    const list = [...state.bundles.values()]
      .filter(b => state.boardGroup === 'all' || (fundOf(b.code) || {}).group === state.boardGroup)
      .map(b => ({ b, ret: estMode ? (isShowEstimate(b) ? b.estimate.pct : null) : (b.periods[key] || {}).ret }))
      .filter(x => x.ret != null);
    list.sort((a, b2) => state.boardOrder === 'desc' ? b2.ret - a.ret : a.ret - b2.ret);

    // 摘要
    const rets = list.map(x => x.ret);
    const upN = rets.filter(r => r > 0).length;
    const avg = rets.length ? rets.reduce((a, b2) => a + b2, 0) / rets.length : null;
    let best = null, worst = null;
    for (const x of list) {
      if (!best || x.ret > best.ret) best = x;
      if (!worst || x.ret < worst.ret) worst = x;
    }
    const plabel = estMode ? '今日预估涨幅' : BOARD_PERIODS.find(p => p.key === key).label;
    $('#boardSummary').innerHTML = `
      <div class="sum-card wide">
        <div class="k">${plabel}排行速览</div>
        <div class="v">${leadSummary(best, worst, rets)}</div>
        <div class="s">平均 ${fmtPct(avg)} ｜ 上涨 ${upN} 只 / 下跌 ${rets.length - upN} 只（共 ${rets.length} 只）${estMode ? '，按持仓与近期走势综合估算' + maxEstClock() + '，仅供参考' : ''}</div>
      </div>`;

    drawBarChart('boardChart', list.map(x => shortName(x.b.name)), list.map(x => x.ret));

    $('#boardOrderHint').textContent = state.boardOrder === 'desc' ? '↓ 降序（点击切换）' : '↑ 升序（点击切换）';
    let estDateTxt = '';
    if (estMode) {
      const d = [...state.bundles.values()].reduce((m, b) => (b.estimate && b.estimate.date > m ? b.estimate.date : m), '');
      if (d) estDateTxt = '（截至 ' + d + ' · 每1分钟更新）';
    }
    $('#boardChartTitle').textContent = estMode ? '今日预估涨幅排序' : '区间涨幅排行';
    $('#boardHint').textContent = (estMode ? '按今日预估涨幅排序' + estDateTxt + '（仅供参考）' : '按' + plabel + '涨幅排序') + '，点击基金查看详情';
    $('#boardList').innerHTML = list.map((x, i) => {
      const b = x.b;
      const p = b.periods[key] || {};
      const spark = sparkline((estMode ? b.series.slice(-20) : boardSeries(b, key)).map(s => s.nav));
      const rankTxt = estMode ? '' : rankText(b, key);
      const diffTxt = estMode ? '' : (p.diff != null ? ` 较上期${p.diff > 0 ? '+' : ''}${p.diff}` : '');
      const badge = i < 3 ? `r${i + 1}` : 'other';
      const updated = isFundUpdated(b);
      const showEst = !estMode && isShowEstimate(b);
      const est = showEst ? `<div class="est-line">预估 <span class="${cls(b.estimate.pct)}">${fmtPct(b.estimate.pct)}</span>（${estTimeLabel(b)} · ${estBasisText(b)}，仅供参考）</div>` : '';
      return `<div class="fund-row" data-code="${b.code}">
        <div class="rank-badge ${badge}">${i + 1}</div>
        <div class="fund-main">
          <div class="fund-name"><span class="fn-txt">${esc(shortName(b.name))}</span>${fundOf(b.code) && fundOf(b.code).group ? `<span class="tag group-tag">${esc(fundOf(b.code).group)}</span>` : ''}</div>
          <div class="fund-meta">
            <span>${b.code}</span><span>净值 ${b.nav != null ? b.nav.toFixed(4) : '--'} (${b.navDate || ''})</span>
            <span class="st-badge ${updated ? 'ok' : 'wait'}">${updated ? '已更新' : '待更新'}</span>
          </div>
          ${rankTxt ? `<div class="fund-meta">${rankTxt}${diffTxt}</div>` : ''}
          ${est}
        </div>
        <div class="fund-ret">
          <div class="big ${cls(x.ret)}">${fmtPct(x.ret)}</div>
          <div class="small">${estMode ? estTimeLabel(b) + ' · ' + estBasisText(b) : (p.avg != null ? '同类均值 ' + fmtPct(p.avg) : '')}</div>
          ${spark}
        </div>
      </div>`;
    }).join('');
    bindFundRows($('#boardList'));
    $('#boardOrderHint').onclick = () => {
      state.boardOrder = state.boardOrder === 'desc' ? 'asc' : 'desc';
      renderBoard();
    };
  }

  function rankText(b, key) {
    const p = b.periods[key] || {};
    if (p.rank != null && p.total != null) return `同类 ${p.rank}/${p.total}`;
    if (b.rankDaily && b.rankDaily.percentile != null) return `同类前 ${b.rankDaily.percentile.toFixed(1)}%（${b.rankDaily.date}）`;
    if (b.rankDaily && b.rankDaily.rank != null) return `同类 ${b.rankDaily.rank}/${b.rankDaily.total}`;
    return '';
  }

  function sparkline(data, w = 72, h = 22) {
    if (!data || data.length < 2) return '';
    const min = Math.min(...data), max = Math.max(...data);
    const span = (max - min) || 1;
    const pts = data.map((v, i) =>
      ((i / (data.length - 1)) * w).toFixed(1) + ',' + (h - 1 - ((v - min) / span) * (h - 2)).toFixed(1)).join(' ');
    const up = data[data.length - 1] >= data[0];
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <polyline points="${pts}" fill="none" stroke="${up ? '#f4574d' : '#22c55e'}" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
  }

  function drawBarChart(id, names, values) {
    const el = $('#' + id);
    disposeChart(id);
    if (!values.length) { el.innerHTML = '<div class="note">暂无数据</div>'; return; }
    const inst = echarts.init(el);
    charts[id] = inst;
    const color = v => v >= 0 ? '#f4574d' : '#22c55e';
    inst.setOption({
      grid: { left: 8, right: 54, top: 12, bottom: 8, containLabel: true },
      tooltip: { confine: true, hideDelay: 50, trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: p => `${p[0].name}<br/>${fmtPct(p[0].value)}` },
      xAxis: { type: 'value', axisLabel: { formatter: v => v + '%', color: T().muted }, splitLine: { lineStyle: { color: T().lineSoft } } },
      yAxis: { type: 'category', data: names.slice().reverse(), axisLabel: { color: T().text, fontSize: 11 } },
      series: [{
        type: 'bar', data: values.slice().reverse().map(v => ({ value: v, itemStyle: { color: color(v), borderRadius: [0, 4, 4, 0] } })),
        barMaxWidth: 16,
        label: { show: true, position: 'right', formatter: p => fmtPct(p.value), color: T().text, fontSize: 10 }
      }]
    });
  }

  // ================= 渲染：趋势 =================
  const TREND_RANGES = [
    { key: '1m', label: '近1月', days: 30 }, { key: '3m', label: '近3月', days: 91 },
    { key: '6m', label: '近半年', days: 182 }, { key: '1y', label: '近1年', days: 365 },
    { key: '2y', label: '近2年', days: 730 }, { key: 'all', label: '成立以来', days: null }
  ];
  function SERIES_COLORS() {
    return [T().accent, '#f472b6', '#fbbf24', '#34d399', '#a78bfa', '#fb7185', '#22d3ee', '#f97316', '#4ade80', '#e879f9'];
  }

  function renderTrend() {
    $('#trendRangeChips').innerHTML = TREND_RANGES.map(r =>
      `<button class="chip ${r.key === state.trendRange ? 'active' : ''}" data-key="${r.key}">${r.label}</button>`).join('');
    $('#trendRangeChips').querySelectorAll('.chip').forEach(c => c.onclick = () => {
      state.trendRange = c.dataset.key;
      renderTrend();
    });

    // 分组过滤
    const groups = ['全部', ...state.funds.map(f => f.group).filter((g, i, a) => g && a.indexOf(g) === i)];
    if (state.trendGroup !== 'all' && !groups.includes(state.trendGroup)) state.trendGroup = 'all';
    $('#trendGroupChips').innerHTML = groups.map(g =>
      `<button class="chip ${(g === '全部' && state.trendGroup === 'all') || g === state.trendGroup ? 'active' : ''}" data-group="${g}">${g}</button>`).join('');
    $('#trendGroupChips').querySelectorAll('.chip').forEach(c => c.onclick = () => {
      state.trendGroup = c.dataset.group === '全部' ? 'all' : c.dataset.group;
      if (state.trendGroup !== 'all') {
        state.trendSel = state.funds.filter(f => f.group === state.trendGroup).map(f => f.code);
      }
      renderTrend();
    });

    const funds = [...state.bundles.values()]
      .filter(b => state.trendGroup === 'all' || (fundOf(b.code) || {}).group === state.trendGroup);
    if (!state.trendSel.length && funds.length) state.trendSel = funds.slice(0, Math.min(3, funds.length)).map(f => f.code);
    $('#trendFundChips').innerHTML = funds.map(f => {
      const idx = state.trendSel.indexOf(f.code);
      const dot = idx >= 0 ? `<span class="c-dot" style="background:${SERIES_COLORS()[idx % SERIES_COLORS().length]}"></span>` : '';
      return `<button class="chip ${idx >= 0 ? 'sel' : ''}" data-code="${f.code}">${dot}${esc(shortName(f.name))}</button>`;
    }).join('');
    $('#trendFundChips').querySelectorAll('.chip').forEach(c => c.onclick = () => {
      const code = c.dataset.code;
      if (state.trendSel.includes(code)) state.trendSel = state.trendSel.filter(x => x !== code);
      else state.trendSel.push(code);
      renderTrend();
    });
    let rangeTxt = '';
    const first = state.trendSel.map(c => state.bundles.get(c)).filter(Boolean)[0];
    if (first) {
      const s = rangeSeries(first, state.trendRange);
      if (s.length) rangeTxt = `当前区间：${s[0].d} ~ ${s[s.length - 1].d}。`;
    }
    $('#trendNote').textContent = '怎么看：横坐标 = 日期（形如 8/06，每年 1 月会标出年份），纵坐标 = 累计涨幅（%）。每只基金以所选区间首日净值为 0%，之后逐日累计，方便对比同一段时间谁涨得多。' + rangeTxt + '可拖动下方时间轴缩放区间，或点上方按钮快速切换；横坐标两端始终显示区间首日和最新日期。QDII 基金净值按 T+2 披露，所以曲线画到基金最新披露净值那天为止。可勾选 / 取消上方的基金来增减对比对象。';
    drawTrendChart();
    drawCorr();
    drawFit();
  }

  function drawFit() {
    const listEl = $('#fitList');
    const chartEl = $('#fitChart');
    const noteEl = $('#fitNote');
    if (!listEl || !chartEl) return;
    try {
      const selCodes = state.trendSel.length ? state.trendSel : [...state.bundles.keys()];
      const sel = selCodes.map(c => state.bundles.get(c)).filter(Boolean);
      if (!sel.length) {
        listEl.innerHTML = '<div class="note">暂无基金数据</div>';
        chartEl.innerHTML = '';
        noteEl.textContent = '';
        return;
      }
      const rows = sel.map(b => {
        const f = b.fit;
        const corr = f && f.corr != null ? f.corr : null;
        const pct = corr != null ? Math.round(corr * 100) : null;
        let status = f ? '暂无持仓数据' : '计算中…';
        let stCls = f ? 'flat' : 'warn';
        if (corr != null) {
          if (corr >= 0.6) { status = '拟合良好'; stCls = 'ok'; }
          else if (corr >= 0.4) { status = '部分偏离'; stCls = 'warn'; }
          else { status = '疑似调仓'; stCls = 'up'; }
        }
        return { b, pct, status, stCls, hasData: !!(f && f.fund && f.fund.length >= 3) };
      });
      listEl.innerHTML = rows.map(r => `
        <div class="fit-row ${r.b.code === state.fitFund ? 'active' : ''}" data-code="${r.b.code}">
          <div class="fit-name">${esc(shortName(r.b.name))}</div>
          <div class="fit-val">${r.pct != null ? '拟合 ' + r.pct + '%' : '--'}</div>
          <div class="fit-status ${r.stCls}">${r.status}</div>
        </div>`).join('');
      listEl.querySelectorAll('.fit-row').forEach(row => row.onclick = () => {
        state.fitFund = row.dataset.code;
        drawFit();
      });
      if (!state.fitFund || !sel.some(b => b.code === state.fitFund)) {
        const first = rows.find(r => r.hasData) || rows[0];
        state.fitFund = first ? first.b.code : null;
      }
      const cur = state.fitFund ? state.bundles.get(state.fitFund) : null;
      const f = cur && cur.fit;
      if (f && f.fund && f.fund.length >= 3) {
        drawFitChart(f);
        drawFitTrend(f);
        noteEl.textContent = '曲线为基金与按上季前十大持仓权重模拟的“持仓组合”近一月累计收益对比。拟合度越高，说明基金仍在按披露持仓操作；越低则可能已调仓。';
      } else {
        chartEl.innerHTML = '<div class="note">暂无拟合数据（需要持仓与行情）</div>';
        const trendEl = $('#fitTrendChart');
        if (trendEl) { disposeChart('fitTrendChart'); trendEl.innerHTML = '<div class="note">暂无拟合度走势（需要持仓与行情）</div>'; }
        noteEl.textContent = '拟合度需要“基金每日净值收益 + 上季披露持仓 + 个股每日行情”才能计算。数据每 1 分钟自动重试，稍后会自动补上；若持续为空，请下拉刷新一次。';
      }
    } catch (e) { /* 拟合度异常不影响趋势页其他内容 */ }
  }

  function drawFitChart(f) {
    const el = $('#fitChart');
    disposeChart('fitChart');
    const dates = f.fund.map(p => p.d);
    const cum = arr => {
      let c = 1;
      return arr.map(p => { c *= (1 + p.r / 100); return +(c * 100 - 100).toFixed(2); });
    };
    const inst = echarts.init(el);
    charts.fitChart = inst;
    inst.setOption({
      color: [T().accent, '#fbbf24'],
      grid: { left: 8, right: 16, top: 30, bottom: 8, containLabel: true },
      tooltip: { confine: true, hideDelay: 50, trigger: 'axis', valueFormatter: v => fmtPct(v) },
      legend: { top: 0, textStyle: { color: T().muted, fontSize: 10 }, data: ['基金', '持仓模拟组合'] },
      xAxis: { type: 'category', data: dates, axisLabel: { color: T().muted, fontSize: 9, formatter: v => v.slice(5) } },
      yAxis: { type: 'value', axisLabel: { formatter: v => v + '%', color: T().muted }, splitLine: { lineStyle: { color: T().lineSoft } } },
      series: [
        { name: '基金', type: 'line', showSymbol: false, lineStyle: { width: 2 }, data: cum(f.fund) },
        { name: '持仓模拟组合', type: 'line', showSymbol: false, lineStyle: { type: 'dashed', width: 1.5 }, data: cum(f.proxy) }
      ]
    });
  }

  function drawFitTrend(f) {
    const el = $('#fitTrendChart');
    disposeChart('fitTrendChart');
    if (!f || !f.fitTrend || f.fitTrend.length < 5) {
      el.innerHTML = '<div class="note">暂无拟合度走势（需积累约一个月交易日数据）</div>';
      return;
    }
    const inst = echarts.init(el);
    charts.fitTrendChart = inst;
    const data = f.fitTrend;
    inst.setOption({
      grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
      tooltip: { confine: true, hideDelay: 50, trigger: 'axis', formatter: p => `${p[0].axisValue}<br/>拟合度 ${(p[0].value).toFixed(0)}%` },
      xAxis: { type: 'category', data: data.map(x => x.d), axisLabel: { color: T().muted, fontSize: 9, formatter: v => v.slice(5) } },
      yAxis: {
        type: 'value', min: 0, max: 100,
        axisLabel: { formatter: v => v + '%', color: T().muted },
        splitLine: { lineStyle: { color: T().lineSoft } }
      },
      series: [{
        type: 'line', showSymbol: false, smooth: true, lineStyle: { color: T().accent, width: 2 },
        areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(56,189,248,.25)' }, { offset: 1, color: 'rgba(56,189,248,0)' }] } },
        data: data.map(x => +(x.corr * 100).toFixed(1)),
        markLine: {
          symbol: 'none',
          label: { fontSize: 9, color: T().muted, formatter: p => (p.value === 60 ? '拟合良好 60%' : '疑似调仓 40%') },
          data: [
            { yAxis: 60, lineStyle: { color: '#34d399', type: 'dashed' } },
            { yAxis: 40, lineStyle: { color: '#f4574d', type: 'dashed' } }
          ]
        }
      }]
    });
  }

  function rangeSeries(b, key) {
    const r = TREND_RANGES.find(x => x.key === key);
    return sliceByDays(b.series, r ? r.days : null);
  }

  function sliceByDays(series, days) {
    if (!days) return series;
    const target = new Date(series[series.length - 1].d);
    target.setDate(target.getDate() - days);
    const ts = target.getTime();
    return series.filter(s => new Date(s.d + 'T00:00:00').getTime() >= ts);
  }

  // 看板迷你走势：跟随所选区间（近1周/1月/3月/半年/1年/今年来）
  function boardSeries(b, key) {
    if (key === 'ytd') return b.series.filter(s => s.d.slice(0, 4) === b.series[b.series.length - 1].d.slice(0, 4));
    return sliceByDays(b.series, { '1w': 7, '1m': 30, '3m': 91, '6m': 182, '1y': 365 }[key] || 90);
  }

  function drawTrendChart() {
    const el = $('#trendChart');
    disposeChart('trendChart');
    const sel = state.trendSel.map(c => state.bundles.get(c)).filter(Boolean);
    if (!sel.length) { el.innerHTML = '<div class="note">请选择至少一只基金</div>'; return; }
    const inst = echarts.init(el);
    charts.trendChart = inst;
    const items = sel.map(b => {
      const s = rangeSeries(b, state.trendRange);
      const base = s[0].nav;
      const byDate = new Map();
      for (const p of s) byDate.set(p.d, +(p.nav / base * 100 - 100).toFixed(2));
      return { b, byDate };
    });
    const dates = [...new Set(items.flatMap(it => [...it.byDate.keys()]))].sort();
    inst.setOption({
      color: SERIES_COLORS(),
      grid: { left: 8, right: 16, top: 16, bottom: 46, containLabel: true },
      tooltip: {
        confine: true,
        hideDelay: 50,
        trigger: 'axis',
        formatter: p => {
          const date = p[0].axisValue;
          let html = date + '<br/>';
          for (const s of p) html += `${s.marker}${s.seriesName}：累计 ${fmtPct(s.value)}<br/>`;
          return html;
        }
      },
      legend: { show: false },
      xAxis: {
        type: 'category', data: dates, name: '日期', nameLocation: 'end', nameGap: 14, nameTextStyle: { color: T().muted, fontSize: 10 },
        axisLabel: { color: T().muted, fontSize: 10, hideOverlap: false, showMinLabel: true, showMaxLabel: true, formatter: v => {
          const p = v.split('-');
          return (p[1] === '01' ? p[0] + '/' : '') + p[1] + '/' + p[2];
        } },
        axisLine: { lineStyle: { color: T().line } }
      },
      yAxis: {
        type: 'value', name: '累计涨幅%', nameTextStyle: { color: T().muted, fontSize: 10 },
        axisLabel: { formatter: v => v + '%', color: T().muted },
        splitLine: { lineStyle: { color: T().lineSoft } }
      },
      dataZoom: [
        { type: 'inside' },
        {
          type: 'slider', height: 24, bottom: 4, borderColor: T().line, realtime: true,
          handleStyle: { color: T().accent, borderColor: T().accent },
          moveHandleStyle: { color: T().accent },
          emphasis: { handleStyle: { color: '#7dd3fc', borderColor: '#7dd3fc' } },
          textStyle: { color: T().muted, fontSize: 10 }
        }
      ],
      series: items.map(it => ({
        name: shortName(it.b.name) + (it.b.navDate ? ' 截至' + it.b.navDate.slice(5) : ''),
        type: 'line',
        showSymbol: false,
        connectNulls: true,
        lineStyle: { width: 1.8 },
        data: dates.map(d => it.byDate.has(d) ? it.byDate.get(d) : null)
      }))
    });
  }

  function drawCorr() {
    const el = $('#corrChart');
    disposeChart('corrChart');
    let funds = state.trendSel.map(c => state.bundles.get(c)).filter(Boolean);
    const capped = funds.length > 12;
    if (funds.length < 2) funds = [...state.bundles.values()].slice(0, 12);
    if (funds.length < 2) {
      el.innerHTML = '<div class="note">至少需要 2 只基金</div>';
      $('#corrNote').textContent = '';
      $('#corrHelp').textContent = '';
      return;
    }
    const inst = echarts.init(el);
    charts.corrChart = inst;
    const names = funds.map(f => shortName(f.name));
    const data = [];
    for (let i = 0; i < funds.length; i++) {
      for (let j = 0; j < funds.length; j++) {
        if (i === j) { data.push([i, j, 1]); continue; }
        const c = corr(funds[i].series, funds[j].series);
        data.push([i, j, c == null ? null : +c.toFixed(2)]);
      }
    }
    inst.setOption({
      grid: { left: 86, right: 14, top: 8, bottom: 58 },
      tooltip: { confine: true, hideDelay: 50, formatter: p => `${names[p.value[0]]} × ${names[p.value[1]]}<br/>相关系数 ${p.value[2] == null ? '--' : p.value[2]}` },
      xAxis: { type: 'category', data: names, axisLabel: { color: T().muted, fontSize: 9, interval: 0, rotate: 38 } },
      yAxis: { type: 'category', data: names, axisLabel: { color: T().muted, fontSize: 9 } },
      visualMap: {
        min: -1, max: 1, calculable: false, orient: 'horizontal', left: 'center', bottom: 4,
        inRange: { color: ['#22c55e', '#1e293b', '#f4574d'] },
        textStyle: { color: T().muted }
      },
      series: [{
        type: 'heatmap', data,
        label: { show: true, fontSize: 9, color: T().text, formatter: p => p.value[2] == null ? '--' : p.value[2] }
      }]
    });
    $('#corrNote').textContent = '颜色越红 = 两只基金走势越同步（同涨同跌）；颜色越绿 = 走势越背离。格子数字是相关系数：1 = 完全同步，0 = 没关联，-1 = 完全相反。';
    $('#corrHelp').textContent = (capped ? '基金较多，只对比前 12 只以便看清；' : '') + '计算基于近半年每日涨幅对齐。想对比谁，就在上方"区间累计涨幅"里只勾选那几只。';
  }

  function corr(a, b) {
    const mapB = new Map(b.map(p => [p.d, p.nav]));
    const xs = [], ys = [];
    for (let i = 1; i < a.length; i++) {
      const nb = mapB.get(a[i].d);
      const pb = mapB.get(a[i - 1].d);
      if (nb == null || pb == null) continue;
      const rA = a[i].nav / a[i - 1].nav - 1;
      const rB = nb / pb - 1;
      if (isFinite(rA) && isFinite(rB)) { xs.push(rA); ys.push(rB); }
    }
    if (xs.length < 10) return null;
    const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
    const my = ys.reduce((s, v) => s + v, 0) / ys.length;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      dx += (xs[i] - mx) ** 2;
      dy += (ys[i] - my) ** 2;
    }
    return (dx === 0 || dy === 0) ? null : num / Math.sqrt(dx * dy);
  }

  // ================= 渲染：持仓 =================
  async function loadHoldQuotes(b) {
    if (!b || !b.holders) return;
    if (b.stockQuoteTime && Date.now() - b.stockQuoteTime < 10000) { applyHoldQuotes(b); return; }
    const syms = [];
    for (const r of b.holders.rows.slice(0, 10)) {
      const s = symForStock(r);
      if (s) syms.push(s);
    }
    if (!syms.length) return;
    const q = await fetchQuotes(syms).catch(() => ({}));
    b.stockQuotes = q;
    b.stockQuoteTime = Date.now();
    applyHoldQuotes(b);
  }

  function applyHoldQuotes(b) {
    if (!b || !b.holders) return;
    const q = b.stockQuotes || {};
    document.querySelectorAll('[data-stk]').forEach(row => {
      const inHold = row.closest('#holdContent');
      const inDetail = row.closest('#detailHold');
      if (inHold && b.code !== state.holdFund) return;
      if (inDetail && b.code !== state.detailCode) return;
      const stk = b.holders.rows.find(x => x.code === row.dataset.stk);
      if (!stk) return;
      const sym = symForStock(stk);
      const info = sym && q[sym.toUpperCase()];
      const cell = row.querySelector('.stk-quote');
      if (!cell) return;
      if (info && info.price != null && !isNaN(info.price) && info.pct != null && !isNaN(info.pct)) {
        cell.innerHTML = `<div class="${cls(info.pct)}" style="font-weight:700">${fmtPct(info.pct)}</div><div class="stock-code">${info.price.toFixed(2)}</div>`;
      } else {
        cell.innerHTML = '<div class="flat">--</div>';
      }
    });
  }

  function refreshVisibleHoldQuotes() {
    const codes = new Set();
    if (state.holdFund) codes.add(state.holdFund);
    if (state.detailCode && state.detailTab === 'hold') codes.add(state.detailCode);
    for (const code of codes) {
      const b = state.bundles.get(code);
      if (b && b.holders && (!b.stockQuoteTime || Date.now() - b.stockQuoteTime > 10000)) loadHoldQuotes(b);
    }
  }

  function renderHoldings() {
    // 分组过滤
    const groups = ['全部', ...state.funds.map(f => f.group).filter((g, i, a) => g && a.indexOf(g) === i)];
    if (state.holdGroup !== 'all' && !groups.includes(state.holdGroup)) state.holdGroup = 'all';
    $('#holdGroupChips').innerHTML = groups.map(g =>
      `<button class="chip ${(g === '全部' && state.holdGroup === 'all') || g === state.holdGroup ? 'active' : ''}" data-group="${g}">${g}</button>`).join('');
    $('#holdGroupChips').querySelectorAll('.chip').forEach(c => c.onclick = () => {
      state.holdGroup = c.dataset.group === '全部' ? 'all' : c.dataset.group;
      renderHoldings();
    });

    const funds = [...state.bundles.values()]
      .filter(b => state.holdGroup === 'all' || (fundOf(b.code) || {}).group === state.holdGroup);
    if (!state.holdFund || !funds.some(f => f.code === state.holdFund)) state.holdFund = funds[0] ? funds[0].code : null;
    $('#holdFundChips').innerHTML = funds.map(f =>
      `<button class="chip ${f.code === state.holdFund ? 'active' : ''}" data-code="${f.code}">${esc(shortName(f.name))}</button>`).join('');
    $('#holdFundChips').querySelectorAll('.chip').forEach(c => c.onclick = () => {
      state.holdFund = c.dataset.code;
      renderHoldings();
    });
    const b = state.holdFund ? state.bundles.get(state.holdFund) : null;
    const box = $('#holdContent');
    if (!b) { box.innerHTML = '<div class="card"><div class="note">暂无数据</div></div>'; return; }
    if (!b.holders) {
      box.innerHTML = '<div class="card"><div class="note">' +
        (b.holdingsApiOk === false
          ? '持仓数据暂时获取失败（该接口对部分浏览器有限制）。请用手机打开本页，净值、业绩和经理数据不受影响。'
          : '该基金暂无持仓披露（可能为次新基金）') +
        '</div></div>';
      return;
    }
    const c = b.compare || {};
    const rows = b.holders.rows;
    const top10 = rows.slice(0, 10);

    const marketMap = {};
    const indMap = {};
    for (const r of top10) {
      const mk = r.market || '其他';
      marketMap[mk] = (marketMap[mk] || 0) + (r.weight || 0);
      if (r.industry) indMap[r.industry] = (indMap[r.industry] || 0) + (r.weight || 0);
      else indMap['其他'] = (indMap['其他'] || 0) + (r.weight || 0);
    }
    const mkNames = Object.keys(marketMap), mkVals = mkNames.map(k => +marketMap[k].toFixed(2));
    const inNames = Object.keys(indMap), inVals = inNames.map(k => +indMap[k].toFixed(2));

    box.innerHTML = `
      <div class="card">
        <div class="card-title">最新季度持仓 <span class="hint">截止 ${esc(b.holders.date || '--')}（前十大）</span></div>
        <div class="metric-grid">
          <div class="metric"><div class="k">前十大集中度</div><div class="v">${c.conc != null ? c.conc.toFixed(1) + '%' : '--'}</div>
            <div class="s">${c.prevConc != null ? '上季 ' + c.prevConc.toFixed(1) + '%（' + (c.conc >= c.prevConc ? '上升' : '下降') + '）' : '本季首次记录'}</div></div>
          <div class="metric"><div class="k">本季较上季</div><div class="v">新增 ${c.added || 0} · 增持 ${c.inc || 0} · 减持 ${c.dec || 0}</div>
            <div class="s">${c.overlap != null ? '与上季前十大重叠 ' + c.overlap + '/10' : '（以天天基金口径较上季）'}</div></div>
          <div class="metric"><div class="k">退出前十大</div><div class="v">${c.exited ? c.exited.length : 0} 只</div>
            <div class="s">${c.exited ? esc(c.exited.join('、')) : '--'}</div></div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">股市与行业分布 <span class="hint">按最新季度前十大持仓权重</span></div>
        <div class="pie-row">
          <div class="pie-box"><div class="pie-title">市场分布（美股/港股/…）</div><div id="marketPie" class="chart chart-pie"></div></div>
          <div class="pie-box"><div class="pie-title">行业分布</div><div id="industryPie" class="chart chart-pie"></div></div>
        </div>
        <div class="note">饼图按"占净值比例"计算，反映该基金当前主要投向哪些市场、哪些行业。</div>
      </div>
      <div class="card">
        <div class="card-title">持仓变动明细 <span class="hint">点击股票查看实时行情 · 当日涨跌实时更新</span></div>
        <div class="stock-list">
          ${top10.map(r => {
            const tagM = r.market === '港股' ? '<span class="tag hk">港股</span>' : r.market === '美股' ? '<span class="tag us">美股</span>' : '';
            const typeCls = r.type === '减持' ? 'down' : 'up';
            const chgTxt = r.change != null ? fmtPct(r.change) : '';
            return `<div class="stock-card" data-stk="${esc(r.code)}">
              <div class="sc-top"><span class="stock-name">${esc(r.name)}${r.type === '新增' ? '<span class="tag new">新进</span>' : ''}${tagM}</span></div>
              <div class="stock-code">${esc(r.code)}${r.industry ? ' · ' + esc(r.industry) : ''}</div>
              <div class="sc-grid">
                <div class="sc-item"><div class="k">当日涨跌</div><div class="v stk-quote">--</div></div>
                <div class="sc-item"><div class="k">占净值比</div><div class="v">${r.weight != null ? r.weight.toFixed(2) + '%' : '--'}</div></div>
                <div class="sc-item"><div class="k">较上季</div><div class="v ${r.type === '新增' ? 'up' : typeCls}">${r.type ? esc(r.type) : '--'}</div>
                  ${chgTxt ? `<div class="s ${r.change >= 0 ? 'up' : 'down'}">${fmtPct(r.change)}</div>` : ''}</div>
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>
      <div class="card">
        <div class="card-title">资产配置趋势 <span class="hint">股票/债券/现金占净值比</span></div>
        <div id="allocChart" class="chart chart-sm"></div>
      </div>`;
    drawPie('marketPie', mkNames, mkVals, '市场');
    drawPie('industryPie', inNames, inVals, '行业');
    drawAllocChart(b.assetAlloc);
    loadHoldQuotes(b);
    box.querySelectorAll('[data-stk]').forEach(card => {
      const stk = top10.find(x => x.code === card.dataset.stk);
      if (stk) card.onclick = () => openStock(stk.name, stk.code, stk.market);
    });
  }

  function drawPie(id, names, vals, unit) {
    const el = $('#' + id);
    disposeChart(id);
    if (!names.length) { el.innerHTML = '<div class="note">暂无数据</div>'; return; }
    const inst = echarts.init(el);
    charts[id] = inst;
    const colors = [T().accent, '#f472b6', '#fbbf24', '#34d399', '#a78bfa', '#fb7185', '#22d3ee', '#f97316', '#4ade80', '#e879f9', '#94a3b8'];
    inst.setOption({
      color: colors,
      tooltip: { confine: true, hideDelay: 50, trigger: 'item', formatter: p => `${p.name}<br/>${p.value}% (${p.percent}%)` },
      legend: { bottom: 0, textStyle: { color: T().muted, fontSize: 10 }, type: 'scroll' },
      series: [{
        type: 'pie', radius: ['42%', '68%'], center: ['50%', '42%'],
        label: { formatter: p => p.name + ' ' + p.percent + '%', fontSize: 10, color: T().text },
        labelLine: { length: 8, length2: 6 },
        data: names.map((n, i) => ({ name: n, value: vals[i] }))
      }]
    });
  }

  function drawAllocChart(alloc) {
    const el = $('#allocChart');
    disposeChart('allocChart');
    if (!alloc || !alloc.length) { el.innerHTML = '<div class="note">暂无资产配置数据</div>'; return; }
    const inst = echarts.init(el);
    charts.allocChart = inst;
    const dates = alloc.map(r => r.date);
    const names = ['股票占净比', '债券占净比', '现金占净比'];
    const colors = [T().accent, '#34d399', '#fbbf24'];
    inst.setOption({
      color: colors,
      grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
      tooltip: { confine: true, hideDelay: 50, trigger: 'axis', valueFormatter: v => v == null ? '--' : v + '%' },
      legend: { top: 0, textStyle: { color: T().muted, fontSize: 10 } },
      xAxis: { type: 'category', data: dates, axisLabel: { color: T().muted, fontSize: 10 } },
      yAxis: { type: 'value', axisLabel: { formatter: v => v + '%', color: T().muted }, splitLine: { lineStyle: { color: T().lineSoft } } },
      series: names.map(n => ({
        name: n.replace('占净比', ''), type: 'line', connectNulls: true, showSymbol: true, symbolSize: 5,
        data: alloc.map(r => r[n] != null ? r[n] : null)
      }))
    });
  }

  function styleSummary(b) {
    const parts = [];
    const c = b.compare;
    if (c) {
      if (c.conc != null) parts.push(`前十大集中度 ${c.conc.toFixed(1)}%${c.prevConc != null ? '，较上季' + (c.conc >= c.prevConc ? '上升' : '下降') : ''}`);
      if (c.added != null) parts.push(`本季新增${c.added}只、增持${c.inc}只、减持${c.dec}只`);
      if (c.overlap != null) parts.push(`与上季前十大重叠${c.overlap}/10${c.exited && c.exited.length ? '，退出' + c.exited.join('、') : ''}`);
    }
    const alloc = b.assetAlloc;
    if (alloc && alloc.length >= 2) {
      const last = alloc[alloc.length - 1], prev2 = alloc[alloc.length - 2];
      if (last['股票占净比'] != null && prev2['股票占净比'] != null) {
        const d = last['股票占净比'] - prev2['股票占净比'];
        parts.push(`股票仓位 ${last['股票占净比'].toFixed(1)}%（较上季${d >= 0 ? '+' : ''}${d.toFixed(1)}pp）`);
      }
    }
    if (!parts.length) parts.push('暂无持仓风格数据');
    const p1y = b.periods['1y'];
    if (p1y && p1y.ret != null) parts.unshift(`近1年回报 ${fmtPct(p1y.ret)}${p1y.avg != null ? '（同类均值 ' + fmtPct(p1y.avg) + '）' : ''}`);
    return parts.join('；') + '。';
  }

  // ================= 渲染：管理 / 添加 =================
  function renderSettings() {
    $('#fundCount').textContent = state.funds.length + ' 只';
    const groups = [...new Set(state.funds.map(f => f.group).filter(Boolean))];
    $('#groupList').innerHTML = groups.map(g => `<option value="${esc(g)}">`).join('');

    $('#setFundList').innerHTML = state.funds.map((f, i) => `
      <div class="fund-row" style="cursor:default">
        <div class="rank-badge other">${i + 1}</div>
        <div class="fund-main">
          <div class="fund-name">${esc(shortName(f.name) || f.name)}</div>
          <div class="fund-meta"><span>${f.code}</span><span>${esc(f.name || '')}</span></div>
        </div>
        <div class="fund-side">
          <input class="group-input" list="groupList" value="${esc(f.group || '')}" placeholder="分组" data-code="${f.code}" title="输入任意名称创建/修改分组">
          <button class="del-btn" data-code="${f.code}">移除</button>
        </div>
      </div>`).join('');
    $('#setFundList').querySelectorAll('.del-btn').forEach(btn => btn.onclick = () => {
      state.funds = state.funds.filter(f => f.code !== btn.dataset.code);
      state.bundles.delete(btn.dataset.code);
      saveFunds();
      renderAll();
      toast('已移除 ' + btn.dataset.code);
    });
    $('#setFundList').querySelectorAll('.group-input').forEach(inp => inp.onchange = () => {
      const f = fundOf(inp.dataset.code);
      if (!f) return;
      f.group = inp.value.trim();
      saveFunds();
      renderAll();
      toast('分组已更新');
    });
  }

  let searchTimer = null;
  function bindSearch() {
    const input = $('#searchInput');
    input.oninput = () => {
      clearTimeout(searchTimer);
      const q = input.value.trim();
      if (!q) { $('#searchResults').innerHTML = ''; return; }
      searchTimer = setTimeout(() => doSearch(q), 350);
    };
  }

  async function doSearch(q) {
    const box = $('#searchResults');
    box.innerHTML = '<div class="note">搜索中…</div>';
    try {
      const j = await jsonp('https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=' + encodeURIComponent(q));
      let list = (j.Datas || []).slice(0, 8);
      const isCode = /^\d{6}$/.test(q);
      if (isCode) list = list.filter(x => x.CODE === q).concat(list.filter(x => x.CODE !== q));
      if (!list.length) {
        box.innerHTML = '<div class="note">未找到相关基金，请确认基金名称或 6 位代码是否正确</div>';
        return;
      }
      box.innerHTML = list.map(x => {
        const info = x.FundBaseInfo || {};
        const added = state.funds.some(f => f.code === x.CODE);
        return `<div class="search-item" data-code="${x.CODE}" data-name="${esc(x.NAME)}" style="${added ? 'opacity:.55' : ''}">
          <div class="fund-main"><div class="fund-name">${esc(x.NAME)}</div>
            <div class="fund-meta"><span>${x.CODE}</span><span>${esc(info.FTYPE || '')}</span>
            ${info.DWJZ ? `<span>净值 ${info.DWJZ} (${info.FSRQ})</span>` : ''}</div></div>
          <span class="add">${added ? '已在列表' : '＋'}</span></div>`;
      }).join('');
      box.querySelectorAll('.search-item').forEach(item => item.onclick = async () => {
        const code = item.dataset.code;
        const name = item.dataset.name;
        if (state.funds.some(f => f.code === code)) { toast('该基金已在列表中'); return; }
        state.funds.push({ code, name, group: '' });
        saveFunds();
        renderSettings();
        $('#searchInput').value = '';
        box.innerHTML = '';
        toast('已添加 ' + shortName(name) + '，正在获取数据…');
        try {
          const b = await fetchBundle(code);
          state.bundles.set(code, b);
          LS.set('gfc:bundle:' + code, b);
          renderAll();
          estimateFundsAndSave();
          toast('已添加 ' + shortName(b.name) + '，可在“管理”里设置分组，或到“趋势”页勾选对比');
        } catch (e) {
          toast('添加成功，但数据获取失败：' + e.message);
        }
      });
    } catch (e) {
      box.innerHTML = '<div class="note err">搜索失败：' + esc(e.message) + '</div>';
    }
  }

  // ================= 上传持仓截图识别 =================
  let tesseractPromise = null;
  const OCR_LANG_PATH = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/chi_sim@4.0.0_best_int/4.0.0_best_int';
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (tesseractPromise) return tesseractPromise;
    tesseractPromise = new Promise((resolve, reject) => {
      const urls = [
        'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
        'https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js',
        'https://registry.npmmirror.com/tesseract.js/5.1.1/files/dist/tesseract.min.js'
      ];
      const tryLoad = i => {
        if (i >= urls.length) { reject(new Error('OCR 组件加载失败，请检查网络')); return; }
        const s = document.createElement('script');
        s.src = urls[i];
        s.onload = () => {
          const T = window.Tesseract;
          if (!T) { reject(new Error('OCR 组件不可用')); return; }
          try {
            T.workerPath = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js';
            T.corePath = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1';
          } catch (e) { /* ignore */ }
          resolve(T);
        };
        s.onerror = () => tryLoad(i + 1);
        document.head.appendChild(s);
      };
      tryLoad(0);
    });
    return tesseractPromise;
  }

  function normFundName(s) {
    return String(s || '').toLowerCase().replace(/[\s\u3000·．.（）()\[\]【】\-_—,，。:：/\\]/g, '');
  }

  function nameSim(a, b) {
    const A = normFundName(a), B = normFundName(b);
    if (!A || !B) return 0;
    if (A === B) return 1;
    if (A.includes(B) || B.includes(A)) return 0.6 + 0.4 * Math.min(A.length, B.length) / Math.max(A.length, B.length);
    let hit = 0;
    const s = A.length < B.length ? A : B;
    const l = A.length < B.length ? B : A;
    for (const ch of s) if (l.includes(ch)) hit++;
    return hit / s.length;
  }

  async function addFundByCode(code, name, group) {
    if (state.funds.some(f => f.code === code)) return { ok: true, added: false };
    state.funds.push({ code, name: name || code, group: group || '' });
    saveFunds();
    renderSettings();
    try {
      const b = await fetchBundle(code);
      state.bundles.set(code, b);
      LS.set('gfc:bundle:' + code, b);
      renderAll();
      return { ok: true, added: true };
    } catch (e) {
      return { ok: false, added: true, error: e.message };
    }
  }

  async function matchHoldingsText(text) {
    const status = $('#ocrStatus');
    const box = $('#ocrResults');
    const lines = (text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const codeSet = new Set();
    for (const line of lines) {
      for (const m of line.matchAll(/\b\d{6}\b/g)) codeSet.add(m[0]);
    }
    const nameCands = [];
    for (const line of lines) {
      const cleaned = line.replace(/[0-9.,%¥￥元份股]+/g, '').replace(/[（(].*?[)）]/g, '').trim();
      if (cleaned.length < 4 || cleaned.length > 40) continue;
      if (!/[\u4e00-\u9fa5]/.test(cleaned)) continue;
      if (/(收益|金额|资产|持有|市值|成本|当日|累计|更新时间|账户|余额|盈亏|份额|基金代码|基金名称)/.test(cleaned)) continue;
      nameCands.push(cleaned);
    }
    const cands = [...new Set([...codeSet, ...nameCands])];
    if (!cands.length) { status.textContent = '未能从截图中识别出基金，请换一张更清晰的持仓截图'; return; }

    status.textContent = '正在匹配基金（' + cands.length + ' 个候选）…';
    const matched = [], unmatched = [];
    for (const cand of cands) {
      try {
        const j = await jsonp('https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=' + encodeURIComponent(cand));
        const list = (j.Datas || []).slice(0, 6);
        if (!list.length) { unmatched.push({ cand, reason: '未找到' }); continue; }
        let pick = null;
        if (/^\d{6}$/.test(cand)) {
          pick = list.find(x => x.CODE === cand) || list[0];
        } else {
          let best = null, bestS = 0;
          for (const x of list) {
            const s = nameSim(cand, x.NAME);
            if (s > bestS) { bestS = s; best = x; }
          }
          if (best && bestS >= 0.45) pick = best;
        }
        if (pick) {
          const r = await addFundByCode(pick.CODE, pick.NAME, '');
          matched.push({ code: pick.CODE, name: pick.NAME, already: !r.added });
        } else {
          unmatched.push({ cand, reason: '匹配度不足' });
        }
      } catch (e) {
        unmatched.push({ cand, reason: '搜索失败' });
      }
    }
    status.textContent = matched.length
      ? '识别并处理了 ' + matched.length + ' 只基金（已加入“当前关注”）'
      : '未匹配到基金，可点击下方候选手动搜索添加';
    box.innerHTML = [
      ...matched.map(m => `<div class="search-item" style="opacity:.85"><div class="fund-main"><div class="fund-name">${esc(m.name)}</div><div class="fund-meta"><span>${m.code}</span><span>${m.already ? '已在列表' : '已添加'}</span></div></div></div>`),
      ...unmatched.map(u => `<div class="search-item" data-q="${esc(u.cand)}"><div class="fund-main"><div class="fund-name">${esc(u.cand)}</div><div class="fund-meta"><span>${esc(u.reason)}</span></div></div><span class="add">搜索</span></div>`)
    ].join('');
    box.querySelectorAll('.search-item[data-q]').forEach(item => item.onclick = () => {
      const q = item.dataset.q;
      $('#searchInput').value = q;
      $('#searchInput').dispatchEvent(new Event('input'));
      switchTab('settings');
    });
  }

  function bindHoldShot() {
    const input = $('#holdShotInput');
    if (!input) return;
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const status = $('#ocrStatus');
      const box = $('#ocrResults');
      box.innerHTML = '';
      status.textContent = '正在加载识别组件（首次使用需下载，请稍候）…';
      try {
        const T = await loadTesseract();
        status.textContent = '正在识别持仓截图…（首次需下载识别库，可能较慢）';
        try {
          const { data } = await Promise.race([
            T.recognize(file, 'chi_sim', { langPath: OCR_LANG_PATH }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('识别超时（识别库下载较慢或网络受限）')), 90000))
          ]);
          await matchHoldingsText(data.text || '');
        } finally {
          try { await T.terminate(); } catch (e) { /* ignore */ }
        }
      } catch (e) {
        status.textContent = '识别失败：' + (e && e.message ? e.message : e) + '。请检查网络后重试，或换一张更清晰的截图。';
      }
    };
  }

  // ================= 渲染：详情 =================
  const DETAIL_TABS = [
    { key: 'perf', label: '业绩' }, { key: 'trend', label: '走势' },
    { key: 'hold', label: '持仓' }, { key: 'mgr', label: '经理' }
  ];

  // ================= 个股实时行情 =================
  async function openStock(name, code, market) {
    if (!code) return;
    pushNav({ stock: code });
    state.stockCode = code;
    const overlay = $('#stock');
    const body = $('#stockBody');
    const marketTag = market === '港股' ? '<span class="tag hk">港股</span>' : market === '美股' ? '<span class="tag us">美股</span>' : market ? `<span class="tag">${esc(market)}</span>` : '';
    body.innerHTML = `
      <div class="sheet-head">
        <div>
          <div style="font-size:1.05rem;font-weight:700">${esc(name)}${marketTag}</div>
          <div class="fund-meta" id="stockSub"><span>${esc(code)}</span><span>正在加载行情…</span></div>
        </div>
        <button class="sheet-close">×</button>
      </div>
      <div id="stockQuote"></div>
      <div class="card"><div class="card-title">近期走势 <span class="hint">近 12 个交易日收盘</span></div><div id="stockChart" class="chart chart-sm"></div></div>
      <div class="note">行情来自腾讯行情，可能有延时，仅供参考。</div>`;
    overlay.classList.add('show');
    body.querySelector('.sheet-close').onclick = closeStock;
    overlay.onclick = e => { if (e.target === overlay) closeStock(); };

    const sym = symForStock({ code, market });
    if (!sym) {
      $('#stockSub').innerHTML = `<span>${esc(code)}</span><span>暂不支持该市场行情</span>`;
      $('#stockQuote').innerHTML = '<div class="note">暂无行情数据</div>';
      return;
    }
    const [q, kl] = await Promise.all([
      fetchQuotes([sym]).catch(() => ({})),
      fetchKlines([sym], 12).catch(() => ({}))
    ]);
    if (state.stockCode !== code) return;
    const info = q[sym.toUpperCase()];
    $('#stockSub').innerHTML = `<span>${esc(code)}</span><span>${info && info.time ? esc(info.time) : ''}</span>`;
    renderStockQuote(info);
    drawStockChart(kl[sym.toUpperCase()] || []);
  }

  function renderStockQuote(info) {
    const box = $('#stockQuote');
    if (!box) return;
    if (!info || info.price == null || isNaN(info.price)) {
      box.innerHTML = '<div class="note">暂无行情数据（可能已退市或停牌）</div>';
      return;
    }
    const pct = info.pct;
    const c = cls(pct);
    box.innerHTML = `
      <div class="quote-big">
        <span class="price ${c}">${info.price.toFixed(2)}</span>
        <span class="chg ${c}">${fmtPct(pct)}</span>
        ${info.chgAmt != null && !isNaN(info.chgAmt) ? `<span class="chg ${c}">${info.chgAmt >= 0 ? '+' : ''}${info.chgAmt.toFixed(2)}</span>` : ''}
      </div>
      <div class="quote-meta">${info.currency ? esc(info.currency) + ' ' : ''}最新行情时间：${esc(info.time || '--')}</div>
      <div class="detail-grid">
        <div class="metric"><div class="k">昨收</div><div class="v flat">${info.prevClose != null && !isNaN(info.prevClose) ? info.prevClose.toFixed(2) : '--'}</div></div>
        <div class="metric"><div class="k">今开</div><div class="v flat">${info.open != null && !isNaN(info.open) ? info.open.toFixed(2) : '--'}</div></div>
        <div class="metric"><div class="k">最高</div><div class="v up">${info.high != null && !isNaN(info.high) ? info.high.toFixed(2) : '--'}</div></div>
        <div class="metric"><div class="k">最低</div><div class="v down">${info.low != null && !isNaN(info.low) ? info.low.toFixed(2) : '--'}</div></div>
      </div>`;
  }

  function drawStockChart(pts) {
    const el = $('#stockChart');
    disposeChart('stockChart');
    if (!pts || pts.length < 2) { el.innerHTML = '<div class="note">暂无走势数据</div>'; return; }
    const inst = echarts.init(el);
    charts.stockChart = inst;
    inst.setOption({
      grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
      tooltip: { confine: true, hideDelay: 50, trigger: 'axis', formatter: p => `${p[0].axisValue}<br/>收盘 ${p[0].value.toFixed(2)}` },
      xAxis: { type: 'category', data: pts.map(x => x.d), axisLabel: { color: T().muted, fontSize: 9, formatter: v => v.slice(5) } },
      yAxis: { type: 'value', scale: true, axisLabel: { color: T().muted }, splitLine: { lineStyle: { color: T().lineSoft } } },
      series: [{
        type: 'line', showSymbol: false, connectNulls: true, lineStyle: { color: T().accent, width: 1.8 },
        areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(56,189,248,.25)' }, { offset: 1, color: 'rgba(56,189,248,0)' }] } },
        data: pts.map(x => x.close)
      }]
    });
  }

  function closeStock() {
    $('#stock').classList.remove('show');
    state.stockCode = null;
    hideAllTips();
    disposeChart('stockChart');
    if (!closingViaPop && history.state && history.state.stock) {
      try { history.back(); } catch (e) { /* ignore */ }
    }
  }

  function openDetail(code) {
    const b = state.bundles.get(code);
    if (!b) return;
    pushNav({ detail: code });
    state.detailCode = code;
    state.detailRange = '1y';
    state.detailTab = 'perf';
    const overlay = $('#detail');
    const body = $('#detailBody');
    body.innerHTML = `
      <div class="sheet-head">
        <div>
          <div style="font-size:1.05rem;font-weight:700">${esc(shortName(b.name))}</div>
          <div class="fund-meta"><span>${b.code}</span><span>净值 ${b.nav != null ? b.nav.toFixed(4) : '--'} (${b.navDate})</span>
            <span class="${cls(b.dailyChange)}">日涨幅 ${fmtPct(b.dailyChange)}</span></div>
          ${b.manager ? `<div class="fund-meta"><span>经理：${esc(b.manager.name)}${b.manager.workTime ? ' · 从业 ' + esc(b.manager.workTime) : ''}${b.manager.fundSize ? ' · ' + esc(b.manager.fundSize) : ''}${b.manager.star ? ' · ★' + b.manager.star : ''}</span></div>` : ''}
        </div>
        <button class="sheet-close">×</button>
      </div>
      <div class="detail-tabs" id="detailTabs">
        ${DETAIL_TABS.map(t => `<button class="dtab ${t.key === state.detailTab ? 'active' : ''}" data-key="${t.key}">${t.label}</button>`).join('')}
      </div>
      <div id="detailPerf"></div>
      <div id="detailTrend" hidden></div>
      <div id="detailHold" hidden></div>
      <div id="detailMgr" hidden></div>`;
    overlay.classList.add('show');
    body.querySelector('.sheet-close').onclick = closeDetail;
    overlay.onclick = e => { if (e.target === overlay) closeDetail(); };
    $('#detailTabs').querySelectorAll('.dtab').forEach(btn => btn.onclick = () => {
      state.detailTab = btn.dataset.key;
      renderDetailTab();
    });
    renderDetailTab();
  }

  function renderDetailTab() {
    const b = state.bundles.get(state.detailCode);
    if (!b) return;
    document.querySelectorAll('#detailTabs .dtab').forEach(t => t.classList.toggle('active', t.dataset.key === state.detailTab));
    for (const t of DETAIL_TABS) $('#detail' + t.key.charAt(0).toUpperCase() + t.key.slice(1)).hidden = t.key !== state.detailTab;
    hideAllTips();
    if (state.detailTab === 'perf') renderDetailPerf(b);
    if (state.detailTab === 'trend') renderDetailTrend(b);
    if (state.detailTab === 'hold') renderDetailHold(b);
    if (state.detailTab === 'mgr') renderDetailMgr(b);
  }

  function renderDetailPerf(b) {
    const el = $('#detailPerf');
    el.innerHTML = `
      <div class="card" style="margin-top:10px">
        <div class="card-title">区间表现</div>
        <div class="detail-grid" id="detailGrid"></div>
      </div>
      <div class="card">
        <div class="card-title">长期表现</div>
        <div class="detail-grid" id="longGrid"></div>
      </div>
      <div class="card">
        <div class="card-title">同类排名百分位趋势 <span class="hint">数值越小 = 排名越靠前</span></div>
        <div id="dRankChart" class="chart chart-sm"></div>
      </div>
      <div class="card">
        <div class="card-title">累计收益对比 <span class="hint">本基金 vs 同类平均 vs 沪深300</span></div>
        <div id="dPerfTrendChart" class="chart chart-sm"></div>
      </div>
      <div class="card">
        <div class="card-title">股票仓位历史 <span class="hint">占净值比</span></div>
        <div id="dSharesChart" class="chart chart-sm"></div>
      </div>
      <div class="card">
        <div class="card-title">持有人结构 <span class="hint">机构 / 个人 / 内部持有比例</span></div>
        <div id="dHolderChart" class="chart chart-sm"></div>
      </div>
      <div class="card">
        <div class="card-title">近12个月月度收益 <span class="hint">每月首个净值日 → 月末</span></div>
        <div id="dMonthlyChart" class="chart chart-sm"></div>
      </div>
      <div class="card">
        <div class="card-title">回撤走势 <span class="hint">从历史高点的回落幅度</span></div>
        <div id="dDDChart" class="chart chart-sm"></div>
      </div>
      <div class="card">
        <div class="card-title">近期统计 <span class="hint">近 1 年</span></div>
        <div class="detail-grid" id="recentGrid"></div>
      </div>
      <div class="card">
        <div class="card-title">指标怎么看</div>
        <div class="note" id="metricExplain"></div>
      </div>`;
    $('#detailGrid').innerHTML = BOARD_PERIODS.map(p => {
      const v = b.periods[p.key] || {};
      return `<div class="metric">
        <div class="k">${p.label}</div>
        <div class="v ${cls(v.ret)}">${fmtPct(v.ret)}</div>
        <div class="s">同类均值 ${fmtPct(v.avg)}${v.rank != null ? ' ｜ 排名 ' + v.rank + '/' + v.total : ''}</div>
      </div>`;
    }).join('');
    const ann = annualizedReturn(b.series);
    $('#longGrid').innerHTML = [['2y', '近2年'], ['3y', '近3年'], ['5y', '近5年'], ['incep', '成立以来']]
      .map(([k, label]) => {
        const v = b.periods[k] || {};
        return `<div class="metric"><div class="k">${label}</div><div class="v ${cls(v.ret)}">${fmtPct(v.ret)}</div></div>`;
      }).join('') +
      `<div class="metric"><div class="k">成立以来年化</div><div class="v ${cls(ann)}">${fmtPct(ann)}</div><div class="s">按复利折算</div></div>`;
    const rs = recentStats(b.series);
    $('#recentGrid').innerHTML = [
      ['上涨天数占比', fmtPct(rs.upRate), cls(rs.upRate - 50)],
      ['平均日涨幅', fmtPct(rs.avg), cls(rs.avg)],
      ['最大连续上涨', (rs.maxUp || 0) + ' 天', 'up'],
      ['最大连续下跌', (rs.maxDn || 0) + ' 天', 'down']
    ].map(c => `<div class="metric"><div class="k">${c[0]}</div><div class="v ${c[2]}">${c[1]}</div></div>`).join('');
    drawRankTrend(b.rankTrend);
    drawPerfTrend(b.perfTrend);
    drawSharesTrend(b.sharesPositions);
    drawHolderChart(b.holderStructure);
    drawMonthlyChart(b.series);
    drawDrawdownChart(b.series);
    const s = b.stats || {};
    const alloc = b.assetAlloc && b.assetAlloc.length ? b.assetAlloc[b.assetAlloc.length - 1] : null;
    const conc = b.compare ? b.compare.conc : null;
    const mgr = b.manager;
    const items = [
      ['区间收益率', '近1周/近1月/近3月/近半年/近1年/今年来 的涨跌幅，是判断短期和中期表现最直接的指标。'],
      ['同类排名', '在同类基金中的排名（如 24/97）和百分位（前 24.7%）。百分位越小越好，代表跑赢了越多同类。'],
      ['最大回撤', '区间内从最高点到最低点的最大跌幅，衡量买入后可能承受的最大浮亏，越小越稳。当前近1年最大回撤 ' + fmtPct(s.maxDD1y) + '。'],
      ['年化波动率', '净值波动的剧烈程度，越大代表涨跌越猛（收益风险也越高）。当前 ' + (s.vol1y != null ? s.vol1y.toFixed(1) + '%' : '--') + '。'],
      ['同类对比', '把本基金与同类平均、沪深300放在一起比，看是否跑赢大盘和同类基金（见上方"累计收益对比"曲线）。'],
      ['前十大集中度', '前十大重仓股占净值的比例，越高越"押注集中"，波动可能更大。当前 ' + (conc != null ? conc.toFixed(1) + '%' : '--') + '。'],
      ['股票仓位', '股票资产占净值比例，反映进攻性。当前 ' + (alloc && alloc['股票占净比'] != null ? alloc['股票占净比'].toFixed(1) + '%' : '--') + '。'],
      ['基金经理', (mgr ? mgr.name + '，从业 ' + (mgr.workTime || '--') + (mgr.fundSize ? '，' + mgr.fundSize : '') : '暂无') + '。经理更替是影响风格的关键变量。']
    ];
    $('#metricExplain').innerHTML = items.map(([k, v]) => `<b style="color:var(--accent)">${k}</b>：${esc(v)}<br><br>`).join('');
  }

  function drawRankTrend(rankTrend) {
    const el = $('#dRankChart');
    disposeChart('dRankChart');
    if (!rankTrend || rankTrend.length < 5) { el.innerHTML = '<div class="note">暂无排名历史数据</div>'; return; }
    const inst = echarts.init(el);
    charts.dRankChart = inst;
    const last1y = rankTrend.filter(p => p.d >= fmtDate(new Date(Date.now() - 400 * 86400e3)));
    const data = (last1y.length ? last1y : rankTrend).slice(-260);
    inst.setOption({
      grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
      tooltip: { confine: true, hideDelay: 50, trigger: 'axis', formatter: p => `${p[0].axisValue}<br/>同类前 ${p[0].value.toFixed(1)}%（越小越好）` },
      xAxis: { type: 'category', data: data.map(p => p.d), axisLabel: { color: T().muted, fontSize: 9, formatter: v => v.slice(5) } },
      yAxis: {
        type: 'value', name: '百分位%', nameTextStyle: { color: T().muted }, max: 100,
        axisLabel: { formatter: v => v + '%', color: T().muted }, splitLine: { lineStyle: { color: T().lineSoft } }, inverse: true
      },
      series: [{ type: 'line', showSymbol: false, lineStyle: { color: T().accent, width: 1.6 }, areaStyle: { color: 'rgba(56,189,248,.12)' }, data: data.map(p => p.y) }]
    });
  }

  function drawPerfTrend(perf) {
    const el = $('#dPerfTrendChart');
    disposeChart('dPerfTrendChart');
    const lines = (perf || []).filter(e => e.points && e.points.length > 2);
    if (!lines.length) { el.innerHTML = '<div class="note">暂无收益对比数据</div>'; return; }
    const inst = echarts.init(el);
    charts.dPerfTrendChart = inst;
    const colors = [T().accent, T().muted, '#fbbf24'];
    const allDates = [...new Set(lines.flatMap(e => e.points.map(p => p.d)))].sort();
    const last1y = allDates.filter(d => d >= fmtDate(new Date(Date.now() - 400 * 86400e3)));
    const dates = (last1y.length ? last1y : allDates);
    inst.setOption({
      color: colors,
      grid: { left: 8, right: 16, top: 30, bottom: 8, containLabel: true },
      tooltip: {
        confine: true,
        hideDelay: 50,
        trigger: 'axis',
        formatter: p => {
          let html = p[0].axisValue + '<br/>';
          for (const s of p) html += `${s.marker}${s.seriesName}：${fmtPct(s.value)}<br/>`;
          return html;
        }
      },
      legend: { top: 0, textStyle: { color: T().muted, fontSize: 10 } },
      xAxis: { type: 'category', data: dates, axisLabel: { color: T().muted, fontSize: 9, formatter: v => v.slice(5) } },
      yAxis: { type: 'value', name: '累计涨幅%', nameTextStyle: { color: T().muted }, axisLabel: { formatter: v => v + '%', color: T().muted }, splitLine: { lineStyle: { color: T().lineSoft } } },
      series: lines.map((e, i) => {
        const map = new Map(e.points.map(p => [p.d, p.y]));
        return {
          name: e.name.replace(/\s+/g, '').slice(0, 12) || '系列' + (i + 1),
          type: 'line', showSymbol: false, connectNulls: true, lineStyle: { width: i === 0 ? 2 : 1.4, type: i === 0 ? 'solid' : 'dashed' },
          data: dates.map(d => map.has(d) ? map.get(d) : null)
        };
      })
    });
  }

  function drawSharesTrend(series) {
    const el = $('#dSharesChart');
    disposeChart('dSharesChart');
    if (!series || series.length < 3) { el.innerHTML = '<div class="note">暂无股票仓位数据</div>'; return; }
    const inst = echarts.init(el);
    charts.dSharesChart = inst;
    inst.setOption({
      grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
      tooltip: { confine: true, hideDelay: 50, trigger: 'axis', formatter: p => `${p[0].axisValue}<br/>股票仓位 ${p[0].value.toFixed(1)}%` },
      xAxis: { type: 'category', data: series.map(p => p.d), axisLabel: { color: T().muted, fontSize: 9, formatter: v => v.slice(5) } },
      yAxis: { type: 'value', name: '%', nameTextStyle: { color: T().muted }, max: 100, axisLabel: { formatter: v => v + '%', color: T().muted }, splitLine: { lineStyle: { color: T().lineSoft } } },
      series: [{ type: 'line', showSymbol: false, step: 'end', lineStyle: { color: '#fbbf24', width: 1.6 }, areaStyle: { color: 'rgba(251,191,36,.12)' }, data: series.map(p => p.y) }]
    });
  }

  function drawHolderChart(hs) {
    const el = $('#dHolderChart');
    disposeChart('dHolderChart');
    if (!hs || hs.length < 2) { el.innerHTML = '<div class="note">暂无持有人结构数据</div>'; return; }
    const inst = echarts.init(el);
    charts.dHolderChart = inst;
    const names = ['机构持有比例', '个人持有比例', '内部持有比例'];
    inst.setOption({
      color: [T().accent, T().muted, '#fbbf24'],
      grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
      tooltip: { confine: true, hideDelay: 50, trigger: 'axis', valueFormatter: v => v == null ? '--' : v.toFixed(1) + '%' },
      legend: { top: 0, textStyle: { color: T().muted, fontSize: 10 } },
      xAxis: { type: 'category', data: hs.map(r => r.date), axisLabel: { color: T().muted, fontSize: 9 } },
      yAxis: { type: 'value', name: '%', nameTextStyle: { color: T().muted }, max: 100, axisLabel: { formatter: v => v + '%', color: T().muted } },
      series: names.map(n => ({
        name: n.replace('持有比例', ''), type: 'bar', stack: 'h', barMaxWidth: 30,
        data: hs.map(r => r[n] != null ? r[n] : null)
      }))
    });
  }

  function annualizedReturn(series) {
    if (!series || series.length < 2) return null;
    const first = series[0].nav, last = series[series.length - 1].nav;
    const days = (new Date(series[series.length - 1].d) - new Date(series[0].d)) / 86400000;
    if (days < 30 || first <= 0 || last <= 0) return null;
    return (Math.pow(last / first, 365 / days) - 1) * 100;
  }

  function monthReturns(series) {
    const map = new Map();
    for (const p of series) {
      const k = p.d.slice(0, 7);
      if (!map.has(k)) map.set(k, { first: p.nav, last: p.nav });
      else map.get(k).last = p.nav;
    }
    return [...map.entries()]
      .map(([m, v]) => ({ m, ret: (v.last / v.first - 1) * 100 }))
      .sort((a, b) => a.m.localeCompare(b.m))
      .slice(-12);
  }

  function recentStats(series) {
    const last1y = series.slice(-252);
    let up = 0, n = 0, sum = 0, run = 0, maxUp = 0, runDn = 0, maxDn = 0;
    for (let i = 1; i < last1y.length; i++) {
      const r = last1y[i].nav / last1y[i - 1].nav - 1;
      if (!isFinite(r)) continue;
      n++; sum += r;
      if (r > 0) { up++; run++; runDn = 0; if (run > maxUp) maxUp = run; }
      else if (r < 0) { run = 0; runDn++; if (runDn > maxDn) maxDn = runDn; }
      else { run = 0; runDn = 0; }
    }
    return { upRate: n ? up / n * 100 : null, avg: n ? sum / n * 100 : null, maxUp, maxDn };
  }

  function drawMonthlyChart(series) {
    const el = $('#dMonthlyChart');
    disposeChart('dMonthlyChart');
    const data = monthReturns(series);
    if (!data.length) { el.innerHTML = '<div class="note">暂无月度数据</div>'; return; }
    const inst = echarts.init(el);
    charts.dMonthlyChart = inst;
    inst.setOption({
      grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
      tooltip: { confine: true, hideDelay: 50, trigger: 'axis', formatter: p => `${p[0].axisValue}<br/>月度收益 ${fmtPct(p[0].value)}` },
      xAxis: { type: 'category', data: data.map(x => x.m), axisLabel: { color: T().muted, fontSize: 9, formatter: v => v.slice(5) + '月' } },
      yAxis: { type: 'value', name: '%', nameTextStyle: { color: T().muted }, axisLabel: { formatter: v => v + '%', color: T().muted }, splitLine: { lineStyle: { color: T().lineSoft } } },
      series: [{
        type: 'bar', barMaxWidth: 20,
        data: data.map(x => ({ value: x.ret, itemStyle: { color: x.ret >= 0 ? '#f4574d' : '#22c55e', borderRadius: [3, 3, 0, 0] } })),
        label: { show: true, position: 'top', formatter: p => fmtPct(p.value, 1), fontSize: 9, color: T().muted }
      }]
    });
  }

  function drawDrawdownChart(series) {
    const el = $('#dDDChart');
    disposeChart('dDDChart');
    if (!series || series.length < 20) { el.innerHTML = '<div class="note">暂无回撤数据</div>'; return; }
    const target = new Date(series[series.length - 1].d);
    target.setDate(target.getDate() - 400);
    const ts = target.getTime();
    const slice = series.filter(p => new Date(p.d + 'T00:00:00').getTime() >= ts);
    let peak = -Infinity;
    const data = slice.map(p => {
      if (p.nav > peak) peak = p.nav;
      return { d: p.d, dd: +(p.nav / peak * 100 - 100).toFixed(2) };
    });
    const inst = echarts.init(el);
    charts.dDDChart = inst;
    inst.setOption({
      grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
      tooltip: { confine: true, hideDelay: 50, trigger: 'axis', formatter: p => `${p[0].axisValue}<br/>回撤 ${fmtPct(p[0].value)}` },
      xAxis: { type: 'category', data: data.map(x => x.d), axisLabel: { color: T().muted, fontSize: 9, formatter: v => v.slice(5) } },
      yAxis: { type: 'value', max: 0, name: '回撤%', nameTextStyle: { color: T().muted }, axisLabel: { formatter: v => v + '%', color: T().muted }, splitLine: { lineStyle: { color: T().lineSoft } } },
      series: [{
        type: 'line', showSymbol: false, lineStyle: { color: '#22c55e', width: 1.4 },
        areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(34,197,94,0)' }, { offset: 1, color: 'rgba(34,197,94,.25)' }] } },
        data: data.map(x => x.dd)
      }]
    });
  }

  function renderDetailTrend(b) {
    const el = $('#detailTrend');
    el.innerHTML = `
      <div class="chips" id="detailRangeChips" style="margin-top:10px"></div>
      <div class="card"><div id="detailChart" class="chart chart-sm"></div>
      <div class="chart-note">横坐标 = 日期，纵坐标 = 累计涨幅（%），以区间首日为 0%。QDII 净值披露延迟 1-2 天，曲线画到最近披露净值那天为止。</div></div>`;
    const chips = TREND_RANGES.filter(r => r.key !== 'all');
    $('#detailRangeChips').innerHTML = chips.map(r =>
      `<button class="chip ${r.key === state.detailRange ? 'active' : ''}" data-key="${r.key}">${r.label}</button>`).join('');
    $('#detailRangeChips').querySelectorAll('.chip').forEach(c => c.onclick = () => {
      state.detailRange = c.dataset.key;
      renderDetailTrend(b);
    });
    drawDetailChart(b);
  }

  function drawDetailChart(b) {
    const el = $('#detailChart');
    disposeChart('detailChart');
    if (!b) return;
    const inst = echarts.init(el);
    charts.detailChart = inst;
    const s = rangeSeries(b, state.detailRange);
    const base = s[0].nav;
    const dates = s.map(p => p.d);
    inst.setOption({
      grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
      tooltip: { confine: true, hideDelay: 50, trigger: 'axis', formatter: p => `${p[0].axisValue}<br/>净值 ${(b.series.find(x => x.d === p[0].axisValue)?.nav.toFixed(4)) || '--'}<br/>累计 ${fmtPct(p[0].value)}` },
      xAxis: { type: 'category', data: dates, axisLabel: { color: T().muted, fontSize: 9, hideOverlap: false, showMinLabel: true, showMaxLabel: true, formatter: v => v.slice(5) }, axisLine: { lineStyle: { color: T().line } } },
      yAxis: {
        type: 'value', name: '累计涨幅%', nameTextStyle: { color: T().muted, fontSize: 10 },
        axisLabel: { formatter: v => v + '%', color: T().muted },
        splitLine: { lineStyle: { color: T().lineSoft } }
      },
      series: [{
        type: 'line', showSymbol: false, lineStyle: { color: T().accent, width: 1.8 },
        areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(56,189,248,.25)' }, { offset: 1, color: 'rgba(56,189,248,0)' }] } },
        data: dates.map(d => +(b.series.find(x => x.d === d)?.nav / base * 100 - 100).toFixed(2))
      }]
    });
  }

  function renderDetailHold(b) {
    const el = $('#detailHold');
    if (!b || !b.holders) { el.innerHTML = '<div class="card"><div class="note">暂无持仓数据</div></div>'; return; }
    el.innerHTML = `<div class="card" style="margin-top:10px"><div class="card-title">前十大持仓 <span class="hint">${esc(b.holders.date)} · 当日涨跌实时更新 · 点击股票看行情</span></div>
      <div class="stock-list">
        ${b.holders.rows.slice(0, 10).map(r => {
          const tagM = r.market === '港股' ? '<span class="tag hk">港股</span>' : r.market === '美股' ? '<span class="tag us">美股</span>' : '';
          const typeCls = r.type === '减持' ? 'down' : 'up';
          const chgTxt = r.change != null ? fmtPct(r.change) : '';
          return `<div class="stock-card" data-stk="${esc(r.code)}">
            <div class="sc-top"><span class="stock-name">${esc(r.name)}${r.type === '新增' ? '<span class="tag new">新进</span>' : ''}${tagM}</span></div>
            <div class="stock-code">${esc(r.code)}${r.market ? ' · ' + esc(r.market) : ''}${r.industry ? ' · ' + esc(r.industry) : ''}</div>
            <div class="sc-grid">
              <div class="sc-item"><div class="k">当日涨跌</div><div class="v stk-quote">--</div></div>
              <div class="sc-item"><div class="k">占净值比</div><div class="v">${r.weight != null ? r.weight.toFixed(2) + '%' : '--'}</div></div>
              <div class="sc-item"><div class="k">较上季</div><div class="v ${r.type === '新增' ? 'up' : typeCls}">${r.type ? esc(r.type) : '--'}</div>
                ${chgTxt ? `<div class="s ${r.change >= 0 ? 'up' : 'down'}">${fmtPct(r.change)}</div>` : ''}</div>
            </div>
          </div>`;
        }).join('')}
      </div></div>`;
    loadHoldQuotes(b);
    el.querySelectorAll('[data-stk]').forEach(card => {
      const stk = b.holders.rows.find(x => x.code === card.dataset.stk);
      if (stk) card.onclick = () => openStock(stk.name, stk.code, stk.market);
    });
  }

  function renderDetailMgr(b) {
    const el = $('#detailMgr');
    const m = b.manager;
    el.innerHTML = `
      <div class="card" style="margin-top:10px">
        ${m ? `<div class="mgr-head">
          ${m.pic ? `<img class="mgr-avatar" src="${esc(m.pic)}" onerror="this.style.visibility='hidden'">` : '<div class="mgr-avatar"></div>'}
          <div><div class="mgr-name">${esc(m.name)}</div>
            <div class="mgr-tags">
              ${m.star ? `<span class="mgr-tag star">★ ${m.star}</span>` : ''}
              ${m.workTime ? `<span class="mgr-tag">从业 ${esc(m.workTime)}</span>` : ''}
              ${m.fundSize ? `<span class="mgr-tag">${esc(m.fundSize)}</span>` : ''}
            </div></div>
        </div>
        <div class="note" style="margin-top:10px">${esc(styleSummary(b))}</div>` : '<div class="note">暂无经理信息</div>'}
      </div>
      ${m && m.power ? `<div class="card"><div class="card-title">能力评分</div><div id="dRadar" class="chart chart-sm"></div></div>` : ''}
      <div class="card"><div class="card-title">区间表现对比</div><div id="dPerf" class="chart chart-sm"></div></div>`;
    if (m && m.power) drawRadarInto('dRadar', m.power);
    drawPerfInto('dPerf', b.periods);
  }

  function drawRadarInto(id, power) {
    const el = $('#' + id);
    disposeChart(id);
    if (!power || !power.categories) return;
    const cats = power.categories.map((c, i) => c + '\n' + ((power.dsc && power.dsc[i]) || ''));
    const vals = String(power.avr || '').split(',').map(v => parseFloat(v));
    const inst = echarts.init(el);
    charts[id] = inst;
    inst.setOption({
      radar: {
        indicator: cats.map(c => ({ name: c, max: 100 })),
        axisName: { color: T().muted, fontSize: 9 },
        splitLine: { lineStyle: { color: T().lineSoft } }
      },
      series: [{ type: 'radar', data: [{ value: vals, name: '能力评分', areaStyle: { color: 'rgba(56,189,248,.25)' }, lineStyle: { color: T().accent } }] }]
    });
  }

  function drawPerfInto(id, periods) {
    const el = $('#' + id);
    disposeChart(id);
    const keys = ['1w', '1m', '3m', '6m', '1y', 'ytd'];
    const labels = ['近1周', '近1月', '近3月', '近半年', '近1年', '今年来'];
    const inst = echarts.init(el);
    charts[id] = inst;
    inst.setOption({
      color: [T().accent, T().muted, '#fbbf24'],
      grid: { left: 8, right: 16, top: 26, bottom: 8, containLabel: true },
      tooltip: { confine: true, hideDelay: 50, trigger: 'axis', valueFormatter: v => fmtPct(v) },
      legend: { top: 0, textStyle: { color: T().muted, fontSize: 10 }, data: ['本基金', '同类平均'] },
      xAxis: { type: 'category', data: labels, axisLabel: { color: T().muted, fontSize: 10 } },
      yAxis: { type: 'value', axisLabel: { formatter: v => v + '%', color: T().muted }, splitLine: { lineStyle: { color: T().lineSoft } } },
      series: [
        { name: '本基金', type: 'bar', data: keys.map(k => (periods[k] || {}).ret), barMaxWidth: 18, itemStyle: { borderRadius: [4, 4, 0, 0] } },
        { name: '同类平均', type: 'line', data: keys.map(k => (periods[k] || {}).avg), showSymbol: false, lineStyle: { type: 'dashed' } }
      ]
    });
  }

  let closingViaPop = false;
  function closeDetail() {
    $('#detail').classList.remove('show');
    state.detailCode = null;
    hideAllTips();
    for (const k of ['detailChart', 'dRankChart', 'dPerfTrendChart', 'dSharesChart', 'dHolderChart', 'dMonthlyChart', 'dDDChart', 'dRadar', 'dPerf']) disposeChart(k);
    if (!closingViaPop && history.state && history.state.detail) {
      try { history.back(); } catch (e) { /* ignore */ }
    }
  }

  // ================= 通用 =================
  function disposeChart(id) {
    if (charts[id]) { charts[id].dispose(); delete charts[id]; }
  }

  function hideAllTips() {
    for (const k of Object.keys(charts)) {
      try { charts[k].dispatchAction({ type: 'hideTip' }); } catch (e) { /* ignore */ }
    }
  }

  function resolveTheme(theme) {
    if (theme === 'auto' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return theme;
  }

  function applyTheme(theme, persist) {
    if (persist) LS.set('gfc:theme', theme);
    state.themePref = theme;
    document.documentElement.dataset.theme = resolveTheme(theme);
    document.querySelectorAll('#themeChips .chip').forEach(c => c.classList.toggle('active', c.dataset.theme === theme));
    for (const k of Object.keys(charts)) disposeChart(k);
    renderAll();
  }

  function bindFundRows(container) {
    container.querySelectorAll('.fund-row[data-code]').forEach(row => row.onclick = () => openDetail(row.dataset.code));
  }

  function renderAll() {
    try {
      renderBoard();
      renderUpdateStatus();
      renderTrend();
      renderHoldings();
      renderSettings();
      updateHeader();
    } catch (e) {
      window.__renderErr = (e && e.stack) ? e.stack : String(e);
      console.error('渲染错误', e);
    }
  }

  function updateHeader() {
    const meta = LS.get('gfc:meta', null);
    const funds = [...state.bundles.values()];
    const latestDate = funds.reduce((m, b) => !m || (b.navDate > m) ? b.navDate : m, null);
    let txt = '';
    if (meta && meta.updatedAt) txt += '更新于 ' + new Date(meta.updatedAt).toLocaleString('zh-CN', { hour12: false });
    if (latestDate) txt += (txt ? ' ｜ ' : '') + '净值截至 ' + latestDate;
    if (!txt) txt = '数据加载中…';
    if (state.refreshing) {
      const n = state.funds.length;
      const done = state.funds.filter(f => state.bundles.has(f.code)).length;
      txt = '正在更新 ' + Math.min(done + 1, n) + '/' + n + ' …';
    }
    $('#updatedAt').textContent = txt;
  }

  // ================= 页面导航（支持返回键） =================
  function pushNav(stateObj) {
    try { history.pushState(stateObj, ''); } catch (e) { /* ignore */ }
  }

  function switchTab(name) {
    if (name !== state.currentTab) pushNav({ tab: name });
    switchTabUI(name);
  }

  function switchTabUI(name) {
    state.currentTab = name;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.panel === name));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
    hideAllTips();
    if (name === 'settings') setTimeout(() => { const i = $('#searchInput'); if (i) i.focus(); }, 80);
    requestAnimationFrame(() => {
      for (const id of ['boardChart', 'trendChart', 'corrChart', 'fitChart', 'fitTrendChart', 'marketPie', 'industryPie', 'allocChart']) {
        if (charts[id]) charts[id].resize();
      }
    });
  }

  window.addEventListener('popstate', e => {
    const st = e.state || {};
    if (state.stockCode) {
      closingViaPop = true;
      closeStock();
      closingViaPop = false;
      return;
    }
    if (state.detailCode) {
      closingViaPop = true;
      closeDetail();
      closingViaPop = false;
      return;
    }
    if (st.tab) switchTabUI(st.tab);
  });

  // ================= 下拉刷新 =================
  function bindPullRefresh() {
    if (!('ontouchstart' in window)) return;
    const indicator = document.createElement('div');
    indicator.className = 'pull-indicator';
    indicator.innerHTML = '<span class="pull-txt">下拉刷新</span>';
    document.body.appendChild(indicator);
    const txt = indicator.querySelector('.pull-txt');
    const PULL_MAX = 90;
    const PULL_THRESHOLD = 62;
    let startY = 0, active = false, pulling = false, pullDist = 0;
    document.addEventListener('touchstart', e => {
      if (window.scrollY <= 0 && !state.refreshing && e.touches.length === 1) {
        startY = e.touches[0].clientY;
        active = true;
        pullDist = 0;
      } else {
        active = false;
      }
    }, { passive: true });
    document.addEventListener('touchmove', e => {
      if (!active) return;
      const dy = e.touches[0].clientY - startY;
      if (dy > 0 && window.scrollY <= 0) {
        pulling = true;
        const dist = Math.min(dy * 0.45, PULL_MAX);
        pullDist = dist;
        indicator.style.transform = 'translateY(' + (dist - 62) + 'px)';
        indicator.classList.add('show');
        txt.textContent = dist >= PULL_THRESHOLD ? '松开刷新' : '下拉刷新';
        if (e.cancelable) e.preventDefault();
      } else if (dy <= 0) {
        pulling = false;
        pullDist = 0;
        indicator.classList.remove('show');
        indicator.style.transform = '';
      }
    }, { passive: false });
    document.addEventListener('touchend', () => {
      if (!active) return;
      active = false;
      if (!pulling) return;
      pulling = false;
      const dist = pullDist;
      pullDist = 0;
      indicator.classList.remove('show');
      indicator.style.transform = '';
      if (dist >= PULL_THRESHOLD && !state.refreshing) {
        txt.textContent = '刷新中…';
        indicator.classList.add('show');
        indicator.style.transform = 'translateY(0px)';
        refreshAll(true).finally(() => {
          indicator.classList.remove('show');
          indicator.style.transform = '';
        });
      }
    }, { passive: true });
  }

  function init() {
    try { history.replaceState({ tab: 'board' }, ''); } catch (e) { /* ignore */ }
    const savedTheme = LS.get('gfc:theme', 'dark');
    state.themePref = savedTheme;
    document.documentElement.dataset.theme = resolveTheme(savedTheme);
    document.querySelectorAll('#themeChips .chip').forEach(c => c.classList.toggle('active', c.dataset.theme === savedTheme));
    document.querySelectorAll('#themeChips .chip').forEach(c => c.onclick = () => applyTheme(c.dataset.theme, true));
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onThemeChange = () => { if (state.themePref === 'auto') applyTheme('auto', false); };
      if (mq.addEventListener) mq.addEventListener('change', onThemeChange);
      else if (mq.addListener) mq.addListener(onThemeChange);
    }

    // 先绑定所有交互，保证任何时候都能切换页面、操作按钮
    $('#btnRefreshAll').onclick = () => refreshAll(true);
    $('#btnGoAdd').onclick = () => switchTab('settings');
    $('#btnClearCache').onclick = () => {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('gfc:')) keys.push(k);
      }
      keys.forEach(k => localStorage.removeItem(k));
      state.bundles.clear();
      saveFunds();
      renderAll();
      toast('本地缓存已清空');
    };
    $('#btnBackup').onclick = openBackup;
    $('#btnRestore').onclick = openRestore;
    $('#backupCopy').onclick = copyBackupText;
    $('#backupDownload').onclick = downloadBackup;
    $('#restoreConfirm').onclick = restoreBackup;
    $('#backupClose').onclick = closeBackup;
    $('#backup').onclick = e => { if (e.target === $('#backup')) closeBackup(); };
    bindSearch();
    bindHoldShot();
    document.querySelectorAll('.tab').forEach(tab => tab.onclick = () => switchTab(tab.dataset.panel));
    bindPullRefresh();
    window.addEventListener('resize', () => {
      for (const k of Object.keys(charts)) if (charts[k]) charts[k].resize();
    });

    // 数据加载（失败也不影响页面交互）
    updateIndices();
    try {
      if (LS.get('gfc:version') !== APP_VERSION) {
        // 版本升级迁移：清除旧版"快捷添加预设"遗留的分组名，保留基金与自定义分组
        const oldPresetGroups = ['科技互联网', '全球精选', '美股指数', '主题行业', '亚洲大中华'];
        let changed = false;
        for (const f of state.funds) {
          if (oldPresetGroups.includes(f.group)) { f.group = ''; changed = true; }
        }
        if (changed) saveFunds();
        LS.set('gfc:version', APP_VERSION);
      }
      for (const f of state.funds) {
        const b = bundleFromCache(f.code);
        if (b) state.bundles.set(f.code, b);
      }
      renderAll();
      if (!state.bundles.size) {
        refreshAll(true);
      } else {
        const stale = state.funds.some(f => !bundleFresh(state.bundles.get(f.code)));
        if (stale) refreshAll(false);
        estimateFundsAndSave();
        checkNavUpdates();
      }
    } catch (e) {
      console.error('初始化数据失败', e);
    }

    setInterval(() => {
      if (!state.refreshing && state.funds.some(f => !bundleFresh(state.bundles.get(f.code)))) refreshAll(false);
    }, 30 * 60 * 1000);
    setInterval(() => { quickRefreshTick(); }, QUICK_TICK_MS);
    setInterval(() => { if (!state.refreshing) estimateFundsAndSave(); }, 60 * 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
