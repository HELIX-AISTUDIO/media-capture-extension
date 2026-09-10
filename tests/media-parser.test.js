/**
 * ============================================================
 * tests/media-parser.test.js —— js/media-parser.js 纯函数测试
 * 运行：node --test tests/
 * ------------------------------------------------------------
 * 覆盖：classify / normalizeUrl / safeFilename / operatorCheck /
 *       wildcardToRegex / isBlockedPageUrl / applyUserRules 空表回归
 * ============================================================
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadParsers } = require('./helpers/loader.js');

const mp = loadParsers();

// ---------- classify（类型分类） ----------
test('classify: .m3u8 → stream', () => {
  assert.strictEqual(mp.classify('https://a.com/index.m3u8', null), 'stream');
});

test('classify: .mpd → stream', () => {
  assert.strictEqual(mp.classify('https://a.com/dash/manifest.mpd?x=1', null), 'stream');
});

test('classify: .mp4 → video', () => {
  assert.strictEqual(mp.classify('https://a.com/v/a.mp4', 'video/mp4'), 'video');
});

test('classify: .mp3 → audio', () => {
  assert.strictEqual(mp.classify('https://a.com/a/song.mp3', 'audio/mpeg'), 'audio');
});

test('classify: .jpg → image', () => {
  assert.strictEqual(mp.classify('https://a.com/i/p.jpg', 'image/jpeg'), 'image');
});

test('classify: .css → unknown（非媒体）', () => {
  assert.strictEqual(mp.classify('https://a.com/s/main.css', 'text/css'), 'unknown');
});

test('classify: .ts + video mime → video（HLS 分片）', () => {
  assert.strictEqual(mp.classify('https://a.com/seg1.ts', 'video/mp2t'), 'video');
});

test('classify: .ts + 脚本 mime → unknown（.ts 歧义消解）', () => {
  assert.strictEqual(mp.classify('https://a.com/app.ts', 'text/javascript'), 'unknown');
});

test('classify: .ts + mime 未知 → video（宁可保留）', () => {
  assert.strictEqual(mp.classify('https://a.com/seg2.ts', null), 'video');
});

test('classify: 封面图含 -video- 关键字不得误判为视频', () => {
  assert.strictEqual(mp.classify('https://a.com/video-rcmd-cover.avif', 'image/avif'), 'image');
});

test('classify: 无扩展名时按 MIME 兜底', () => {
  assert.strictEqual(mp.classify('https://a.com/stream?id=1', 'video/mp4'), 'video');
  assert.strictEqual(mp.classify('https://a.com/stream?id=1', 'application/vnd.apple.mpegurl'), 'stream');
  assert.strictEqual(mp.classify('https://a.com/stream?id=1', 'application/dash+xml'), 'stream');
});

test('classify: 完全无法判定 → unknown', () => {
  assert.strictEqual(mp.classify('https://a.com/api/data', 'application/json'), 'unknown');
});

// ---------- normalizeUrl（去重归一化） ----------
test('normalizeUrl: 去掉缓存/追踪参数', () => {
  const a = mp.normalizeUrl('https://a.com/v.mp4?_=1&timestamp=9&t=2&rdm=3');
  assert.strictEqual(a, 'https://a.com/v.mp4');
});

test('normalizeUrl: 去掉分片 Range 参数（同一资源收敛成一条）', () => {
  const a = mp.normalizeUrl('https://a.com/v.m4s?bytestart=0&byterange=1000');
  const b = mp.normalizeUrl('https://a.com/v.m4s?bytestart=1000&byterange=2000');
  assert.strictEqual(a, b, '不同分片的 URL 应归一化后相等');
});

test('normalizeUrl: 保留有意义的查询参数', () => {
  assert.strictEqual(mp.normalizeUrl('https://a.com/v.mp4?token=abc'), 'https://a.com/v.mp4?token=abc');
});

test('normalizeUrl: 非法 URL 原样返回，不抛异常', () => {
  assert.strictEqual(mp.normalizeUrl('not a url'), 'not a url');
});

// ---------- safeFilename（非法字符 / 超长） ----------
test('safeFilename: 去掉 Windows/URL 非法字符', () => {
  assert.strictEqual(mp.safeFilename('a/b:c*d?e"f<g>h|i~j'), 'a_b_c_d_e_f_g_h_i_j');
});

test('safeFilename: 去掉首尾点与空格 + 压缩连续空格', () => {
  assert.strictEqual(mp.safeFilename('  ..name   with  spaces..  '), 'name with spaces');
});

test('safeFilename: 超长名截断到 180 且保留扩展名', () => {
  const long = 'x'.repeat(300) + '.mp4';
  const out = mp.safeFilename(long);
  assert.ok(out.length <= 180, '长度应 ≤180');
  assert.ok(out.endsWith('.mp4'), '应保留扩展名');
});

test('safeFilename: 空输入回退为 resource', () => {
  assert.strictEqual(mp.safeFilename(''), 'resource');
  assert.strictEqual(mp.safeFilename(null), 'resource');
});

// ---------- operatorCheck（含 ~ 区间与非法输入） ----------
test('operatorCheck: 常规比较符', () => {
  // size 参数是字节数；rule.size 与 rule.unit 用 sizeToBytes 转字节后比较
  const FIVE_HUNDRED_KB = 500 * 1024;
  assert.strictEqual(mp.operatorCheck(600 * 1024, { operator: '>=', size: '500', unit: 'KB' }), true);
  assert.strictEqual(mp.operatorCheck(400 * 1024, { operator: '>=', size: '500', unit: 'KB' }), false);
  assert.strictEqual(mp.operatorCheck(400 * 1024, { operator: '<', size: '500', unit: 'KB' }), true);
  assert.strictEqual(mp.operatorCheck(FIVE_HUNDRED_KB,    { operator: '=', size: '500', unit: 'KB' }), true);
});

test('operatorCheck: ~ 区间命中/不命中', () => {
  assert.strictEqual(mp.operatorCheck(800 * 1024, { operator: '~', size: '500-1000', unit: 'KB' }), true);
  assert.strictEqual(mp.operatorCheck(1200 * 1024, { operator: '~', size: '500-1000', unit: 'KB' }), false);
});

test('operatorCheck: 非法输入一律 false（不抛异常）', () => {
  assert.strictEqual(mp.operatorCheck(null, { operator: '>=', size: '500' }), false);
  assert.strictEqual(mp.operatorCheck(100, null), false);
  assert.strictEqual(mp.operatorCheck(100, { operator: '~', size: 'abc-def' }), false);
  assert.strictEqual(mp.operatorCheck(100, { operator: '>>', size: '500' }), false);
});

// ---------- wildcardToRegex ----------
test('wildcardToRegex: * 与 ? 语义', () => {
  const re = mp.wildcardToRegex('*://*.example.com/*');
  assert.ok(re.test('https://v.example.com/a/b'));
  assert.ok(!re.test('https://v.other.com/a/b'));
  assert.ok(mp.wildcardToRegex('a?c').test('abc'));
  assert.ok(!mp.wildcardToRegex('a?c').test('abbc'));
});

test('wildcardToRegex: 正则元字符被转义（点号不当通配）', () => {
  const re = mp.wildcardToRegex('1.2.3.4');
  assert.ok(re.test('1.2.3.4'));
  assert.ok(!re.test('1x2x3x4'), "`.` 应被转义为字面量点号");
});

// ---------- 黑名单 / 空表回归 ----------
test('isBlockedPageUrl: 空列表不生效（始终放行）', () => {
  mp.setUserRules({ blockUrl: { list: [], white: false } });
  assert.strictEqual(mp.isBlockedPageUrl('https://a.com/p'), false);
  mp.setUserRules({ blockUrl: { list: [], white: true } });
  assert.strictEqual(mp.isBlockedPageUrl('https://a.com/p'), false, '白名单模式空表也不应全拦');
});

test('isBlockedPageUrl: 黑名单/白名单模式生效', () => {
  mp.setUserRules({ blockUrl: { list: ['*://*.bad.com/*'], white: false } });
  assert.strictEqual(mp.isBlockedPageUrl('https://v.bad.com/x'), true);
  assert.strictEqual(mp.isBlockedPageUrl('https://v.good.com/x'), false);
  mp.setUserRules({ blockUrl: { list: ['*://*.good.com/*'], white: true } });
  assert.strictEqual(mp.isBlockedPageUrl('https://v.good.com/x'), false);
  assert.strictEqual(mp.isBlockedPageUrl('https://v.other.com/x'), true);
});

test('回归：规则表为空时 applyUserRules 一律返回 unknown（等价于默认行为）', () => {
  mp.setUserRules({}); // 空表（各子表均为空数组）
  const urls = [];
  const mimes = ['video/mp4', 'audio/mpeg', 'image/jpeg', 'application/vnd.apple.mpegurl', null];
  const sizes = [null, 0, 1024, 5 * 1024 * 1024];
  // 构造 100 组（url 5 类 × mime 5 类 × size 4 类）
  const bases = [
    'https://a.com/v.mp4', 'https://a.com/a.mp3', 'https://a.com/i.jpg',
    'https://a.com/s.m3u8', 'https://a.com/x.bin'
  ];
  for (const b of bases) for (const m of mimes) for (const s of sizes) urls.push([b, m, s]);
  assert.strictEqual(urls.length, 100);
  let mismatch = 0;
  for (const [u, m, s] of urls) {
    const r = mp.applyUserRules(u, m, s);
    if (r.verdict !== 'unknown' || r.url !== u) mismatch++;
  }
  assert.strictEqual(mismatch, 0, '空规则表必须完全交回默认闸门');
});
