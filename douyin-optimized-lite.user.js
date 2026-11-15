// ==UserScript==
// @name         抖音优化 · 精简版（记住选择画质 + 自定义视频过滤器）
// @namespace    https://github.com/WhiteSevs/TamperMonkeyScript
// @version      1.0.0
// @author       WhiteSevs (原作者) / 重构：仅保留两项功能
// @description  从「抖音优化」重构：仅保留【记住选择画质】与【自定义视频过滤器】，其余功能全部剔除。零外部依赖，规则格式与原版兼容。
// @license      GPL-3.0-only
// @supportURL   https://github.com/WhiteSevs/TamperMonkeyScript/issues
// @match        *://*.douyin.com/*
// @match        *://*.iesdouyin.com/*
// @exclude      *://creator.douyin.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

/**
 * 重构说明
 * ----------
 * 原脚本 dist 为 vite 打包产物（685KB / 309 个设置项）。本文件按官方 TypeScript 源码
 * （scripts-vite/抖音优化/src/main/video/player/DouYinVideoPlayer.ts、
 *   scripts-vite/抖音优化/src/main/video/filter/DouYinVideoFilter.ts、
 *   scripts-vite/抖音优化/src/main/video/filter/DouYinVideoFilterBase.ts）
 * 的逻辑重写，只保留两项功能：
 *
 *   A. 记住选择画质
 *      - 官方实现：把画质配置写入 sessionStorage["MANUAL_SWITCH"]，抖音播放器读取该值。
 *      - 本版：GM 持久化记忆，页面加载/路由切换时自动恢复；并监听播放器画质菜单的
 *        手动点击，把用户选择记下来，下次自动应用。
 *   B. 自定义视频过滤器
 *      - 官方实现：ajaxHooker 拦截推荐/关注/搜索等接口响应，解析 aweme_list，
 *        按自定义规则（属性名 + 正则/比较/自定义函数 + 作用域）移除命中视频。
 *      - 本版：自实现 XHR + fetch 拦截，规则结构、存储键、匹配语义与原版一致，
 *        支持原版规则 JSON 导入导出。
 *
 * 已剔除：伪装登录、快捷键、屏蔽元素、下载解析、背景色、
 *         倍速、全屏/沉浸模式、手机模式、直播优化、{...} 解析按钮、
 *         仅显示被过滤的视频、发送不感兴趣请求等全部其它功能。
 *
 * 规则存储键沿用原版：dy-video-filter-rule（数组）
 *
 * v1.0.0 综合版：
 *   - 记住选择画质（官方 MANUAL_SWITCH 路径）+ 解锁更高画质（降级自动强制回目标档位）
 *   - 自定义视频过滤器（21 条规则，覆盖广告/带货/引流/关键词/结构化字段/自定义函数）
 *   - 屏蔽统计（按规则累计，sessionStorage 存储，关闭标签页/浏览器自动清零）
 *   - 预加载下一条视频（按原始请求方法 GET/POST 发预加载请求，结果按 URL 缓存）
 *   - 性能：正则编译缓存、规则内存缓存、统计写入合并、滚动分页全同步过滤
 *   - 画质记忆改为监听 sessionStorage["MANUAL_SWITCH"]（官方 chooseQuality 路径），
 *     hook Storage.setItem + 1.5s 轮询 + 宽松点击文本兜底；不再依赖直播间 DOM 选择器。
 *   - 任何策略下都记录用户手动选择；面板显示「播放器实际值」「操作结果」（持久，不靠 toast）。
 *   - 「立即应用」回读 sessionStorage 校验，明确提示「切换视频或刷新后生效」，并加「刷新页面生效」按钮。
 *   - 面板标题带版本号，便于确认已更新。
 */

