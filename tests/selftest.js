/* 本地自测：用 Node vm 载入油猴脚本，stub 浏览器/GM 环境，验证核心纯逻辑 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const scriptPath = path.join(__dirname, "..", "douyin-optimized-lite.user.js");
const code = fs.readFileSync(scriptPath, "utf8");

let API = null;
const store = {};

const doc = {
  readyState: "complete",
  head: { appendChild() {} },
  documentElement: { appendChild() {} },
  body: { appendChild() {}, removeChild() {} },
  addEventListener() {},
  getElementById() { return null; },
  createElement() { return { style: {}, addEventListener() {}, click() {}, appendChild() {} }; }
};

const win = {
  document: doc,
  location: { href: "https://www.douyin.com/?recommend=1" },
  history: { pushState() {}, replaceState() {} },
  sessionStorage: Object.assign(
    Object.create({
      getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
      setItem(k, v) { this._d[k] = String(v); }
    }),
    { _d: {} }
  ),
  addEventListener() {},
  fetch() { return Promise.resolve({ text: () => Promise.resolve("{}"), json: () => Promise.resolve({}) }); },
  confirm() { return true; },
  alert() {}
};

function XHR() {}
XHR.prototype.open = function () {};
XHR.prototype.send = function () {};
Object.defineProperty(XHR.prototype, "responseText", { configurable: true, get() { return ""; } });
Object.defineProperty(XHR.prototype, "response", { configurable: true, get() { return ""; } });
win.XMLHttpRequest = XHR;

const sandbox = {
  console,
  URL,
  Blob: class {},
  FileReader: class {},
  Promise,
  Map,
  Set,
  JSON,
  Math,
  Date,
  RegExp,
  Number,
  String,
  Object,
  Array,
  Boolean,
  Function,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  window: win,
  unsafeWindow: win,
  GM_getValue(k, d) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : d; },
  GM_setValue(k, v) { store[k] = v; },
  GM_deleteValue(k) { delete store[k]; },
  GM_registerMenuCommand() {},
  __DY_SELFTEST__(api) { API = api; }
};
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: scriptPath });

if (!API) throw new Error("自测钩子未被调用");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? " -> " + JSON.stringify(extra) : "")); }
}
function section(t) { console.log("\n== " + t + " =="); }

/* ---------- 1. 画质档位 ---------- */
section("画质档位");
ok("共 8 档", API.QUALITY_DEFINITIONS.length === 8, API.QUALITY_DEFINITIONS.length);
ok("-2 => 超清 4K", API.getQualityDefinition(-2).gearName === "超清 4K");
ok("1 => 1080P / qualityType=1", API.getQualityDefinition(1).gearName === "高清 1080P" && API.getQualityDefinition(1).qualityType === 1);
ok("0 => 智能", API.getQualityDefinition(0).gearName === "智能");
ok("-999 => 无", API.getQualityDefinition(-999).gearName === "无");
ok("未知 => null", API.getQualityDefinition(999) === null);
ok("手动选择文本 4K", API.guessGearTypeFromText("超清 4K") === -2);
ok("手动选择文本 1080P", API.guessGearTypeFromText("高清 1080P") === 1);
ok("手动选择文本 自动", API.guessGearTypeFromText("自动") === 0);