(function () {
  "use strict";

  var win = typeof unsafeWindow !== "undefined" && unsafeWindow ? unsafeWindow : window;
  var doc = win.document;
  var LOG = "[抖音优化·精简版] ";

  /* =======================================================================
   * 0. 常量与存储
   * ===================================================================== */

  var KEY = {
    rules: "dy-video-filter-rule", // 与原版一致，可直接迁移旧规则
    filterEnable: "shieldVideo-exec-network-enable", // 与原版一致
    qualityMode: "dy-refactor-quality-mode", // remember | force | off
    qualityForced: "dy-refactor-quality-forced", // 强制档位 gearType
    qualityRemembered: "dy-refactor-quality-remembered", // 记住的手动选择 gearType
    qualityRememberedAt: "dy-refactor-quality-remembered-at",
    stats: "dy-refactor-filter-stats"
  }

  var SCRIPT_VERSION = "1.0.0"; // 面板标题版本号：发版时同步更新
  var unlockQuality = false; // v1.0.17：解锁更高画质开关;

  var QUALITY_SESSION_KEY = "MANUAL_SWITCH";

  function gv(key, def) {
    try {
      var v = GM_getValue(key, def);
      return v === undefined || v === null ? def : v;
    } catch (e) {
      return def;
    }
  }
  function sv(key, val) {
    try {
      GM_setValue(key, val);
    } catch (e) {
      console.warn(LOG + "GM_setValue 失败", key, e);
    }
  }
  function log() {
    try {
      console.log.apply(console, [LOG].concat([].slice.call(arguments)));
    } catch (e) {}
  }
  function warn() {
    try {
      console.warn.apply(console, [LOG].concat([].slice.call(arguments)));
    } catch (e) {}
  }

  /* --- 屏蔽统计（v1.0.5）：按规则累计移除数，GM 持久化 --- */
  var statsMenuRefresher = null;
  var statsMemory = null;
  var statsDirty = false;
  var statsFlushTimer = null;
  /* v1.0.12：统计改存 sessionStorage —— 刷新页面保留，关闭标签页/浏览器自动清零 */
  function statsStoreGet() {
    try {
      var raw = win.sessionStorage.getItem(KEY.stats);
      if (!raw) return null;
      var s = JSON.parse(raw);
      return (s && typeof s === "object" && s.byRule && typeof s.byRule === "object") ? s : null;
    } catch (e) { return null; }
  }
  function statsStoreSet(s) {
    try { win.sessionStorage.setItem(KEY.stats, JSON.stringify(s)); } catch (e) {}
  }
  function statsStoreClear() {
    try { win.sessionStorage.removeItem(KEY.stats); } catch (e) {}
  }
  function getStats() {
    if (statsMemory) return statsMemory;
    statsMemory = statsStoreGet() || { total: 0, byRule: {} };
    return statsMemory;
  }
  function flushStats() {
    if (statsDirty && statsMemory) statsStoreSet(statsMemory);
    statsDirty = false;
    statsFlushTimer = null;
  }
  function addStats(uuids) {
    if (!uuids || !uuids.length) return;
    var s = getStats();
    for (var i = 0; i < uuids.length; i++) {
      var k = uuids[i] || "unknown";
      s.total++;
      s.byRule[k] = (s.byRule[k] || 0) + 1;
    }
    statsDirty = true;
    if (!statsFlushTimer) statsFlushTimer = setTimeout(flushStats, 800);
    if (typeof statsMenuRefresher === "function") { try { statsMenuRefresher(); } catch (e) {} }
  }
  function statsEntries() {
    var s = getStats();
    var nameMap = {};
    var rules = getRules();
    for (var i = 0; i < rules.length; i++) nameMap[rules[i].uuid || rules[i].name] = rules[i].name || rules[i].uuid;
    var entries = [];
    for (var k in s.byRule) {
      if (Object.prototype.hasOwnProperty.call(s.byRule, k)) entries.push([nameMap[k] || k, s.byRule[k]]);
    }
    entries.sort(function (a, b) { return b[1] - a[1]; });
    return { total: s.total, entries: entries };
  }
  function shortRuleName(name) {
    var s = String(name || "").replace(/^屏蔽/, "").replace(/（[^）]*）$/, "").split("/")[0];
    return s.slice(0, 4);
  }
  function statsMenuLabel() {
    var st = statsEntries();
    return "已屏蔽 " + st.total + " 条（点击查看完整明细）";
  }
  function renderStatsTab() {
    var box = el("dy-rf-tab-stats");
    if (!box) return;
    var st = statsEntries();
    var html;
    if (!st.total) {
      html = '<p class="hint" style="margin-left:0">暂无屏蔽记录。启用过滤器后刷几屏抖音，这里会按规则累计被移除的视频数。</p>';
    } else {
      var chips = [];
      for (var j = 0; j < st.entries.length; j++) {
        chips.push('<span style="display:inline-block;margin:3px 8px 3px 0;padding:4px 10px;background:#f7f8fa;border:1px solid #e5e6eb;border-radius:5px;font:13px sans-serif;color:#1d2129">' + esc(st.entries[j][0]) + " <b>×" + st.entries[j][1] + "</b></span>");
      }
      html = '<div style="font:14px sans-serif;margin:4px 0 10px">累计已屏蔽 <b style="font-size:24px;color:#f53f3f">' + st.total + "</b> 条视频</div>" +
        '<div style="line-height:2">' + chips.join("") + "</div>" +
        '<p class="hint">统计按规则 uuid 累计（存于本标签页 sessionStorage：刷新保留，关闭标签页/浏览器自动清零）。新增或改名规则会自动反映；删除规则后其历史计数仅显示 uuid。</p>' +
        '<div style="margin-top:10px"><button class="btn sm danger" data-act="stats-reset">统计清零</button></div>';
    }
    box.innerHTML = html;
  }
  function buildStatsHtml() {
    var st = statsEntries();
    if (!st.total) return '<p class="hint" style="margin-left:0">暂无屏蔽记录（打开抖音刷几屏后出现）。</p>';
    var chips = [];
    for (var j = 0; j < st.entries.length; j++) {
      chips.push('<span style="display:inline-block;margin:2px 6px 2px 0;padding:2px 8px;background:#f7f8fa;border:1px solid #e5e6eb;border-radius:4px;font:12px sans-serif;color:#4e5969">' + esc(st.entries[j][0]) + " ×" + st.entries[j][1] + "</span>");
    }
    return '<div style="margin-bottom:6px">累计 <b>' + st.total + "</b> 条</div>" + chips.join("") +
      '<div style="margin-top:6px"><button class="btn sm danger" data-act="stats-reset">统计清零</button></div>';
  }

  /** 画质档位定义：完全照抄官方 chooseQuality() 的 definition 数组 */
  var QUALITY_DEFINITIONS = [
    {
      done: 1, gearClarity: "20", qualityType: 72, gearName: "超清 4K", gearType: -2,
      clarityReal: ["adapt_lowest_4_1", "normal_1080_0", "adapt_lowest_1440_1", "low_720_0", "normal_720_0", "low_540_0", "normal_540_0", "adapt_lowest_1080_1", "lower_540_0", "adapt_low_540_0", "720_2_1", "540_2_1", "540_3_1"]
    },
    {
      done: 1, gearClarity: "10", qualityType: 7, gearName: "超清 2K", gearType: -1,
      clarityReal: ["adapt_lowest_4_1", "normal_1080_0", "adapt_lowest_1440_1", "low_720_0", "normal_720_0", "low_540_0", "normal_540_0", "adapt_lowest_1080_1", "lower_540_0", "adapt_low_540_0", "720_2_1", "540_2_1", "540_3_1"]
    },
    {
      done: 1, gearClarity: "5", gearName: "高清 1080P", gearType: 1, qualityType: 1,
      clarityReal: ["normal_1080_0", "normal_1080_0", "normal_720_0", "low_720_0", "normal_540_0", "low_720_0", "low_540_0", "low_540_0", "lower_540_0", "adapt_low_540_0", "adapt_low_540_0", "adapt_lowest_1080_1", "720_2_1", "720_2_1", "720_3_1", "540_2_1", "720_3_1", "540_2_1", "720_4_1", "720_4_1", "540_3_1", "540_3_1"]
    },
    {
      done: 1, gearClarity: "4", gearName: "高清 720P", gearType: 2, qualityType: 10,
      clarityReal: ["normal_1080_0", "normal_1080_0", "normal_720_0", "low_720_0", "normal_540_0", "low_720_0", "low_540_0", "low_540_0", "lower_540_0", "adapt_low_540_0", "adapt_low_540_0", "adapt_lowest_1080_1", "720_2_1", "720_2_1", "720_3_1", "540_2_1", "720_3_1", "540_2_1", "720_4_1", "720_4_1", "540_3_1", "540_3_1"]
    },
    {
      done: 1, gearClarity: "3", gearName: "标清 540P", gearType: 3, qualityType: 20,
      clarityReal: ["normal_1080_0", "normal_1080_0", "normal_720_0", "low_720_0", "normal_540_0", "low_720_0", "low_540_0", "low_540_0", "lower_540_0", "adapt_low_540_0", "adapt_low_540_0", "adapt_lowest_1080_1", "720_2_1", "720_2_1", "720_3_1", "540_2_1", "720_3_1", "540_2_1", "720_4_1", "720_4_1", "540_3_1", "540_3_1"]
    },
    { done: 1, gearClarity: "2", gearName: "极速", gearType: 4, qualityType: 21 },
    {
      done: 1, gearClarity: "0", gearName: "智能", gearType: 0,
      clarityReal: ["normal_1080_0", "normal_1080_0", "normal_720_0", "low_720_0", "normal_540_0", "low_720_0", "low_540_0", "low_540_0", "lower_540_0", "adapt_low_540_0", "adapt_low_540_0", "adapt_lowest_1080_1", "720_2_1", "720_2_1", "720_3_1", "540_2_1", "720_3_1", "540_2_1", "720_4_1", "720_4_1", "540_3_1", "540_3_1"]
    },
    { done: -999, gearClarity: "-999", gearName: "无", gearType: -999 }
  ];

  function getQualityDefinition(gearType) {
    for (var i = 0; i < QUALITY_DEFINITIONS.length; i++) {
      if (QUALITY_DEFINITIONS[i].gearType === gearType) return QUALITY_DEFINITIONS[i];
    }
    return null;
  }

  /* =======================================================================
   * 1. 功能 A：记住选择画质
   * ===================================================================== */

  /**
   * 写入 sessionStorage.MANUAL_SWITCH（官方路径）。
   * 官方用 200ms 间隔写 1 秒，避免被抖音自身逻辑覆盖 —— 此处保持一致。
   */
  function applyQuality(gearType) {
    var def = getQualityDefinition(gearType);
    if (!def || def.gearName === "无") return false;
    try {
      var store = win.sessionStorage;
      var payload = JSON.stringify({
        done: def.done,
        gearClarity: def.gearClarity,
        qualityType: def.qualityType,
        gearName: def.gearName,
        gearType: def.gearType,
        clarityReal: def.clarityReal || []
      });
      var write = function () {
        try {
          var cur = store.getItem(QUALITY_SESSION_KEY);
          if (cur !== payload) {
            qualitySelfWrite = true;
            try { store.setItem(QUALITY_SESSION_KEY, payload); }
            finally { qualitySelfWrite = false; }
          }
          lastQualityRaw = payload;
        } catch (e) {}
      };
      write();
      var intervalId = setInterval(write, 200);
      setTimeout(function () { clearInterval(intervalId); }, 1000);
      log("已应用画质：" + def.gearName);
      return true;
    } catch (e) {
      warn("写入 MANUAL_SWITCH 失败", e);
      return false;
    }
  }

  /** 按当前配置决定要应用的档位；返回 null 表示不干预 */
  function resolveQualityGearType() {
    var mode = gv(KEY.qualityMode, "remember");
    if (mode === "off") return null;
    if (mode === "force") return gv(KEY.qualityForced, -2);
    var remembered = gv(KEY.qualityRemembered, null);
    return remembered === null || remembered === undefined ? null : remembered;
  }

  function runQuality() {
    var gt = resolveQualityGearType();
    if (gt === null) return;
    applyQuality(gt);
  }

  /** 从画质菜单文本推断 gearType */
  function guessGearTypeFromText(text) {
    if (typeof text !== "string") return null;
    var t = text.replace(/\s+/g, "").toUpperCase();
    if (t.indexOf("4K") !== -1) return -2;
    if (t.indexOf("2K") !== -1) return -1;
    if (t.indexOf("1080") !== -1) return 1;
    if (t.indexOf("720") !== -1) return 2;
    if (t.indexOf("540") !== -1) return 3;
    if (t.indexOf("极速") !== -1) return 4;
    if (t.indexOf("智能") !== -1 || t.indexOf("自动") !== -1 || t.indexOf("默认") !== -1) return 0;
    return null;
  }

  /* -----------------------------------------------------------------------
   * 画质记忆（v1.0.2 重写）
   *
   * 官方 chooseQuality() 把清晰度写入 sessionStorage["MANUAL_SWITCH"]，
   * 抖音播放器在【用户手动切换画质】时同样会写这个 key —— 这是唯一稳定、
   * 与 DOM 无关的信号。v1.0.1 误用了直播间的 [data-e2e="quality-selector"]
   * 选择器（点播视频画质控件只是一个普通 <div>高清 720P</div>），
   * 导致手动切换永远识别不到。这里改为 hook Storage.setItem + 低频轮询，
   * 再用宽松点击文本匹配兜底。
   * --------------------------------------------------------------------- */
  var qualitySelfWrite = false;
  var lastQualityRaw = null;

  /** 解析 MANUAL_SWITCH 的值 -> gearType */
  function parseQualityFromStorage(v) {
    if (v === null || v === undefined) return null;
    var raw = String(v);
    var obj = null;
    try { obj = JSON.parse(raw); } catch (e) {}
    var gt = null;
    if (obj && typeof obj === "object") {
      if (typeof obj.gearType === "number") gt = obj.gearType;
      if (gt === null && obj.gearName) gt = guessGearTypeFromText(String(obj.gearName));
      if (gt === null && obj.gearClarity) gt = guessGearTypeFromText(raw);
    }
    if (gt === null) gt = guessGearTypeFromText(raw);
    return getQualityDefinition(gt) ? gt : null;
  }

  /** 记住用户手动选择的画质（任何策略下都记录，但不改变当前策略） */
  function rememberManualQuality(gt, source) {
    if (gt === null || !getQualityDefinition(gt)) return false;
    if (gv(KEY.qualityRemembered, null) === gt) return false;
    sv(KEY.qualityRemembered, gt);
    sv(KEY.qualityRememberedAt, Date.now());
    log("已记住手动画质：" + getQualityDefinition(gt).gearName + "（来源：" + source + "）");
    return true;
  }

  /** hook sessionStorage.setItem，抖音写 MANUAL_SWITCH 时立即捕获 */
  function hookQualityStorage() {
    try {
      var ss = win.sessionStorage;
      var proto = ss && Object.getPrototypeOf(ss);
      if (!proto || proto.__dyQualityHooked) return;
      var rawSet = proto.setItem;
      proto.setItem = function (k, v) {
        if (String(k) === QUALITY_SESSION_KEY && !qualitySelfWrite) {
          try {
            lastQualityRaw = String(v);
            var gt = parseQualityFromStorage(v);
            if (gt !== null) rememberManualQuality(gt, "播放器写入");
          } catch (e) {}
        }
        return rawSet.apply(this, arguments);
      };
      proto.__dyQualityHooked = true;
    } catch (e) {
      warn("hook MANUAL_SWITCH 失败", e);
    }
  }

  /** 轮询兜底：防止抖音绕过 setItem（如直接属性赋值 / 跨 frame 写入） */
  function pollQualityStorage() {
    try {
      var v = win.sessionStorage.getItem(QUALITY_SESSION_KEY);
      if (v && v !== lastQualityRaw) {
        lastQualityRaw = v;
        var gt = parseQualityFromStorage(v);
        if (gt !== null) rememberManualQuality(gt, "sessionStorage 变化");
      }
    } catch (e) {}
  }

  /** 兜底：点击画质菜单项（宽松文本匹配，排除设置面板自身） */
  function installQualityMenuWatcher() {
    win.addEventListener("click", function (e) {
      var t = e.target;
      if (!t || !t.closest || t.closest("#dy-rf-mask")) return;
      var node = t.closest("div,span,li,p,button");
      if (!node) return;
      var text = (node.textContent || "").trim();
      if (!text || text.length > 20) return;
      var gt = guessGearTypeFromText(text);
      if (gt === null) return;
      rememberManualQuality(gt, "点击画质菜单");
    }, true);
  }

  function initQuality() {
    hookQualityStorage();
    installQualityMenuWatcher();
    // 页面已存在的 MANUAL_SWITCH（上次会话/抖音自己写入）作为基线并记住
    try {
      var existing = win.sessionStorage.getItem(QUALITY_SESSION_KEY);
      if (existing) {
        lastQualityRaw = existing;
        var gt0 = parseQualityFromStorage(existing);
        if (gt0 !== null) rememberManualQuality(gt0, "页面已有画质配置");
      }
    } catch (e) {}
    setInterval(pollQualityStorage, 1500);

    runQuality(); // document-start 立即写一次
    if (doc.readyState === "loading") {
      doc.addEventListener("DOMContentLoaded", runQuality, { once: true });
    } else {
      runQuality();
    }
    win.addEventListener("load", runQuality, { once: true });
    // SPA 路由变化后重写一次
    win.addEventListener("popstate", function () { setTimeout(runQuality, 300); });
    var rawPush = win.history && win.history.pushState;
    if (typeof rawPush === "function") {
      win.history.pushState = function () {
        var r = rawPush.apply(this, arguments);
        setTimeout(runQuality, 300);
        return r;
      };
    }
    var rawReplace = win.history && win.history.replaceState;
    if (typeof rawReplace === "function") {
      win.history.replaceState = function () {
        var r = rawReplace.apply(this, arguments);
        setTimeout(runQuality, 300);
        return r;
      };
    }
  }

  /* =======================================================================
   * 2. 功能 B：自定义视频过滤器 —— 字段解析
   * ===================================================================== */

  function toJSON(str) {
    if (typeof str === "object") return str;
    try { return JSON.parse(str); } catch (e) { return {}; }
  }
  function isObj(v) { return typeof v === "object" && v !== null; }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function str(v) { return v === undefined || v === null ? "" : String(v); }

  /** 规则可用属性名（与官方模板 / ScriptCat 文档一致，含别名字段） */
  var ATTRIBUTE_KEYS = [
    "awemeId", "nickname", "uid", "desc", "originDesc", "createTime", "width", "height",
    "textExtra", "videoTag", "videoTagId", "suggestWord",
    "musicAlbum", "musicAuthor", "musicDuration", "musicTitle", "musicUrl", "musicBackUrlList",
    "authorAccountCertInfo", "authorCustomVerify", "authorEnterpriseVerifyReason", "riskInfoContent",
    "seriesName", "seriesInfoName", "seriesContentTypes", "seriesInfoContentTypes",
    "mixInfoName", "mixInfoDesc", "collectCount", "commentCount", "diggCount", "shareCount",
    "duration", "liveStreamRoomId", "liveStreamRoomTitle", "liveStreamNickName",
    "liveStreamRoomUserCount", "liveStreamRoomDynamicSpliceLabel", "productId", "productTitle",
    "videoBitRateList", "pictureList",
    "isFollow", "isLive", "isAds", "isSeriesInfo", "isMixInfo", "isPicture", "isProduct", "isAigc"
  ];

  var SCOPE_KEYS = [
    "all", "xhr-tab", "xhr-userHome", "xhr-mix", "xhr-related", "xhr-follow",
    "xhr-familiar", "xhr-module", "xhr-search", "xhr-video", "xhr-channel"
  ];

  function templateInfo() {
    return {
      isFollow: false, isLive: false, isAds: false, isSeriesInfo: false, isMixInfo: false,
      isPicture: false, isProduct: false, isAigc: false,
      awemeId: undefined, nickname: undefined, createTime: undefined, uid: undefined,
      desc: undefined, originDesc: undefined, width: 0, height: 0,
      textExtra: [], videoTag: [], videoTagId: [], suggestWord: [],
      musicAlbum: undefined, musicAuthor: undefined, musicDuration: undefined,
      musicTitle: undefined, musicUrl: undefined, musicBackUrlList: [],
      authorAccountCertInfo: "", authorCustomVerify: "", authorEnterpriseVerifyReason: "",
      riskInfoContent: undefined,
      seriesName: undefined, seriesInfoName: undefined,
      seriesContentTypes: [], seriesInfoContentTypes: [],
      mixInfoName: undefined, mixInfoDesc: undefined,
      collectCount: 0, commentCount: 0, diggCount: 0, shareCount: 0, duration: undefined,
      liveStreamRoomId: undefined, liveStreamRoomTitle: undefined, liveStreamNickName: undefined,
      liveStreamRoomUserCount: undefined, liveStreamRoomDynamicSpliceLabel: undefined,
      productId: undefined, productTitle: undefined,
      videoBitRateList: [], pictureList: []
    };
  }

  /**
   * 解析接口返回的单个 aweme -> 规则可匹配的字典。
   * 字段映射严格按官方 parseAwemeInfoDictData(network) 实现。
   */
  function parseAwemeInfo(aweme) {
    var d = templateInfo();
    if (!isObj(aweme)) return d;
    // 供自定义函数使用：data.awemeInfo 拿到接口原始结构（不可枚举，避免被规则属性误匹配）
    Object.defineProperty(d, "__rawAweme", { value: aweme, enumerable: false, configurable: true, writable: true });

    var author = aweme.author || {};
    var statistics = aweme.statistics || {};
    var video = aweme.video || {};
    var music = aweme.music || {};

    d.nickname = str(author.nickname);
    d.uid = str(author.uid);
    d.desc = str(aweme.desc);
    d.originDesc = d.desc.replace(/ #(.+) /g, "").replace(/#(.+)/g, "");
    d.width = typeof video.width === "number" ? video.width : 0;
    d.height = typeof video.height === "number" ? video.height : 0;
    d.musicAlbum = music.album;
    d.musicAuthor = music.author;
    d.musicDuration = music.duration === undefined ? 0 : music.duration;
    d.musicTitle = music.title;
    d.collectCount = statistics.collect_count || 0;
    d.commentCount = statistics.comment_count || 0;
    d.diggCount = statistics.digg_count || 0;
    d.shareCount = statistics.share_count || 0;
    d.duration = video.duration;
    d.awemeId = aweme.aweme_id;
    d.authorCustomVerify = author.custom_verify || "";
    d.authorEnterpriseVerifyReason = author.enterprise_verify_reason || "";
    d.authorAccountCertInfo = author.account_cert_info || "";
    d.isPicture = aweme.aweme_type === 68;
    // AIGC 判定（接口结构化字段）：is_aigc_media 或非空 aigc_info（正常视频两者为 false/{}）
    d.isAigc = Boolean(aweme.is_aigc_media) || Boolean(aweme.aigc_info && typeof aweme.aigc_info === "object" && Object.keys(aweme.aigc_info).length > 0);
    d.isFollow = Boolean(author.follow_status);

    if (typeof aweme.create_time === "number") {
      d.createTime = aweme.create_time;
      if (d.createTime > 0 && d.createTime < 1000000000000) d.createTime *= 1000;
    }

    // 广告判定（官方三条件）
    var isAds = Boolean(aweme.is_ads);
    if (!isAds && typeof aweme.raw_ad_data === "string" && aweme.raw_ad_data.trim() !== "") isAds = true;
    if (!isAds && typeof aweme.web_raw_data === "string") {
      var webRaw = toJSON(aweme.web_raw_data);
      if (typeof webRaw.brand_ad === "string") {
        var brandAd = toJSON(webRaw.brand_ad);
        if (brandAd && brandAd.is_ad) isAds = true;
      }
    }
    d.isAds = isAds;

    // 直播间 cell_room
    if (isObj(aweme.cell_room)) {
      d.isLive = true;
      var raw = typeof aweme.cell_room.rawdata === "string" ? toJSON(aweme.cell_room.rawdata) : aweme.cell_room.rawdata;
      if (isObj(raw)) {
        var owner = raw.owner || {};
        d.liveStreamRoomId = typeof owner.web_rid === "string" ? owner.web_rid : undefined;
        d.liveStreamRoomTitle = typeof raw.title === "string" ? raw.title : undefined;
        d.liveStreamNickName = typeof owner.nickname === "string" ? owner.nickname : undefined;
        d.liveStreamRoomUserCount = typeof raw.user_count === "number" ? raw.user_count : undefined;
        var splice = raw.dynamic_label && raw.dynamic_label.splice_label;
        d.liveStreamRoomDynamicSpliceLabel = splice && typeof splice.text === "string" ? splice.text : undefined;
      }
    }

    // 话题
    arr(aweme.text_extra).forEach(function (it) {
      if (it && typeof it.hashtag_name === "string" && it.hashtag_name.trim() !== "") d.textExtra.push(it.hashtag_name);
    });
    // 视频标签
    arr(aweme.video_tag).forEach(function (it) {
      if (!it) return;
      if (typeof it.tag_name === "string" && it.tag_name.trim() !== "") d.videoTag.push(it.tag_name);
      if (typeof it.tag_id === "number" || typeof it.tag_id === "string") {
        var id = String(it.tag_id);
        if (id.trim() !== "" && id !== "0") d.videoTagId.push(id);
      }
    });
    // 建议词
    var suggest = aweme.suggest_words && aweme.suggest_words.suggest_words;
    arr(suggest).forEach(function (it) {
      arr(it && it.words).forEach(function (w) {
        if (w && typeof w.word === "string") d.suggestWord.push(w.word);
      });
    });

    // 音乐地址
    var playUrl = music.play_url || {};
    if (Array.isArray(playUrl.url_list) && playUrl.url_list.length) d.musicUrl = playUrl.url_list[0];
    d.musicBackUrlList = arr(playUrl.url_list).slice(1).filter(function (u) { return typeof u === "string"; });

    // 风险提示
    var risk = aweme.risk_infos;
    d.riskInfoContent = risk && typeof risk.content === "string" && risk.content.trim() !== "" ? risk.content : undefined;

    // 短剧 / 系列信息
    var series = aweme.series_info;
    if (isObj(series)) {
      if (typeof series.series_name === "string") d.seriesName = d.seriesInfoName = series.series_name;
      var types = series.series_content_types;
      if (Array.isArray(types)) {
        types.forEach(function (it) { if (it && it.name) { d.seriesContentTypes.push(it.name); d.seriesInfoContentTypes.push(it.name); } });
      }
      if (d.seriesName !== undefined && types !== undefined) d.isSeriesInfo = true;
    }
    // 合集 / 混合信息
    var mix = aweme.mix_info;
    if (isObj(mix)) {
      d.mixInfoName = mix.mix_name;
      d.mixInfoDesc = mix.desc;
      d.isMixInfo = true;
    }

    // 码率列表
    var bitRateList = video.bit_rate;
    if (Array.isArray(bitRateList)) {
      d.videoBitRateList = bitRateList.map(function (item) {
        item = item || {};
        var pa = item.play_addr || {};
        var urlList = arr(pa.url_list).filter(function (u) { return typeof u === "string"; });
        var url = urlList[0] || "";
        if (url.indexOf("http:") === 0) url = url.slice(5);
        return {
          cover: (video.cover && arr(video.cover.url_list)[0]) || "",
          bitRate: item.bit_rate,
          dataSize: pa.data_size || 0,
          format: item.format,
          isH265: item.is_h265,
          fps: item.FPS,
          gearName: item.gear_name,
          qualityType: item.quality_type,
          width: pa.width,
          height: pa.height,
          url: url,
          backUrl: urlList.slice(1)
        };
      });
    }

    // 图文
    if (d.isPicture) {
      d.duration = undefined;
      d.pictureList = arr(aweme.images).map(function (it) {
        it = it || {};
        var list = Array.isArray(it.url_list) && it.url_list.length ? it.url_list : it.download_url_list || [];
        return { width: it.width, height: it.height, url: list[0], videoBitRateList: [] };
      });
    }

    // 商品 / 付费内容
    var product = aweme.product_info || aweme.product || {};
    if (isObj(product)) {
      if (product.product_id || product.id) { d.productId = String(product.product_id || product.id); d.isProduct = true; }
      if (product.title) d.productTitle = product.title;
    }

    return d;
  }

  /* =======================================================================
   * 3. 功能 B：规则匹配（语义与官方 checkFilterWithRule 一致）
   * ===================================================================== */

  var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  var functionCacheSync = new Map();
  var functionCacheAsync = new Map();

  /** 自定义函数上下文：兼容官方示例里的 this.log / this.utils / this.httpx */
  var FN_CONTEXT = {
    log: { info: log, success: log, error: warn, warn: warn },
    utils: {
      toJSON: toJSON,
      isNull: function (v) { return v === null || v === undefined; },
      isNotNull: function (v) { return v !== null && v !== undefined; }
    },
    httpx: {
      get: function (url) {
        return win.fetch(url).then(function (r) { return r.json().then(function (j) { return { data: j }; }); });
      },
      post: function (url, opt) {
        opt = opt || {};
        return win.fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(opt.data || {}) })
          .then(function (r) { return r.json().then(function (j) { return { data: j }; }); });
      }
    },
    Qmsg: { info: log, success: log, warning: warn, error: warn },
    pops: {},
    DOMUtils: {},
    window: win,
    unsafeWindow: win
  };

  /**
   * 编译自定义函数。
   * asyncMode=true 使用 AsyncFunction（对应官方 createFunction(..., true)），支持函数体里的 await；
   * asyncMode=false 使用普通 Function，供 XHR 同步 getter 路径使用。
   */
  function getCompiledFunction(body, asyncMode) {
    var cache = asyncMode ? functionCacheAsync : functionCacheSync;
    if (cache.has(body)) return cache.get(body);
    var fn;
    try {
      fn = asyncMode
        ? new AsyncFunction("data", '"use strict";\n' + body)
        : new Function("data", '"use strict";\n' + body);
      fn = fn.bind(FN_CONTEXT);
    } catch (e) {
      if (!asyncMode) {
        // 同步编译失败多半是函数体含 await；异步编译器能编译则静默跳过（XHR 路径不支持 await）
        try {
          new AsyncFunction("data", body);
        } catch (e2) {
          warn("自定义函数编译失败", e);
        }
      } else {
        warn("自定义函数编译失败", e);
      }
      fn = null;
    }
    cache.set(body, fn);
    return fn;
  }

  /** 正则匹配：官方为 String.prototype.match(字符串)，字符串会隐式转正则 */
  var regexCache = new Map();
  function testMatch(value, pattern) {
    if (pattern instanceof RegExp) return pattern.test(value);
    if (typeof pattern !== "string") return false;
    var re = regexCache.get(pattern);
    if (re === undefined) {
      try { re = new RegExp(pattern); } catch (e) { re = null; }
      regexCache.set(pattern, re);
    }
    if (re === null) return value.indexOf(pattern) !== -1;
    return re.test(value);
  }

  /** 数值比较：官方支持 >= > = <= <，取规则值里第一个数字 */
  function compareNumber(value, ruleValue) {
    if (typeof ruleValue !== "string") return false;
    var r = ruleValue.trim();
    var m = r.match(/(\d+)/);
    if (!m) return false;
    var n = Number(m[1]);
    if (r.indexOf(">") === 0) return r.indexOf(">=") === 0 ? value >= n : value > n;
    if (r.indexOf("<") === 0) return r.indexOf("<=") === 0 ? value <= n : value < n;
    if (r.indexOf("=") === 0) return value === n;
    return false;
  }

  /**
   * 单条属性匹配。
   * asyncMode=false：返回 boolean（XHR 同步路径）。
   * asyncMode=true ：返回 Promise<boolean>（fetch 路径，自定义函数支持 await）。
   */
  function matchOne(value, option, info, asyncMode) {
    if (value === undefined || value === null) return false;
    if (option.ruleValue === undefined || option.ruleValue === null) return false;

    if (option.isFunctionHandler) {
      var fn = getCompiledFunction(String(option.ruleValue), asyncMode === true);
      if (!fn) return false;
      try {
        var result = fn({
          ruleKey: option.ruleName,
          transformAwemeInfo: info,
          awemeInfo: info && info.__rawAweme ? info.__rawAweme : info
        });
        if (asyncMode === true) return Promise.resolve(result).then(function (v) { return v === true; });
        if (result && typeof result.then === "function") return false; // 同步路径忽略异步规则
        return result === true;
      } catch (e) {
        warn("自定义函数执行出错", e);
        return false;
      }
    }

    var rv = option.ruleValue;
    if (typeof value === "string") return testMatch(value, rv);
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        if (typeof value[i] === "string" && testMatch(value[i], rv)) return true;
      }
      return false;
    }
    if (typeof value === "number") return compareNumber(value, rv);
    if (typeof value === "boolean") return String(value) === String(rv).trim();
    return false;
  }

  function scopeMatches(ruleScope, currentScope) {
    var list = Array.isArray(ruleScope) ? ruleScope : [ruleScope];
    if (list.indexOf("all") !== -1) return true;
    return list.indexOf(currentScope) !== -1;
  }

  function namesOf(option) {
    return Array.isArray(option.ruleName) ? option.ruleName : [option.ruleName];
  }

  /** 同步版规则检查（用于 XHR 路径） */
  function checkRulesSync(rules, info, scope) {
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      if (!rule || rule.enable === false) continue;
      var data = rule.data || {};
      if (!scopeMatches(data.scope, scope)) continue;
      var names = namesOf(data);
      for (var j = 0; j < names.length; j++) {
        if (!Object.prototype.hasOwnProperty.call(info, names[j])) continue;
        var r = matchOne(info[names[j]], data, info, false);
        if (r !== true) continue; // Promise 视为未命中
        if (!checkDynamicSync(rule.dynamicData, info)) continue;
        return rule;
      }
    }
    return null;
  }

  function checkDynamicSync(dynamicData, info) {
    if (!Array.isArray(dynamicData) || dynamicData.length === 0) return true;
    for (var i = 0; i < dynamicData.length; i++) {
      var opt = dynamicData[i];
      var hit = false;
      var names = namesOf(opt);
      for (var j = 0; j < names.length; j++) {
        if (!Object.prototype.hasOwnProperty.call(info, names[j])) continue;
        if (matchOne(info[names[j]], opt, info, false) === true) { hit = true; break; }
      }
      if (!hit) return false; // 多组条件为 AND
    }
    return true;
  }

  /** 异步版规则检查（用于 fetch 路径，支持自定义函数里的 await） */
  async function checkRulesAsync(rules, info, scope) {
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      if (!rule || rule.enable === false) continue;
      var data = rule.data || {};
      if (!scopeMatches(data.scope, scope)) continue;
      // 非函数规则全部同步判定（v1.0.10）：内置匹配器都是同步的，跳过 await/Promise 开销
      if (data.isFunctionHandler !== true) {
        var namesS = namesOf(data);
        for (var js = 0; js < namesS.length; js++) {
          if (!Object.prototype.hasOwnProperty.call(info, namesS[js])) continue;
          if (matchOne(info[namesS[js]], data, info, false) !== true) continue;
          if (!checkDynamicSync(rule.dynamicData, info)) continue;
          return rule;
        }
        continue;
      }
      var names = namesOf(data);
      for (var j = 0; j < names.length; j++) {
        if (!Object.prototype.hasOwnProperty.call(info, names[j])) continue;
        var r = matchOne(info[names[j]], data, info, true);
        if ((await Promise.resolve(r)) !== true) continue;
        if (!(await checkDynamicAsync(rule.dynamicData, info))) continue;
        return rule;
      }
    }
    return null;
  }

  async function checkDynamicAsync(dynamicData, info) {
    if (!Array.isArray(dynamicData) || dynamicData.length === 0) return true;
    for (var i = 0; i < dynamicData.length; i++) {
      var opt = dynamicData[i];
      var hit = false;
      var names = namesOf(opt);
      for (var j = 0; j < names.length; j++) {
        if (!Object.prototype.hasOwnProperty.call(info, names[j])) continue;
        var r = matchOne(info[names[j]], opt, info, true);
        if ((await Promise.resolve(r)) === true) { hit = true; break; }
      }
      if (!hit) return false;
    }
    return true;
  }

  var rulesCache = null;
  function getRules() {
    if (rulesCache) return rulesCache;
    var rules = gv(KEY.rules, []);
    if (!Array.isArray(rules)) {
      // 兼容旧版可能的对象字典结构
      rules = Object.keys(rules).map(function (k) { return rules[k]; }).filter(isObj);
    }
    rulesCache = rules;
    return rules;
  }
  function saveRules(rules) {
    rulesCache = Array.isArray(rules) ? rules : null;
    sv(KEY.rules, rules);
  }

  /* =======================================================================
   * 4. 功能 B：接口拦截（URL 与响应结构照抄官方 execFilter）
   * ===================================================================== */

  /** 返回 {scope, type}；type: 1..4 对应官方 4 种响应结构；type 5 不过滤，直接忽略 */
  function classify(urlString) {
    // 快速预筛（v1.0.10）：所有被拦截的接口 URL 都含 /aweme/，其余请求直接跳过，避免每请求都 new URL 解析
    if (typeof urlString !== "string" || urlString.indexOf("/aweme/") === -1) return null;
    var pathname;
    try {
      pathname = new URL(urlString, win.location.href).pathname;
    } catch (e) {
      return null;
    }
    if (pathname.indexOf("/aweme/v1/web/tab/feed") === 0) return { scope: "xhr-tab", type: 1 };
    if (pathname.indexOf("/aweme/v1/web/aweme/post/") === 0) return { scope: "xhr-userHome", type: 1 };
    if (pathname.indexOf("/aweme/v1/web/mix/aweme/") === 0) return { scope: "xhr-mix", type: 1 };
    if (pathname.indexOf("/aweme/v1/web/aweme/related/") === 0) return { scope: "xhr-related", type: 1 };
    if (pathname.indexOf("/aweme/v1/web/follow/feed") === 0) return { scope: "xhr-follow", type: 2 };
    if (pathname.indexOf("/aweme/v1/web/familiar/feed") === 0) return { scope: "xhr-familiar", type: 2 };
    if (pathname.indexOf("/aweme/v1/web/module/feed") === 0) return { scope: "xhr-module", type: 3 };
    if (pathname.indexOf("/aweme/v2/web/module/feed") === 0) return { scope: "xhr-module", type: 1 };
    if (
      pathname.indexOf("/aweme/v1/web/general/search/single/") === 0 ||
      pathname.indexOf("/aweme/v1/web/search/item/") === 0
    ) return { scope: "xhr-search", type: 4 };
    return null;
  }

  /** 从列表项里取出 aweme 对象 */
  function extractAweme(meta, item) {
    if (!isObj(item)) return {};
    if (meta.type === 1) return item;
    if (meta.type === 2) {
      var a = item.aweme || {};
      if (isObj(item.cell_room)) a.cell_room = item.cell_room;
      return a;
    }
    if (meta.type === 3) return toJSON(item.aweme || "{}");
    if (meta.type === 4) return item.aweme_info || {};
    return {};
  }

  /** 同步处理一段响应文本，返回 {text, removed, total} */
  var lastFilterMs = 0;
  function processResponseSync(meta, text, rules) {
    var t0 = Date.now();
    var data = toJSON(text);
    var list = null;
    if (meta.type === 1) list = data.aweme_list;
    else if (meta.type === 2) list = data.data;
    else if (meta.type === 3) list = data.cards;
    else if (meta.type === 4) list = data.data;
    if (!Array.isArray(list)) return { text: text, removed: 0, total: 0 };

    var total = list.length;
    var removed = 0;
    var hits = [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      // 搜索结果的合集项：内部 mix_items 逐个过滤，全被过滤则移除整项
      if (meta.type === 4 && isObj(item) && isObj(item.aweme_mix_info) && Array.isArray(item.aweme_mix_info.mix_items)) {
        var mixItems = item.aweme_mix_info.mix_items;
        for (var k = 0; k < mixItems.length; k++) {
          var infoMix = parseAwemeInfo(mixItems[k]);
          var ruleMix = checkRulesSync(rules, infoMix, meta.scope); if (ruleMix) { mixItems.splice(k--, 1); removed++; hits.push(ruleMix.uuid || ruleMix.name || "unknown"); }
        }
        if (mixItems.length === 0) { list.splice(i--, 1); }
        continue;
      }
      var info = parseAwemeInfo(extractAweme(meta, item));
      var ruleHit = checkRulesSync(rules, info, meta.scope); if (ruleHit) { list.splice(i--, 1); removed++; hits.push(ruleHit.uuid || ruleHit.name || "unknown"); }
    }
    lastFilterMs = Date.now() - t0;
    addStats(hits);
    if (removed === 0) return { text: text, removed: 0, total: total };
    lastFilterMs = Date.now() - t0;
    return { text: JSON.stringify(data), removed: removed, total: total };
  }

  /** 异步处理（fetch 路径，支持 await 自定义函数） */
  function hasAsyncFunctionRule(rules) {
    for (var ri = 0; ri < rules.length; ri++) {
      var d = rules[ri] && rules[ri].data;
      if (d && d.isFunctionHandler === true && !getCompiledFunction(String(d.ruleValue), false)) return true;
    }
    return false;
  }
  async function processResponseAsync(meta, text, rules) {
    var t0 = Date.now();
    var data = toJSON(text);
    var list = null;
    if (meta.type === 1) list = data.aweme_list;
    else if (meta.type === 2) list = data.data;
    else if (meta.type === 3) list = data.cards;
    else if (meta.type === 4) list = data.data;
    if (!Array.isArray(list)) return { text: text, removed: 0, total: 0 };
    // 无 await 型函数规则时整段走同步（v1.0.11）：滚动分页不再产生每视频一次的微任务
    if (!hasAsyncFunctionRule(rules)) return processResponseSync(meta, text, rules);

    var total = list.length;
    var removed = 0;
    var hits = [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (meta.type === 4 && isObj(item) && isObj(item.aweme_mix_info) && Array.isArray(item.aweme_mix_info.mix_items)) {
        var mixItems = item.aweme_mix_info.mix_items;
        for (var k = 0; k < mixItems.length; k++) {
          var infoMix = parseAwemeInfo(mixItems[k]);
          var ruleMixA = await checkRulesAsync(rules, infoMix, meta.scope); if (ruleMixA) { mixItems.splice(k--, 1); removed++; hits.push(ruleMixA.uuid || ruleMixA.name || "unknown"); }
        }
        if (mixItems.length === 0) list.splice(i--, 1);
        continue;
      }
      var info = parseAwemeInfo(extractAweme(meta, item));
      var ruleHitA = await checkRulesAsync(rules, info, meta.scope); if (ruleHitA) { list.splice(i--, 1); removed++; hits.push(ruleHitA.uuid || ruleHitA.name || "unknown"); }
    }
    lastFilterMs = Date.now() - t0;
    addStats(hits);
    if (removed === 0) return { text: text, removed: 0, total: total };
    lastFilterMs = Date.now() - t0;
    return { text: JSON.stringify(data), removed: removed, total: total };
  }

  function report(meta, res) {
    if (res.removed > 0) log("过滤器 " + meta.scope + "：本次 " + res.total + " 个视频，移除 " + res.removed + " 个" + (lastFilterMs > 30 ? "，过滤耗时 " + lastFilterMs + "ms" : ""));
  }

  var filterEnableCache = null;
  function filterEnabled() {
    // 缓存（v1.0.10）：此前每请求一次 GM IPC；切换开关后会刷新页面，无需失效机制
    if (filterEnableCache === null) filterEnableCache = gv(KEY.filterEnable, true) !== false;
    return filterEnableCache;
  }

  var rawFetchRef = null;
  function installFetchHook() {
    if (typeof win.fetch !== "function") return;
    var rawFetch = win.fetch;
    rawFetchRef = rawFetch;
    win.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var meta = classify(url);
      if (meta) {
        meta.__dy_lastUrl = String(url);
        meta.__dy_method = String((init && init.method) || (typeof input !== "string" && input && input.method) || "GET").toUpperCase();
        meta.__dy_body = (init && init.body != null) ? String(init.body) : null;
      }
      var promise = rawFetch.apply(this, arguments);
      if (!meta || !filterEnabled()) return promise;
      var rules = getRules();
      if (!rules.length) return promise;

      return promise.then(async function (response) {
        try {
          if (!response || typeof response.text !== "function") return response;
          // 只处理 JSON / 文本响应，避免消费图片、视频等二进制 body
          var ct = response.headers && response.headers.get ? response.headers.get("content-type") || "" : "";
          if (ct && ct.indexOf("json") === -1 && ct.indexOf("text") === -1 && ct.indexOf("javascript") === -1) return response;
          var originalText = await response.text();
          var cached = cacheGet(meta.__dy_lastUrl || "");
          if (cached) {
            delete prefetchCache[cacheKey(meta.__dy_lastUrl || "")];
            originalText = cached.text;
            var cachedRes = { text: cached.text, removed: cached.removed, total: cached.total };
            report(meta, cachedRes);
            response.text = function () { return Promise.resolve(cached.text); };
            response.json = function () { return Promise.resolve(toJSON(cached.text)); };
            return response;
          }
          var res = await processResponseAsync(meta, originalText, rules);
          report(meta, res);
          if (res.removed >= PREFETCH_THRESHOLD) prefetchNextPage(meta, originalText, res.text, rules);
          if (res.text === originalText) {
            response.text = function () { return Promise.resolve(originalText); };
            response.json = function () { return Promise.resolve(toJSON(originalText)); };
          } else {
            response.text = function () { return Promise.resolve(res.text); };
            response.json = function () { return Promise.resolve(toJSON(res.text)); };
          }
        } catch (e) {
          warn("fetch 响应处理失败", e);
        }
        return response;
      });
    };
  }

  function installXHRHook() {
    var XHR = win.XMLHttpRequest;
    if (!XHR || !XHR.prototype) return;
    var desc = Object.getOwnPropertyDescriptor(XHR.prototype, "responseText");
    var rawGet = desc && desc.get;
    if (!rawGet) return;

    var rawOpen = XHR.prototype.open;
    var rawSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      this.__dy_url = String(url);
      this.__dy_method = String(method || "GET").toUpperCase();
      return rawOpen.apply(this, arguments);
    };

    XHR.prototype.send = function () {
      var xhr = this;
      var meta = classify(xhr.__dy_url || "");
      if (meta) {
        meta.__dy_lastUrl = String(xhr.__dy_url || "");
        meta.__dy_method = xhr.__dy_method || "GET";
        meta.__dy_body = arguments.length ? String(arguments[0]) : null;
      }
      if (meta && filterEnabled() && getRules().length) {
        var patched = false;
        var patch = function () {
          if (patched) return;
          patched = true;
          try {
            var memo = null;
            Object.defineProperty(xhr, "responseText", {
              configurable: true,
              get: function () {
                var text = rawGet.call(xhr);
                if (memo && text === memo.in) { report(meta, memo); return memo.out; }
                try {
                  var cached = cacheGet(meta.__dy_lastUrl || "");
                  if (cached) {
                    delete prefetchCache[cacheKey(meta.__dy_lastUrl || "")];
                    memo = { in: text, out: cached.text, removed: cached.removed, total: cached.total };
                    report(meta, memo);
                    return cached.text;
                  }
                  var res = processResponseSync(meta, text, getRules());
                  memo = { in: text, out: res.text, removed: res.removed, total: res.total };
                  report(meta, res);
                  if (res.removed >= PREFETCH_THRESHOLD) prefetchNextPage(meta, text, res.text, getRules());
                  return res.text;
                } catch (e) {
                  warn("XHR 响应处理失败", e);
                  return text;
                }
              }
            });
            var respDesc = Object.getOwnPropertyDescriptor(XHR.prototype, "response");
            if (respDesc && respDesc.get) {
              var rawRespGet = respDesc.get;
              Object.defineProperty(xhr, "response", {
                configurable: true,
                get: function () {
                  var v = rawRespGet.call(xhr);
                  if (typeof v === "string") {
                    if (memo && v === memo.in) return memo.out;
                    try {
                      var r2 = processResponseSync(meta, v, getRules());
                      memo = { in: v, out: r2.text, removed: r2.removed, total: r2.total };
                      return r2.text;
                    } catch (e) { return v; }
                  }
                  return v;
                }
              });
            }
          } catch (e) {
            warn("XHR getter 改写失败", e);
          }
        };
        // readyState 变化到 HEADERS_RECEIVED 后即可安装 getter
        xhr.addEventListener("readystatechange", function () {
          if (xhr.readyState >= 2) patch();
        });
      }
      return rawSend.apply(this, arguments);
    };
  }

  /* =======================================================================
   * 5. 设置面板（原生 DOM，无外部依赖）
   *
   * 交互层说明：抖音页面常在 document 捕获阶段拦截/吞掉 click，
   * 导致挂在按钮（冒泡阶段）的监听器收不到事件 —— 表现就是「按钮无反应」。
   * 这里把事件委托注册在 window 捕获阶段（事件传播的最外层、最先执行），
   * 并对原生控件做兜底，同时对每次操作给出可见 toast 反馈。
   * ===================================================================== */

  function esc(s) {
    return String(s === undefined || s === null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function uuid() {
    return "dy-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
  }
  function el(id) { return doc.getElementById(id); }

  var CSS = [
    "#dy-rf-mask{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,'Microsoft YaHei',sans-serif;pointer-events:auto}",
    "#dy-rf-panel{width:min(860px,94vw);max-height:88vh;background:#fff;color:#222;border-radius:10px;box-shadow:0 12px 48px rgba(0,0,0,.35);display:flex;flex-direction:column;overflow:hidden;font-size:13px}",
    "#dy-rf-panel header{padding:14px 18px;background:#1f2329;color:#fff;display:flex;justify-content:space-between;align-items:center;font-size:15px;font-weight:600}",
    "#dy-rf-panel header button{background:transparent;border:0;color:#fff;font-size:20px;cursor:pointer;line-height:1}",
    "#dy-rf-tabs{display:flex;border-bottom:1px solid #e5e6eb;background:#f7f8fa}",
    "#dy-rf-tabs button{flex:1;padding:11px;background:transparent;border:0;cursor:pointer;font-size:13px;color:#4e5969;border-bottom:2px solid transparent}",
    "#dy-rf-tabs button.on{color:#165dff;border-bottom-color:#165dff;background:#fff;font-weight:600}",
    "#dy-rf-body{padding:16px 18px;overflow:auto;flex:1}",
    "#dy-rf-panel footer{padding:12px 18px;border-top:1px solid #e5e6eb;display:flex;justify-content:flex-end;gap:8px;background:#fafbfc}",
    "#dy-rf-panel .row{margin-bottom:12px;display:flex;align-items:flex-start;gap:10px}",
    "#dy-rf-panel label.lb{width:110px;flex:none;padding-top:6px;color:#4e5969}",
    "#dy-rf-panel input[type=text],#dy-rf-panel textarea,#dy-rf-panel select{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #c9cdd4;border-radius:5px;font-size:13px;font-family:inherit}",
    "#dy-rf-panel textarea{min-height:78px;resize:vertical;font-family:ui-monospace,Consolas,monospace;font-size:12px}",
    "#dy-rf-panel .btn{padding:7px 14px;border:1px solid #c9cdd4;background:#fff;border-radius:5px;cursor:pointer;font-size:13px}",
    "#dy-rf-panel .btn.primary{background:#165dff;border-color:#165dff;color:#fff}",
    "#dy-rf-panel .btn.danger{color:#f53f3f;border-color:#f5b7b7}",
    "#dy-rf-panel .btn.sm{padding:4px 9px;font-size:12px}",
    "#dy-rf-panel .btn.on{background:#165dff;border-color:#165dff;color:#fff}",
    "#dy-rf-panel .btn.off{background:#f2f3f5;color:#4e5969}",
    "#dy-rf-panel .hint{color:#86909c;font-size:12px;line-height:1.6;margin:4px 0 0 120px}",
    "#dy-rf-panel table{width:100%;border-collapse:collapse;font-size:12px}",
    "#dy-rf-panel th,#dy-rf-panel td{border-bottom:1px solid #e5e6eb;padding:7px 6px;text-align:left;vertical-align:middle;word-break:break-all}",
    "#dy-rf-panel th{background:#f7f8fa;color:#4e5969;font-weight:600}",
    "#dy-rf-panel .scopes{display:flex;flex-wrap:wrap;gap:6px}",
    "#dy-rf-panel .scopes button{border:1px solid #c9cdd4;background:#f7f8fa;color:#4e5969;padding:3px 9px;border-radius:4px;cursor:pointer;font-size:12px;font-family:inherit}",
    "#dy-rf-panel .scopes button.on{background:#165dff;border-color:#165dff;color:#fff}",
    "#dy-rf-panel .tgl{border:1px solid #c9cdd4;background:#f7f8fa;color:#4e5969;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:12px;font-family:inherit}",
    "#dy-rf-panel .tgl.on{background:#165dff;border-color:#165dff;color:#fff}",
    "#dy-rf-panel details{margin-top:14px;color:#4e5969;font-size:12px;line-height:1.7}",
    "#dy-rf-panel code{background:#f2f3f5;padding:1px 4px;border-radius:3px;font-family:ui-monospace,Consolas,monospace}",
    "#dy-rf-form{display:none;border:1px solid #e5e6eb;border-radius:6px;padding:14px;margin:12px 0;background:#fafbfc}",
    "#dy-rf-toast{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#1f2329;color:#fff;padding:9px 18px;border-radius:6px;font-size:13px;box-shadow:0 6px 24px rgba(0,0,0,.3);pointer-events:none;opacity:0;transition:opacity .18s;font-family:system-ui,-apple-system,'Microsoft YaHei',sans-serif}",
    "#dy-rf-toast.show{opacity:1}"
  ].join("\n");

  /* ---------------- Toast ---------------- */

  var toastTimer = null;
  function showToast(msg) {
    var t = el("dy-rf-toast");
    if (!t) {
      t = doc.createElement("div");
      t.id = "dy-rf-toast";
      (doc.body || doc.documentElement).appendChild(t);
    }
    t.textContent = msg;
    t.className = "show";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = ""; }, 2400);
  }

  /* ---------------- window 捕获阶段委托 ---------------- */

  var delegateInstalled = false;
  function ensureDelegates() {
    if (delegateInstalled) return;
    delegateInstalled = true;
    win.addEventListener("click", onCaptureClick, true);
    win.addEventListener("change", onCaptureChange, true);
    win.addEventListener("keydown", onCaptureKey, true);
  }

  function panelOf(e) {
    var mask = el("dy-rf-mask");
    if (!mask || !e || !e.target || !e.target.closest) return null;
    return e.target.closest("#dy-rf-mask") === mask ? mask : null;
  }

  function onCaptureClick(e) {
    var mask = panelOf(e);
    if (!mask) return;
    var t = e.target;
    var tag = (t.tagName || "").toUpperCase();

    // 输入框主动聚焦：页面若在 document 捕获阶段截断事件，target 收不到 click，
    // 这里手动 focus 保证仍可输入。
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      try { t.focus(); } catch (err) {}
    }

    // 原生 checkbox 在捕获阶段无法可靠控制（pre-click toggle + 取消回滚），
    // 面板内已全部改用 data-on 按钮开关；此处仅保留对外部 checkbox 的被动读取。

    // details/summary 兜底
    var summary = tag === "SUMMARY" ? t : (t.closest ? t.closest("summary") : null);
    if (summary) {
      e.preventDefault();
      var details = summary.closest ? summary.closest("details") : null;
      if (details) details.open = !details.open;
      e.__dyHandled = true;
      return;
    }

    // select：尝试主动展开（Edge/Chrome 支持 showPicker），不 preventDefault 以免阻止原生下拉
    if (tag === "SELECT") {
      try { if (typeof t.showPicker === "function") t.showPicker(); } catch (err) {}
    }

    var actEl = t.closest ? t.closest("[data-act]") : null;
    if (actEl) {
      e.__dyHandled = true;
      e.preventDefault();
      handleAct(actEl.getAttribute("data-act"), actEl, e);
      return;
    }

    if (t === mask) {
      e.__dyHandled = true;
      closePanel();
      showToast("已关闭设置");
    }
  }

  function onCaptureChange(e) {
    if (!panelOf(e) || e.__dyHandled) return;
    e.__dyHandled = true;
    handleChange(e.target, e);
  }

  function onCaptureKey(e) {
    if (!el("dy-rf-mask")) return;
    if (e.key === "Escape") {
      e.__dyHandled = true;
      closePanel();
      showToast("已关闭设置");
    }
  }

  function handleChange(t, e) {
    if (!t) return;
    var id = t.id;
    if (id === "dy-rf-q-mode") {
      saveQualityFromUI();
      runQuality();
      showToast("画质策略已保存：" + qualityModeLabel());
      return;
    }
    if (id === "dy-rf-file") {
      importRules(e);
      return;
    }
    if (t.getAttribute && t.getAttribute("data-act") === "toggle") {
      onRuleAction(t);
    }
  }

  function handleAct(act, node, e) {
    switch (act) {
      case "close":
        closePanel();
        showToast("已关闭设置");
        break;
      case "save":
        savePanel();
        closePanel();
        break;
      case "tab:quality":
      case "tab:filter":
        switchTab(act.slice(4));
        break;
      case "tab:stats":
        renderStatsTab();
        switchTab("stats");
        break;
      case "q-clear":
        try { GM_deleteValue(KEY.qualityRemembered); } catch (err) {}
        renderQualityTab();
        showToast("已清除画质记忆");
        break;
      case "unlock-quality":
        unlockQuality = !unlockQuality;
        sv("dy-refactor-unlock-quality", unlockQuality);
        if (unlockQuality) {
          showToast("已开启解锁更高画质——当前画质将被强制保持");
          // 立即强制一次
          var gt = resolveQualityGearType();
          if (gt !== null) applyQuality(gt);
        } else {
          showToast("已关闭解锁更高画质");
        }
        renderQualityTab();
        break;
      case "stats-reset":
        statsMemory = { total: 0, byRule: {} };
        statsDirty = false;
        if (statsFlushTimer) { clearTimeout(statsFlushTimer); statsFlushTimer = null; }
        statsStoreClear();
        if (el("dy-rf-mask")) renderStatsTab();
        showToast("屏蔽统计已清零");
        break;
      case "q-apply":
        saveQualityFromUI();
        var gt = resolveQualityGearType();
        var modeNow = gv(KEY.qualityMode, "remember");
        var qmsg;
        if (gt === null) {
          qmsg = modeNow === "off"
            ? "当前策略为「不干预画质」，未写入。"
            : "「记住手动选择」尚无记录：请在播放器里手动选一次画质，或改用「强制」档位。";
        } else {
          var def = getQualityDefinition(gt);
          applyQuality(gt);
          var back = null;
          try { back = win.sessionStorage.getItem(QUALITY_SESSION_KEY); } catch (err) {}
          qmsg = "已写入画质：" + (def ? def.gearName : gt) +
            "（" + (back ? "sessionStorage 已确认" : "写入未确认") + "）。" +
            "切换视频或刷新页面后生效，当前视频不会立即变化。";
        }
        showToast(qmsg);
        renderQualityTab();
        setPanelResult(qmsg);
        break;
      case "q-reload":
        showToast("正在刷新页面以应用画质…");
        setTimeout(function () { win.location.reload(); }, 300);
        break;
      case "f-enable":
        draftFilterEnable = !draftFilterEnable;
        sv(KEY.filterEnable, draftFilterEnable);
        renderFilterTab();
        showToast("视频过滤器已" + (draftFilterEnable ? "启用" : "禁用"));
        break;
      case "add":
        showForm(null);
        showToast("已打开新增规则表单");
        break;
      case "import":
        var f = el("dy-rf-file");
        if (f) f.click();
        break;
      case "export":
        exportRules();
        break;
      case "clear-all":
        if (!win.confirm("确定清空全部过滤规则？")) break;
        draftRules = [];
        saveRules([]);
        renderRuleList();
        hideForm();
        showToast("已清空全部规则");
        break;
      case "form-cancel":
        hideForm();
        showToast("已取消编辑");
        break;
      case "form-ok":
        saveForm();
        break;
      case "flag":
        var onFlag = toggleButton(node);
        var key = node.getAttribute("data-key");
        if (key === "enable") node.textContent = onFlag ? "已启用" : "已禁用";
        else node.textContent = onFlag ? "函数模式：开" : "函数模式：关";
        showToast((key === "enable" ? "规则启用" : "函数模式") + "：" + (onFlag ? "开" : "关"));
        break;
      case "scope":
        var onScope = toggleButton(node);
        showToast("作用域 " + node.getAttribute("data-val") + "：" + (onScope ? "选中" : "取消选中"));
        break;
      case "edit":
      case "del":
      case "toggle":
        onRuleAction(node);
        break;
      default:
        break;
    }
  }

  /* ---------------- 面板骨架 ---------------- */

  /* --- 预加载下一条（v1.0.13）：移除过多时主动请求下一页并缓存过滤结果 --- */
  var prefetchCache = {};       // url -> { text, removed, total, ts }
  var prefetchInflight = {};    // url -> true（防重入）
  var PREFETCH_THRESHOLD = 5;   // 单次移除 >= 5 条时触发预加载
  var PREFETCH_MAX_CACHE = 3;   // 缓存最多保留 3 个 URL
  function extractCursor(data, metaType) {
    // 抖音各接口的游标字段：has_more(1=有更多) + max_cursor/min_cursor/cursor
    if (!isObj(data)) return { hasMore: false, cursor: null };
    var hasMore = false, cursor = null;
    if (data.has_more !== undefined) hasMore = data.has_more === 1 || data.has_more === true;
    else if (data.data && isObj(data.data) && data.data.has_more !== undefined) hasMore = data.data.has_more === 1 || data.data.has_more === true;
    if (data.max_cursor !== undefined) cursor = data.max_cursor;
    else if (data.cursor !== undefined) cursor = data.cursor;
    else if (data.data && isObj(data.data) && data.data.max_cursor !== undefined) cursor = data.data.max_cursor;
    else if (data.data && isObj(data.data) && data.data.cursor !== undefined) cursor = data.data.cursor;
    return { hasMore: hasMore, cursor: cursor };
  }
  function buildNextUrl(urlString, cursor) {
    if (cursor === null || cursor === undefined) return null;
    try {
      var u = new URL(urlString, win.location.href);
      // 尝试替换已有的 cursor 参数，或追加
      var replaced = false;
      for (var key of ["max_cursor", "cursor"]) {
        if (u.searchParams.has(key)) { u.searchParams.set(key, String(cursor)); replaced = true; break; }
      }
      if (!replaced) u.searchParams.set("max_cursor", String(cursor));
      return u.href;
    } catch (e) { return null; }
  }
  function cacheKey(urlString) {
    try { var u = new URL(urlString, win.location.href); return u.pathname + u.search; } catch (e) { return urlString; }
  }
  function cachePut(urlString, filtered) {
    var key = cacheKey(urlString);
    prefetchCache[key] = { text: filtered.text, removed: filtered.removed, total: filtered.total, ts: Date.now() };
    // LRU：超过上限删最旧的
    var keys = Object.keys(prefetchCache);
    if (keys.length > PREFETCH_MAX_CACHE) {
      keys.sort(function (a, b) { return prefetchCache[a].ts - prefetchCache[b].ts; });
      for (var i = 0; i < keys.length - PREFETCH_MAX_CACHE; i++) delete prefetchCache[keys[i]];
    }
  }
  function cacheGet(urlString) {
    return prefetchCache[cacheKey(urlString)] || null;
  }
  function replaceCursorInBody(bodyStr, cursor) {
    // 在请求 body（表单或 JSON）里替换游标值；无法替换返回 null
    try {
      var replaced = false;
      var out = String(bodyStr).replace(/(max_cursor|cursor)(=|(":s*"?))(d+)/i, function (m0, m1, m2, num) {
        replaced = true;
        return m1 + m2 + String(cursor);
      });
      return replaced ? out : null;
    } catch (e) { return null; }
  }
  function prefetchNextPage(meta, originalText, filteredText, rules) {
    try {
      var cursorInfo = extractCursor(toJSON(filteredText), meta.type);
      if (!cursorInfo.hasMore || cursorInfo.cursor === null) return;
      var lastUrl = meta.__dy_lastUrl || meta.url || "";
      var nextUrl = buildNextUrl(lastUrl, cursorInfo.cursor);
      if (!nextUrl) return;
      var key = cacheKey(nextUrl);
      if (prefetchCache[key] || prefetchInflight[key]) return; // 已缓存或正在请求
      prefetchInflight[key] = true;
      // 用 rawFetch/rawGet 绕过 hook，避免死循环
      var doFetch = typeof rawFetchRef === "function" ? rawFetchRef : win.fetch;
      // v1.0.20：保留原始请求方法与 body——POST 接口仅替换 URL 游标会拿到空页（此前 0/0 的原因）
      var method = meta.__dy_method || "GET";
      var reqInit = { credentials: "include" };
      if (method !== "GET" && meta.__dy_body) {
        var newBody = replaceCursorInBody(String(meta.__dy_body), cursorInfo.cursor);
        if (newBody === null) { delete prefetchInflight[key]; return; } // body 里没有游标 → 放弃预加载
        reqInit.method = method;
        reqInit.body = newBody;
        reqInit.headers = { "content-type": "application/x-www-form-urlencoded" };
      }
      doFetch(nextUrl, reqInit).then(function (resp) {
        return resp.text();
      }).then(function (rawText) {
        delete prefetchInflight[key];
        var res = processResponseSync(meta, rawText, getRules());
        if (!res.total) { log("预加载下一页返回空列表，放弃缓存：" + nextUrl.slice(0, 80) + "…"); return; }
        cachePut(nextUrl, res);
        log("预加载下一页完成：URL=" + nextUrl.slice(0, 80) + "… 移除 " + res.removed + "/" + res.total);
      }).catch(function (e) {
        delete prefetchInflight[key];
        warn("预加载下一页失败", e);
      });
    } catch (e) {
      warn("预加载下一页异常", e);
    }
  }
  function safeRender(boxId, fn) {
    var box = null;
    try {
      fn();
    } catch (e) {
      warn("面板渲染失败 " + boxId, e);
      box = el(boxId);
      if (box) box.innerHTML = '<p class="hint" style="color:#f53f3f">渲染出错：' + esc(String((e && e.message) || e)) + "（请把这条信息反馈给开发者）</p>";
      return;
    }
    // v1.0.14+1.0.16：渲染后校验容器确实有内容；空则再试一次（防 SPA 竞态清空）
    box = el(boxId);
    if (box && !box.innerHTML.length) {
      warn(boxId + " 渲染后为空——重试一次");
      try { fn(); } catch (e2) {}
      if (box && !box.innerHTML.length) {
        box.innerHTML = '<p class="hint" style="color:#f53f3f">[' + boxId + '] 渲染两次后仍为空。版本 ' + SCRIPT_VERSION + '。请截图 F12 控制台含「抖音优化」的日志反馈。</p>';
        log(boxId + " 两次渲染后仍为空");
      }
    }
  }
  function buildPanel() {
    if (el("dy-rf-mask")) return;
    ensureDelegates();
    var style = doc.createElement("style");
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);

    var mask = doc.createElement("div");
    mask.id = "dy-rf-mask";
    try { mask.innerHTML =
      '<div id="dy-rf-panel">' +
      '  <header><span>抖音优化 · 精简版 v' + SCRIPT_VERSION + ' 设置</span><button data-act="close" title="关闭">×</button></header>' +
      '  <div id="dy-rf-tabs">' +
      '    <button data-act="tab:quality" class="on">记住选择画质</button>' +
      '    <button data-act="tab:filter">自定义视频过滤器</button>' +
      '    <button data-act="tab:stats">屏蔽统计</button>' +
      '  </div>' +
      '  <div id="dy-rf-body">' +
      '    <div id="dy-rf-tab-quality"></div>' +
      '    <div id="dy-rf-tab-filter" style="display:none"></div>' +
      '    <div id="dy-rf-tab-stats" style="display:none"></div>' +
      '  </div>' +
      '  <footer>' +
      '    <button class="btn" data-act="close">关闭</button>' +
      '    <button class="btn primary" data-act="save">保存并生效</button>' +
      '  </footer>' +
      '</div>';
    } catch (e) {
      warn("mask.innerHTML 写入失败（可能被 CSP 拦截），改用逐元素创建", e);
      mask.textContent = "";
      var panelEl = doc.createElement("div"); panelEl.id = "dy-rf-panel";
      var hd = doc.createElement("header");
      var hdSpan = doc.createElement("span"); hdSpan.textContent = "抖音优化 · 精简版 v" + SCRIPT_VERSION + " 设置";
      hd.appendChild(hdSpan);
      var closeBtn = doc.createElement("button"); closeBtn.setAttribute("data-act", "close"); closeBtn.title = "关闭"; closeBtn.textContent = "×";
      hd.appendChild(closeBtn);
      panelEl.appendChild(hd);
      var tabsEl = doc.createElement("div"); tabsEl.id = "dy-rf-tabs";
      var bodyEl = doc.createElement("div"); bodyEl.id = "dy-rf-body";
      var qD = doc.createElement("div"); qD.id = "dy-rf-tab-quality";
      var fD = doc.createElement("div"); fD.id = "dy-rf-tab-filter"; fD.style.display = "none";
      var sD = doc.createElement("div"); sD.id = "dy-rf-tab-stats"; sD.style.display = "none";
      bodyEl.appendChild(qD); bodyEl.appendChild(fD); bodyEl.appendChild(sD);
      var tabDefs = [["tab:quality", "记住选择画质", "on"], ["tab:filter", "自定义视频过滤器", ""], ["tab:stats", "屏蔽统计", ""]];
      for (var ti = 0; ti < tabDefs.length; ti++) {
        var tb = doc.createElement("button");
        tb.setAttribute("data-act", tabDefs[ti][0]);
        tb.className = tabDefs[ti][2];
        tb.textContent = tabDefs[ti][1];
        tabsEl.appendChild(tb);
      }
      var ftEl = doc.createElement("footer");
      var bc = doc.createElement("button"); bc.className = "btn"; bc.setAttribute("data-act", "close"); bc.textContent = "关闭";
      var bs = doc.createElement("button"); bs.className = "btn primary"; bs.setAttribute("data-act", "save"); bs.textContent = "保存并生效";
      ftEl.appendChild(bc); ftEl.appendChild(bs);
      panelEl.appendChild(tabsEl); panelEl.appendChild(bodyEl); panelEl.appendChild(ftEl);
      mask.appendChild(panelEl);
      log("面板已用 createElement 逐元素创建（CSP 兜底）");
    }
    (doc.body || doc.documentElement).appendChild(mask);

    // 预建 toast 节点，保证首次操作也有可见反馈
    if (!el("dy-rf-toast")) {
      var toastNode = doc.createElement("div");
      toastNode.id = "dy-rf-toast";
      (doc.body || doc.documentElement).appendChild(toastNode);
    }

    safeRender("dy-rf-tab-quality", renderQualityTab);
    safeRender("dy-rf-tab-filter", renderFilterTab);
    safeRender("dy-rf-tab-stats", renderStatsTab);
  }

  function closePanel() {
    if (panelKeepAlive) { clearInterval(panelKeepAlive); panelKeepAlive = null; }
    if (unlockQualityTimer) { clearInterval(unlockQualityTimer); unlockQualityTimer = null; }
    var m = el("dy-rf-mask");
    if (m && m.parentNode) m.parentNode.removeChild(m);
  }
  var panelKeepAlive = null;
  var unlockQualityTimer = null;
  var lastManualSwitch = null;
  // v1.0.17：解锁更高画质——监控 sessionStorage.MANUAL_SWITCH，强制高画质
  function unlockQualityTick() {
    if (!unlockQuality) return;
    try {
      var cur = win.sessionStorage.getItem(QUALITY_SESSION_KEY);
      if (cur === lastManualSwitch) return;
      lastManualSwitch = cur;
      if (!cur) return;
      var parsed = null;
      try { parsed = JSON.parse(cur); } catch (e) { return; }
      if (!parsed || typeof parsed !== "object") return;
      var currentGear = parsed.gearType;
      var targetGear = resolveQualityGearType();
      if (targetGear === null) return;
      // 如果当前 gearType 比目标低（数值更大 = 更低画质），强制写回目标
      // gearType: -2=4K, -1=2K, 1=1080P, 2=720P, 3=540P, ...
      if (currentGear !== null && currentGear > targetGear) {
        log("解锁更高画质：当前 gearType=" + currentGear + " 低于目标 " + targetGear + "，强制写回");
        applyQuality(targetGear);
      }
    } catch (e) {}
  }
  function openPanel(tabName) {
    buildPanel();
    // v1.0.18 根因修复：Tampermonkey 会给菜单回调注入 event 参数；此前 openPanel
    // 被直接作为回调引用，event 被当成 tabName 传给 switchTab(非法值) → 三个页签
    // 全部 display:none → 面板空白。现在只接受合法页签名。
    if (tabName === "quality" || tabName === "filter" || tabName === "stats") switchTab(tabName);
    // v1.0.16：面板 keep-alive——SPA 竞态可能清空面板内容，定时检测并重渲染
    if (panelKeepAlive) clearInterval(panelKeepAlive);
    var checkCount = 0;
    panelKeepAlive = setInterval(function () {
      var mask = el("dy-rf-mask");
      if (!mask) { clearInterval(panelKeepAlive); panelKeepAlive = null; return; }
      checkCount++;
      if (checkCount > 200) { clearInterval(panelKeepAlive); panelKeepAlive = null; return; }
      var q = el("dy-rf-tab-quality");
      var f = el("dy-rf-tab-filter");
      var s = el("dy-rf-tab-stats");
      if (q && !q.innerHTML.length) { log("keep-alive: quality 页签被清空，重渲染"); safeRender("dy-rf-tab-quality", renderQualityTab); }
      if (f && !f.innerHTML.length) { log("keep-alive: filter 页签被清空，重渲染"); safeRender("dy-rf-tab-filter", renderFilterTab); }
      if (s && !s.innerHTML.length) { log("keep-alive: stats 页签被清空，重渲染"); safeRender("dy-rf-tab-stats", renderStatsTab); }
    }, 500);
  }

  function switchTab(name) {
    var tabs = doc.querySelectorAll("#dy-rf-tabs button");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].className = tabs[i].getAttribute("data-act") === "tab:" + name ? "on" : "";
    }
    el("dy-rf-tab-quality").style.display = name === "quality" ? "" : "none";
    el("dy-rf-tab-filter").style.display = name === "filter" ? "" : "none";
    var statsBox = el("dy-rf-tab-stats");
    if (statsBox) statsBox.style.display = name === "stats" ? "" : "none";
  }

  /* --- 画质 Tab --- */

  /* 面板内持久状态（v1.0.2）：不依赖可能被播放器盖住的 toast */
  var panelResult = "";
  function setPanelResult(msg) {
    panelResult = msg;
    var n = el("dy-rf-q-result");
    if (n) n.textContent = msg;
  }
  function readQualitySession() {
    try {
      var v = win.sessionStorage.getItem(QUALITY_SESSION_KEY);
      if (!v) return "(空) 抖音尚未写入画质配置";
      var o = null;
      try { o = JSON.parse(v); } catch (e) {}
      if (o && o.gearName) {
        return String(o.gearName) + "  (gearType=" + o.gearType + ", gearClarity=" + o.gearClarity + ")";
      }
      return v.slice(0, 120);
    } catch (e) {
      return "(读取失败: " + e.message + ")";
    }
  }

  function qualityModeLabel() {
    var mode = gv(KEY.qualityMode, "remember");
    if (mode === "off") return "不干预画质";
    if (mode === "force") {
      var d = getQualityDefinition(gv(KEY.qualityForced, -2));
      return "强制：" + (d ? d.gearName : "?");
    }
    return "记住手动选择";
  }

  function renderQualityTab() {
    var mode = gv(KEY.qualityMode, "remember");
    var forced = gv(KEY.qualityForced, -2);
    var remembered = gv(KEY.qualityRemembered, null);
    var rememberedDef = remembered === null ? null : getQualityDefinition(remembered);
    var activeGt = resolveQualityGearType();
    var activeDef = activeGt === null ? null : getQualityDefinition(activeGt);

    var options = '<option value="remember"' + (mode === "remember" ? " selected" : "") + '>记住手动选择（推荐）</option>' +
      '<option value="off"' + (mode === "off" ? " selected" : "") + '>不干预画质</option>';
    QUALITY_DEFINITIONS.forEach(function (d) {
      if (d.gearName === "无") return;
      options += '<option value="force:' + d.gearType + '"' + (mode === "force" && forced === d.gearType ? " selected" : "") + '>强制：' + esc(d.gearName) + "</option>";
    });

    el("dy-rf-tab-quality").innerHTML =
      '<div class="row"><label class="lb">画质策略</label><div style="flex:1"><select id="dy-rf-q-mode">' + options + "</select>" +
      '<p class="hint" style="margin-left:0">「记住手动选择」：在播放器里选一次画质，脚本用 GM 记住并在下次打开页面时自动恢复（写入官方 <code>sessionStorage.MANUAL_SWITCH</code>）。<br>「强制」：忽略手动选择，始终使用指定档位。「不干预」：完全不写画质配置。<b>改动即时保存。</b></p></div></div>' +
      '<div class="row"><label class="lb">解锁更高画质</label><div style="flex:1;padding-top:4px"><button class="tgl ' + (unlockQuality ? "on" : '') + '" data-act="unlock-quality" data-on="' + (unlockQuality ? "1" : "0") + '">' + (unlockQuality ? "已开启（点击关闭）" : "已关闭（点击开启）") + '</button><p class="hint" style="margin-left:0">开启后，脚本会监控播放器画质变化，如果被抖音降级会自动强制回目标档位（仅对「记住手动选择」和「强制」模式生效）。</p></div></div>' +
      '<div class="row"><label class="lb">生效状态</label><div style="flex:1;padding-top:6px">' +
      (activeDef ? "当前应用：<b>" + esc(activeDef.gearName) + "</b>（gearType=" + activeGt + "）" : "<span style=\"color:#86909c\">未写入画质配置（不干预或尚未手动选择）</span>") +
      "</div></div>" +
      '<div class="row"><label class="lb">当前记忆</label><div style="flex:1;padding-top:6px">' +
      (rememberedDef
        ? "<b>" + esc(rememberedDef.gearName) + "</b>（gearType=" + remembered + "）" + (function(){ var t=gv(KEY.qualityRememberedAt,null); return t ? " <span style='color:#86909c'>记于 " + esc(new Date(t).toLocaleTimeString()) + "</span>" : ""; })()
        : "<span style=\"color:#86909c\">暂无（在播放器里手动切换一次画质后自动记住）</span>") +
      ' <button class="btn sm" data-act="q-clear" style="margin-left:8px">清除记忆</button></div></div>' +
      '<div class="row"><label class="lb">立即应用</label><div style="flex:1;padding-top:6px"><button class="btn sm" data-act="q-apply">按当前策略写入画质</button> <button class="btn sm" data-act="q-reload">刷新页面生效</button></div></div>' +
      '<div class="row"><label class="lb">操作结果</label><div style="flex:1"><div id="dy-rf-q-result" style="padding:6px 9px;background:#f7f8fa;border:1px solid #e5e6eb;border-radius:5px;min-height:18px;color:#4e5969">' + esc(panelResult || "尚未操作") + '</div></div></div>' +
      '<div class="row"><label class="lb">播放器实际值</label><div style="flex:1"><div style="padding:6px 9px;background:#f7f8fa;border:1px solid #e5e6eb;border-radius:5px;font:12px monospace;word-break:break-all;color:#4e5969">' + esc(readQualitySession()) + '</div><p class="hint" style="margin-left:0">这是抖音播放器读取的 <code>sessionStorage.MANUAL_SWITCH</code>。手动切换画质后此值会变，脚本会自动记住。</p></div></div>' +
      "<details><summary>实现说明</summary>官方脚本把 <code>{done, gearClarity, qualityType, gearName, gearType, clarityReal}</code> 写入 <code>sessionStorage[\"MANUAL_SWITCH\"]</code>，抖音播放器读取它决定清晰度。本版保留完全相同的数据结构与 200ms×1s 的重写节奏，仅增加 GM 持久化与手动选择监听。已剔除「解锁更高画质 / 篡改设备画像」。</details>";
  }

  function saveQualityFromUI() {
    var node = el("dy-rf-q-mode");
    if (!node) return;
    var v = node.value;
    if (v === "remember") sv(KEY.qualityMode, "remember");
    else if (v === "off") sv(KEY.qualityMode, "off");
    else if (v.indexOf("force:") === 0) {
      sv(KEY.qualityMode, "force");
      sv(KEY.qualityForced, Number(v.slice(6)));
    }
  }

  function savePanel() {
    saveQualityFromUI();
    saveFilterFromUI();
    runQuality();
    showToast("设置已保存并生效（" + qualityModeLabel() + "）");
  }

  /* --- 过滤规则 Tab --- */

  var draftRules = null;
  var draftFilterEnable = null;
  var editingUuid = null;

  function renderFilterTab() {
    if (draftRules === null) draftRules = getRules().slice();
    if (draftFilterEnable === null) draftFilterEnable = gv(KEY.filterEnable, true) !== false;
    var html =
      '<div class="row"><label class="lb">过滤器</label><div style="flex:1;padding-top:4px">' +
      '<button class="btn sm ' + (draftFilterEnable ? "on" : "off") + '" data-act="f-enable">' + (draftFilterEnable ? "已启用（点击禁用）" : "已禁用（点击启用）") + "</button>" +
      '<p class="hint" style="margin-left:0">拦截推荐、关注、朋友、精选、用户主页、相关推荐、合集、搜索等接口的视频列表，按规则移除命中的视频。</p></div></div>' +
      '<div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">' +
      '  <button class="btn primary sm" data-act="add">+ 新增规则</button>' +
      '  <button class="btn sm" data-act="import">导入规则 JSON</button>' +
      '  <button class="btn sm" data-act="export">导出规则 JSON</button>' +
      '  <button class="btn sm danger" data-act="clear-all">清空全部</button>' +
      '  <input type="file" id="dy-rf-file" accept=".json,application/json" style="display:none">' +
      '</div>' +
      '<div id="dy-rf-form"></div>' +
      '<table><thead><tr><th style="width:52px">启用</th><th>规则名</th><th>属性</th><th>规则值</th><th>作用域</th><th style="width:110px">操作</th></tr></thead><tbody id="dy-rf-list"></tbody></table>' +
      "<details><summary>规则写法（与原版一致）</summary>" +
      "<p><b>属性名</b>：<code>" + ATTRIBUTE_KEYS.join("</code> <code>") + "</code></p>" +
      "<p><b>字符串属性</b>（desc / nickname / textExtra 等）：规则值按正则匹配，例如 <code>电影|解说</code>；注意 <code>_</code>、<code>+</code> 等需转义。</p>" +
      "<p><b>数值属性</b>（duration / diggCount / collectCount / commentCount / shareCount / liveStreamRoomUserCount / createTime）：规则值用 <code>&gt;</code> <code>&gt;=</code> <code>=</code> <code>&lt;=</code> <code>&lt;</code> 加数字，例如 <code>&lt;180000</code> 过滤时长小于 3 分钟的视频。</p>" +
      "<p><b>布尔属性</b>（isAds / isLive / isFollow / isPicture / isProduct 等）：规则值填 <code>true</code> 或 <code>false</code>。</p>" +
      "<p><b>自定义函数</b>：勾选后规则值为函数体，通过 <code>data.transformAwemeInfo</code> 取字段，<code>return true</code> 表示过滤。例如 <code>return /电影|解说/.test(data.transformAwemeInfo.desc);</code>。fetch 接口支持 <code>await</code>；XHR 接口下异步函数会被跳过。</p>" +
      "<p><b>作用域</b>：规则只在勾选的接口类型生效，<code>all</code> 表示全部。<b>附加条件</b>为 JSON 数组，多组条件之间为 AND。</p>" +
      "<p>存储键 <code>dy-video-filter-rule</code> 与原版相同，可直接导入原脚本导出的规则文件。</p>" +
      "</details>";
    el("dy-rf-tab-filter").innerHTML = html;
    renderRuleList();
    hideForm();
  }

  function renderRuleList() {
    var tbody = el("dy-rf-list");
    if (!tbody) return;
    if (!draftRules.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#86909c;padding:20px">暂无规则，点击「新增规则」开始</td></tr>';
      return;
    }
    var html = "";
    draftRules.forEach(function (r, idx) {
      var d = r.data || {};
      var names = Array.isArray(d.ruleName) ? d.ruleName.join(",") : d.ruleName;
      var scopes = Array.isArray(d.scope) ? d.scope.join(",") : d.scope;
      var val = String(d.ruleValue === undefined ? "" : d.ruleValue);
      if (val.length > 60) val = val.slice(0, 60) + "…";
      html += "<tr>" +
        '<td><button class="btn sm ' + (r.enable !== false ? "on" : "off") + '" data-act="toggle" data-i="' + idx + '">' + (r.enable !== false ? "开" : "关") + "</button></td>" +
        "<td>" + esc(r.name || "未命名") + "</td>" +
        "<td>" + esc(names || "-") + (d.isFunctionHandler ? " <span style='color:#165dff'>[函数]</span>" : "") + "</td>" +
        "<td><code>" + esc(val) + "</code></td>" +
        "<td>" + esc(scopes || "all") + "</td>" +
        '<td><button class="btn sm" data-act="edit" data-i="' + idx + '">编辑</button> ' +
        '<button class="btn sm danger" data-act="del" data-i="' + idx + '">删</button></td>' +
        "</tr>";
    });
    tbody.innerHTML = html;
  }

  function onRuleAction(node) {
    var idx = Number(node.getAttribute("data-i"));
    var act = node.getAttribute("data-act");
    if (act === "toggle") {
      draftRules[idx].enable = draftRules[idx].enable === false;
      saveRules(draftRules);
      renderRuleList();
      showToast("规则「" + (draftRules[idx].name || "") + "」已" + (draftRules[idx].enable ? "启用" : "禁用"));
      return;
    }
    if (act === "del") {
      var name = draftRules[idx].name;
      draftRules.splice(idx, 1);
      saveRules(draftRules);
      renderRuleList();
      hideForm();
      showToast("已删除规则「" + name + "」");
      return;
    }
    if (act === "edit") showForm(idx);
  }

  function scopeCheckboxes(selected) {
    var list = Array.isArray(selected) ? selected : ["all"];
    return '<div class="scopes">' + SCOPE_KEYS.map(function (s) {
      var on = list.indexOf(s) !== -1;
      return '<button type="button" data-act="scope" data-val="' + s + '" data-on="' + (on ? "1" : "0") + '" class="' + (on ? "on" : "") + '">' + s + "</button>";
    }).join("") + "</div>";
  }

  function toggleButton(node) {
    var on = node.getAttribute("data-on") === "1";
    node.setAttribute("data-on", on ? "0" : "1");
    node.className = on ? "" : "on";
    return !on;
  }

  function collectFormFlags() {
    var out = { enable: true, isFunctionHandler: false, scopes: [] };
    var f = el("dy-rf-form");
    if (!f) return out;
    var en = f.querySelector('[data-key="enable"]');
    var fn = f.querySelector('[data-key="isfn"]');
    if (en) out.enable = en.getAttribute("data-on") === "1";
    if (fn) out.isFunctionHandler = fn.getAttribute("data-on") === "1";
    var sc = f.querySelectorAll('[data-act="scope"][data-on="1"]');
    for (var i = 0; i < sc.length; i++) out.scopes.push(sc[i].getAttribute("data-val"));
    if (!out.scopes.length) out.scopes = ["all"];
    return out;
  }

  function showForm(idx) {
    var form = el("dy-rf-form");
    var r = idx === null || idx === undefined
      ? { enable: true, uuid: uuid(), name: "", data: { ruleName: "desc", ruleValue: "", isFunctionHandler: false, remarks: "", scope: ["all"] }, dynamicData: [] }
      : draftRules[idx];
    editingUuid = idx === null || idx === undefined ? null : r.uuid;
    var d = r.data || {};
    var attrOptions = ATTRIBUTE_KEYS.map(function (a) {
      return '<option value="' + a + '"' + (a === d.ruleName ? " selected" : "") + ">" + a + "</option>";
    }).join("");

    form.innerHTML =
      '<div style="font-weight:600;margin-bottom:10px">' + (editingUuid === null ? "新增规则" : "编辑规则") + "</div>" +
      '<div class="row"><label class="lb">规则名</label><div style="flex:1"><input type="text" id="dy-rf-name" value="' + esc(r.name) + '" placeholder="例如：屏蔽电影解说"></div></div>' +
      '<div class="row"><label class="lb">启用</label><div style="flex:1;padding-top:3px"><button type="button" class="tgl ' + (r.enable !== false ? "on" : "") + '" data-act="flag" data-key="enable" data-on="' + (r.enable !== false ? "1" : "0") + '">' + (r.enable !== false ? "已启用" : "已禁用") + "</button></div></div>" +
      '<div class="row"><label class="lb">属性名</label><div style="flex:1"><input type="text" id="dy-rf-attr" list="dy-rf-attrs" value="' + esc(Array.isArray(d.ruleName) ? d.ruleName.join(",") : d.ruleName) + '" placeholder="可多个，逗号分隔"><datalist id="dy-rf-attrs">' + attrOptions + "</datalist></div></div>" +
      '<div class="row"><label class="lb">规则值</label><div style="flex:1"><textarea id="dy-rf-value" placeholder="正则 / 比较式 / 函数体">' + esc(d.ruleValue) + "</textarea></div></div>" +
      '<div class="row"><label class="lb">自定义函数</label><div style="flex:1;padding-top:3px"><button type="button" class="tgl ' + (d.isFunctionHandler ? "on" : "") + '" data-act="flag" data-key="isfn" data-on="' + (d.isFunctionHandler ? "1" : "0") + '">' + (d.isFunctionHandler ? "函数模式：开" : "函数模式：关") + '</button><span style="margin-left:8px;color:#86909c;font-size:12px">开启后规则值作为函数体（return true 表示过滤）</span></div></div>' +
      '<div class="row"><label class="lb">作用域</label><div style="flex:1">' + scopeCheckboxes(d.scope) + "</div></div>" +
      '<div class="row"><label class="lb">备注</label><div style="flex:1"><input type="text" id="dy-rf-remarks" value="' + esc(d.remarks) + '"></div></div>' +
      '<div class="row"><label class="lb">附加条件(AND)</label><div style="flex:1"><textarea id="dy-rf-dynamic" placeholder=\'[{"ruleName":"isAds","ruleValue":"true","isFunctionHandler":false,"remarks":""}]\'>' + esc(Array.isArray(r.dynamicData) && r.dynamicData.length ? JSON.stringify(r.dynamicData) : "") + "</textarea></div></div>" +
      '<div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn sm" data-act="form-cancel">取消</button><button class="btn primary sm" data-act="form-ok">保存规则</button></div>';
    form.style.display = "block";
  }

  function saveForm() {
    var nameNode = el("dy-rf-name");
    if (!nameNode) return;
    var attrRaw = el("dy-rf-attr").value.trim();
    var names = attrRaw.indexOf(",") !== -1 ? attrRaw.split(",").map(function (x) { return x.trim(); }).filter(Boolean) : attrRaw;
    var flags = collectFormFlags();
    var scopes = flags.scopes;
    var dynamicText = el("dy-rf-dynamic").value.trim();
    var dynamic = [];
    if (dynamicText) {
      try {
        var parsed = JSON.parse(dynamicText);
        if (Array.isArray(parsed)) dynamic = parsed;
        else throw new Error("必须是数组");
      } catch (err) {
        showToast("附加条件 JSON 错误：" + err.message);
        return;
      }
    }
    var rule = {
      enable: flags.enable,
      uuid: editingUuid || uuid(),
      name: nameNode.value.trim() || "未命名规则",
      data: {
        scope: scopes,
        ruleName: names,
        ruleValue: el("dy-rf-value").value,
        isFunctionHandler: flags.isFunctionHandler,
        remarks: el("dy-rf-remarks").value
      },
      dynamicData: dynamic
    };
    if (editingUuid === null) draftRules.push(rule);
    else {
      for (var j = 0; j < draftRules.length; j++) {
        if (draftRules[j].uuid === editingUuid) { draftRules[j] = rule; break; }
      }
    }
    saveRules(draftRules);
    hideForm();
    renderRuleList();
    showToast("规则「" + rule.name + "」已保存");
  }

  function hideForm() {
    var f = el("dy-rf-form");
    if (f) { f.style.display = "none"; f.innerHTML = ""; }
    editingUuid = null;
  }

  function saveFilterFromUI() {
    if (draftFilterEnable !== null) sv(KEY.filterEnable, draftFilterEnable);
    if (draftRules !== null) saveRules(draftRules);
  }

  function exportRules() {
    var blob = new Blob([JSON.stringify(draftRules || getRules(), null, 2)], { type: "application/json" });
    var a = doc.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "抖音优化-视频过滤规则.json";
    (doc.body || doc.documentElement).appendChild(a);
    a.click();
    if (a.parentNode) a.parentNode.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    showToast("已导出 " + (draftRules || getRules()).length + " 条规则");
  }

  function importRules(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = JSON.parse(String(reader.result));
        var incoming = Array.isArray(parsed) ? parsed : [parsed];
        incoming = incoming.filter(isObj);
        if (!incoming.length) throw new Error("文件中没有规则");
        var append = win.confirm("点「确定」= 追加到现有规则；点「取消」= 替换全部规则");
        draftRules = append ? (draftRules || getRules()).concat(incoming) : incoming;
        draftRules.forEach(function (r) { if (!r.uuid) r.uuid = uuid(); });
        saveRules(draftRules);
        renderRuleList();
        showToast("已导入 " + incoming.length + " 条规则");
      } catch (err) {
        showToast("导入失败：" + err.message);
      }
      e.target.value = "";
    };
    reader.readAsText(file, "utf-8");
  }

  /* =======================================================================
   * 6. 启动
   * ===================================================================== */

  function init() {
    try {
      // 尽早注册 window 捕获阶段委托，抢在页面脚本之前（document-start）
      ensureDelegates();
      initQuality();
      installFetchHook();
      installXHRHook();
      GM_registerMenuCommand("抖音优化：设置（画质 / 过滤规则）", function () { openPanel(); });
      // 动态菜单名：TamperMonkey 4.x 支持 registerMenu(动态注册)，每次切换后重注册刷新文本
      var menuToggleId = null;
      var menuToggleLabel = function () {
        return (filterEnabled() ? "✅ 视频过滤器：已启用（点击禁用）" : "⛔ 视频过滤器：已禁用（点击启用）");
      };
      var registerToggleMenu = function () {
        try {
          if (typeof GM_unregisterMenuCommand === "function" && menuToggleId !== null) {
            GM_unregisterMenuCommand(menuToggleId);
          }
        } catch (e) {}
        try {
          menuToggleId = GM_registerMenuCommand(menuToggleLabel(), function () {
            var next = !filterEnabled();
            sv(KEY.filterEnable, next);
            showToast((next ? "视频过滤器已启用" : "视频过滤器已禁用") + "，1秒后自动刷新页面…");
            log("视频过滤器已" + (next ? "启用" : "禁用"));
            registerToggleMenu(); // 刷新菜单文本
            // 同步已打开的面板状态（draftFilterEnable 是面板缓存）
            if (el("dy-rf-mask")) {
              draftFilterEnable = next;
              renderFilterTab();
            }
            // 自动刷新页面使新状态对当前已加载的视频流立即生效
            setTimeout(function () {
              try { win.location.reload(); } catch (e) { warn("刷新失败", e); }
            }, 1000);
          });
        } catch (e) {
          warn("菜单注册失败", e);
        }
      };
      registerToggleMenu();
      var menuStatsId = null;
      var registerStatsMenu = function () {
        try {
          if (typeof GM_unregisterMenuCommand === "function" && menuStatsId !== null) GM_unregisterMenuCommand(menuStatsId);
        } catch (e) {}
        try {
          menuStatsId = GM_registerMenuCommand(statsMenuLabel(), function () { openPanel("stats"); });
        } catch (e) {
          warn("统计菜单注册失败", e);
        }
      };
      // 统计菜单只在顶层窗口注册（iframe 注册会残留重复旧条目）；顶层每 3s 检查计数变化后刷新
      var isTopWindow = false;
      try { isTopWindow = win.self === win.top; } catch (e) { isTopWindow = true; }
      if (isTopWindow) {
        statsMenuRefresher = registerStatsMenu;
        registerStatsMenu();
        var lastStatsTotal = getStats().total;
        setInterval(function () {
          var t = getStats().total;
          if (t !== lastStatsTotal) { lastStatsTotal = t; registerStatsMenu(); }
        }, 3000);
      }
      log("已加载。画质策略=" + gv(KEY.qualityMode, "remember") + "，过滤规则=" + getRules().length + " 条，过滤器=" + (filterEnabled() ? "开" : "关"));
      // v1.0.19：从 GM 读取解锁更高画质开关（持久化，刷新不重置）
      unlockQuality = gv("dy-refactor-unlock-quality", false) === true;
      // v1.0.17：启动解锁更高画质监控
      if (unlockQualityTimer) clearInterval(unlockQualityTimer);
      unlockQualityTimer = setInterval(unlockQualityTick, 1000);
    } catch (e) {
      warn("初始化失败", e);
    }
  }

  init();

  /* 本地自测钩子：浏览器中 globalThis.__DY_SELFTEST__ 不存在，无任何副作用 */
  if (typeof globalThis !== "undefined" && typeof globalThis.__DY_SELFTEST__ === "function") {
    globalThis.__DY_SELFTEST__({
      QUALITY_DEFINITIONS: QUALITY_DEFINITIONS,
      getQualityDefinition: getQualityDefinition,
      parseAwemeInfo: parseAwemeInfo,
      matchOne: matchOne,
      compareNumber: compareNumber,
      testMatch: testMatch,
      checkRulesSync: checkRulesSync,
      checkRulesAsync: checkRulesAsync,
      processResponseSync: processResponseSync,
      processResponseAsync: processResponseAsync,
      classify: classify,
      scopeMatches: scopeMatches,
      guessGearTypeFromText: guessGearTypeFromText,
      parseQualityFromStorage: parseQualityFromStorage,
      rememberManualQuality: rememberManualQuality,
      readQualitySession: readQualitySession,
      ATTRIBUTE_KEYS: ATTRIBUTE_KEYS
    });
  }
})();