/* ---------- 2. 字段解析 ---------- */
section("字段解析");
const aweme = {
  aweme_id: "7123456789",
  desc: "这是一条电影解说视频 #电影 #解说",
  create_time: 1767196800,
  aweme_type: 1,
  author: { nickname: "测试作者", uid: "u123", follow_status: 1, custom_verify: "剧情创作者", enterprise_verify_reason: "" },
  statistics: { collect_count: 10, comment_count: 20, digg_count: 300, share_count: 5 },
  video: {
    width: 1920, height: 1080, duration: 250000,
    bit_rate: [{ bit_rate: 5000, gear_name: "1080P", quality_type: 1, FPS: 30, format: "mp4", play_addr: { url_list: ["https://a.mp4", "https://b.mp4"], data_size: 999, width: 1920, height: 1080 } }],
    cover: { url_list: ["https://cover.jpg"] }
  },
  music: { album: "专辑", author: "音乐人", duration: 30, title: "原声", play_url: { url_list: ["https://m.mp3", "https://m2.mp3"] } },
  text_extra: [{ hashtag_name: "电影" }, { hashtag_name: "解说" }],
  video_tag: [{ tag_name: "影视", tag_id: 88 }],
  risk_infos: { content: "作者声明：虚构演绎" },
  is_ads: false,
  mix_info: { mix_name: "测试合集", desc: "合集描述" }
};
const info = API.parseAwemeInfo(aweme);
ok("awemeId", info.awemeId === "7123456789");
ok("nickname / uid", info.nickname === "测试作者" && info.uid === "u123");
ok("desc 原文", info.desc.indexOf("电影解说") !== -1);
ok("originDesc 去话题", info.originDesc.indexOf("#") === -1 && info.originDesc.indexOf("电影解说") !== -1, info.originDesc);
ok("createTime 秒转毫秒", info.createTime === 1767196800000, info.createTime);
ok("width/height/duration", info.width === 1920 && info.height === 1080 && info.duration === 250000);
ok("statistics", info.diggCount === 300 && info.collectCount === 10 && info.commentCount === 20 && info.shareCount === 5);
ok("textExtra", info.textExtra.length === 2 && info.textExtra[0] === "电影");
ok("videoTag / videoTagId", info.videoTag[0] === "影视" && info.videoTagId[0] === "88");
ok("music 字段", info.musicTitle === "原声" && info.musicUrl === "https://m.mp3" && info.musicBackUrlList.length === 1);
ok("riskInfoContent", info.riskInfoContent === "作者声明：虚构演绎");
ok("mixInfo / isMixInfo", info.mixInfoName === "测试合集" && info.isMixInfo === true);
ok("isFollow / isAds / isPicture", info.isFollow === true && info.isAds === false && info.isPicture === false);
ok("videoBitRateList", info.videoBitRateList.length === 1 && info.videoBitRateList[0].gearName === "1080P" && info.videoBitRateList[0].url === "https://a.mp4");
ok("isAds 由 is_ads 判定", API.parseAwemeInfo({ is_ads: true }).isAds === true);
ok("isAds 由 raw_ad_data 判定", API.parseAwemeInfo({ raw_ad_data: "xxx" }).isAds === true);
ok("isPicture 由 aweme_type=68 判定", API.parseAwemeInfo({ aweme_type: 68 }).isPicture === true);
ok("直播 cell_room", (() => { const d = API.parseAwemeInfo({ cell_room: { rawdata: JSON.stringify({ title: "直播间", user_count: 1234, owner: { web_rid: "999", nickname: "主播" } }) } }); return d.isLive && d.liveStreamRoomTitle === "直播间" && d.liveStreamRoomUserCount === 1234; })());
ok("属性名覆盖官方模板", ["awemeId","nickname","desc","duration","isAds","videoBitRateList","pictureList","mixInfoName","seriesName","isProduct"].every(k => API.ATTRIBUTE_KEYS.includes(k)));

/* ---------- 3. 匹配语义 ---------- */
section("匹配语义");
ok("正则 命中", API.testMatch("电影解说好看", "电影|解说") === true);
ok("正则 未命中", API.testMatch("美食教程", "电影|解说") === false);
ok("非法正则退化为包含", API.testMatch("a[b", "[") === true);
ok("> 180000", API.compareNumber(250000, ">180000") === true);
ok(">= 250000", API.compareNumber(250000, ">=250000") === true);
ok("< 180000 不命中", API.compareNumber(250000, "<180000") === false);
ok("<= 250000", API.compareNumber(250000, "<=250000") === true);
ok("= 300 命中 digg", API.compareNumber(300, "=300") === true);
ok("非法比较符返回 false", API.compareNumber(300, "300") === false);
ok("matchOne 字符串正则", API.matchOne(info.desc, { ruleName: "desc", ruleValue: "电影|解说" }, info) === true);
ok("matchOne 数值比较", API.matchOne(info.duration, { ruleName: "duration", ruleValue: ">180000" }, info) === true);
ok("matchOne 布尔", API.matchOne(info.isAds, { ruleName: "isAds", ruleValue: "false" }, info) === true);
ok("matchOne 数组标签", API.matchOne(info.textExtra, { ruleName: "textExtra", ruleValue: "解说" }, info) === true);
ok("matchOne null 值", API.matchOne(info.productId, { ruleName: "productId", ruleValue: "x" }, info) === false);
ok("matchOne 自定义函数", API.matchOne(info.desc, { ruleName: "desc", isFunctionHandler: true, ruleValue: "return /电影|解说/.test(data.transformAwemeInfo.desc);" }, info) === true);
ok("matchOne 自定义函数 false", API.matchOne(info.desc, { ruleName: "desc", isFunctionHandler: true, ruleValue: "return false;" }, info) === false);
ok("自定义函数可取原始 aweme", API.matchOne(info.desc, { ruleName: "desc", isFunctionHandler: true, ruleValue: "return data.awemeInfo.aweme_id === '7123456789';" }, info) === true);
ok("__rawAweme 不可枚举", Object.keys(info).indexOf("__rawAweme") === -1);

/* ---------- 4. 规则集 / 作用域 / AND 条件 ---------- */
section("规则集");
const rule1 = { enable: true, uuid: "r1", name: "屏蔽解说", data: { scope: ["all"], ruleName: "desc", ruleValue: "电影|解说", isFunctionHandler: false, remarks: "" }, dynamicData: [] };
const rule2 = { enable: true, uuid: "r2", name: "仅推荐页屏蔽广告", data: { scope: ["xhr-tab"], ruleName: "isAds", ruleValue: "true", isFunctionHandler: false, remarks: "" }, dynamicData: [] };
const rule3 = { enable: false, uuid: "r3", name: "已禁用", data: { scope: ["all"], ruleName: "desc", ruleValue: "测试", isFunctionHandler: false, remarks: "" }, dynamicData: [] };
const rule4 = { enable: true, uuid: "r4", name: "AND 条件", data: { scope: ["all"], ruleName: "desc", ruleValue: "电影", isFunctionHandler: false, remarks: "" }, dynamicData: [{ ruleName: "diggCount", ruleValue: ">100", isFunctionHandler: false, remarks: "" }] };
const rule5 = { enable: true, uuid: "r5", name: "AND 不成立", data: { scope: ["all"], ruleName: "desc", ruleValue: "电影", isFunctionHandler: false, remarks: "" }, dynamicData: [{ ruleName: "diggCount", ruleValue: "<100", isFunctionHandler: false, remarks: "" }] };
const allRules = [rule1, rule2, rule3, rule4, rule5];
ok("命中 rule1", API.checkRulesSync(allRules, info, "xhr-userHome").uuid === "r1");
ok("规则禁用不生效", API.checkRulesSync([rule3], info, "xhr-tab") === null);
ok("作用域 all 生效", API.scopeMatches(["all"], "xhr-search") === true);
ok("作用域不匹配", API.scopeMatches(["xhr-tab"], "xhr-userHome") === false);
ok("作用域匹配", API.scopeMatches(["xhr-tab"], "xhr-tab") === true);
ok("AND 条件均命中", API.checkRulesSync([rule4], info, "xhr-tab").uuid === "r4");
ok("AND 条件不成立则不过滤", API.checkRulesSync([rule5], info, "xhr-tab") === null);
ok("规则名支持数组", API.checkRulesSync([{ enable: true, uuid: "rx", data: { scope: ["all"], ruleName: ["nickname", "desc"], ruleValue: "电影", isFunctionHandler: false } }], info, "xhr-tab").uuid === "rx");
ok("无规则返回 null", API.checkRulesSync([], info, "xhr-tab") === null);

/* ---------- 5. 接口分类 ---------- */
section("接口分类");
[
  ["https://www.douyin.com/aweme/v1/web/tab/feed/?a=1", "xhr-tab", 1],
  ["https://www.douyin.com/aweme/v1/web/aweme/post/?a=1", "xhr-userHome", 1],
  ["https://www.douyin.com/aweme/v1/web/mix/aweme/", "xhr-mix", 1],
  ["https://www.douyin.com/aweme/v1/web/aweme/related/", "xhr-related", 1],
  ["https://www.douyin.com/aweme/v1/web/follow/feed/", "xhr-follow", 2],
  ["https://www.douyin.com/aweme/v1/web/familiar/feed/", "xhr-familiar", 2],
  ["https://www.douyin.com/aweme/v1/web/module/feed/", "xhr-module", 3],
  ["https://www.douyin.com/aweme/v2/web/module/feed/", "xhr-module", 1],
  ["https://www.douyin.com/aweme/v1/web/general/search/single/", "xhr-search", 4],
  ["https://www.douyin.com/aweme/v1/web/search/item/", "xhr-search", 4]
].forEach(([u, s, t]) => {
  const m = API.classify(u);
  ok(u.split("?")[0].split("/aweme/")[1], !!m && m.scope === s && m.type === t, m);
});
ok("无关接口忽略", API.classify("https://www.douyin.com/aweme/v1/web/aweme/detail/") === null);

/* ---------- 6. 响应改写 ---------- */
section("响应改写");
const goodAweme = { aweme_id: "good", desc: "美食教程", author: { nickname: "厨师" }, video: {}, statistics: {} };
const badAweme = { aweme_id: "bad", desc: "电影解说合集", author: { nickname: "影视君" }, video: {}, statistics: {} };

const t1 = JSON.stringify({ status_code: 0, aweme_list: [goodAweme, badAweme, goodAweme] });
const r1 = API.processResponseSync({ scope: "xhr-tab", type: 1 }, t1, [rule1]);
ok("type1 移除 1 项", r1.removed === 1 && JSON.parse(r1.text).aweme_list.length === 2, r1);
ok("type1 保留未命中项", JSON.parse(r1.text).aweme_list[0].aweme_id === "good");
ok("无命中不改写原文", API.processResponseSync({ scope: "xhr-tab", type: 1 }, JSON.stringify({ aweme_list: [goodAweme] }), [rule1]).text === JSON.stringify({ aweme_list: [goodAweme] }));

const t2 = JSON.stringify({ status_code: 0, data: [{ aweme: goodAweme }, { aweme: badAweme }] });
const r2 = API.processResponseSync({ scope: "xhr-follow", type: 2 }, t2, [rule1]);
ok("type2 data[].aweme", r2.removed === 1 && JSON.parse(r2.text).data.length === 1, r2);

const t3 = JSON.stringify({ cards: [{ aweme: JSON.stringify(goodAweme) }, { aweme: JSON.stringify(badAweme) }] });
const r3 = API.processResponseSync({ scope: "xhr-module", type: 3 }, t3, [rule1]);
ok("type3 cards[].aweme(JSON字符串)", r3.removed === 1 && JSON.parse(r3.text).cards.length === 1, r3);

const t4 = JSON.stringify({ data: [{ aweme_info: goodAweme }, { aweme_info: badAweme }, { aweme_mix_info: { mix_items: [goodAweme, badAweme] } }] });
const r4 = API.processResponseSync({ scope: "xhr-search", type: 4 }, t4, [rule1]);
const d4 = JSON.parse(r4.text);
ok("type4 aweme_info 过滤", r4.removed === 2 && d4.data.length === 2, r4);
ok("type4 mix_items 过滤后剩 1 项", d4.data[1].aweme_mix_info.mix_items.length === 1);

const t5 = JSON.stringify({ aweme_list: [badAweme, badAweme, goodAweme] });
const r5 = API.processResponseSync({ scope: "xhr-tab", type: 1 }, t5, [rule1]);
ok("连续命中连续 splice 不漏项", r5.removed === 2 && JSON.parse(r5.text).aweme_list.length === 1, r5);

/* ---------- 7. 异步规则 ---------- */
section("异步规则（fetch 路径）");
(async () => {
  const asyncRule = {
    enable: true, uuid: "ra", name: "await 函数",
    data: { scope: ["all"], ruleName: "desc", isFunctionHandler: true, ruleValue: "return await Promise.resolve(true);", remarks: "" },
    dynamicData: []
  };
  const hitA = await API.checkRulesAsync([asyncRule], info, "xhr-tab");
  ok("await 自定义函数在 fetch 路径生效", !!hitA && hitA.uuid === "ra", hitA);
  ok("await 自定义函数在 XHR 同步路径跳过", API.checkRulesSync([asyncRule], info, "xhr-tab") === null);

  const ar = await API.processResponseAsync({ scope: "xhr-tab", type: 1 }, t1, [asyncRule]);
  ok("异步响应改写移除全部", ar.removed === 3, ar);

  console.log("\n========================================");
  console.log("PASS: " + pass + "   FAIL: " + fail);
  console.log("========================================");
  if (fail > 0) process.exit(1);
})();

/* ---------- 8. v1.0.2 画质记忆（sessionStorage 路径） ---------- */
(async () => {
  console.log("\n== v1.0.2 画质记忆 ==");
  const A2 = API;
  const ss = win.sessionStorage;

  ok("parseQuality gearType 数字", A2.parseQualityFromStorage(JSON.stringify({gearType:1,gearName:"高清 1080P"})) === 1);
  ok("parseQuality 仅 gearName", A2.parseQualityFromStorage(JSON.stringify({gearName:"超清 4K"})) === -2);
  ok("parseQuality 裸字符串 720P", A2.parseQualityFromStorage("高清 720P") === 2);
  ok("parseQuality 裸字符串 4K", A2.parseQualityFromStorage("4K") === -2);
  ok("parseQuality 非法输入 null", A2.parseQualityFromStorage("乱码") === null);
  ok("parseQuality null/undefined", A2.parseQualityFromStorage(null) === null && A2.parseQualityFromStorage(undefined) === null);

  // 模拟抖音播放器手动写入 MANUAL_SWITCH → 脚本应记住（hook 已在 init 时安装）
  ss.setItem("MANUAL_SWITCH", JSON.stringify({done:1,gearClarity:"5",qualityType:1,gearName:"高清 1080P",gearType:1,clarityReal:[]}));
  await new Promise(r => setTimeout(r, 100));
  ok("抖音写入 MANUAL_SWITCH 被记住", store["dy-refactor-quality-remembered"] === 1, store["dy-refactor-quality-remembered"]);
  ok("记忆时间戳已记录", typeof store["dy-refactor-quality-remembered-at"] === "number");

  ss.setItem("MANUAL_SWITCH", JSON.stringify({done:1,gearClarity:"20",qualityType:72,gearName:"超清 4K",gearType:-2,clarityReal:[]}));
  await new Promise(r => setTimeout(r, 100));
  ok("再次切换更新记忆为 4K", store["dy-refactor-quality-remembered"] === -2);

  // readQualitySession 展示
  ok("readQualitySession 显示 gearName", A2.readQualitySession().indexOf("超清 4K") !== -1, A2.readQualitySession());

  // 轮询兜底路径（绕过 setItem，直接改内部 _d）
  ss._d["MANUAL_SWITCH"] = JSON.stringify({done:1,gearName:"高清 720P",gearType:2});
  await new Promise(r => setTimeout(r, 1800));
  ok("轮询兜底捕获绕写", store["dy-refactor-quality-remembered"] === 2, store["dy-refactor-quality-remembered"]);

  console.log("\n========================================");
  console.log("TOTAL(v1.0.2 追加) PASS: " + (pass) + "  本段 FAIL: " + fail);
  console.log("========================================");
  if (fail > 0) process.exit(1);
})();
