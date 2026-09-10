/**
 * ============================================================
 * tests/m3u8-parser.test.js —— js/m3u8-parser.js 解析测试
 * 运行：node --test tests/
 * ------------------------------------------------------------
 * 覆盖：多码率嵌套、相对路径转绝对、EXT-X-KEY、EXT-X-MAP、音轨标记、分片去重
 * ============================================================
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadParsers } = require('./helpers/loader.js');

const p = loadParsers();
const BASE = 'https://cdn.example.com/hls/master.m3u8';

test('parseM3u8: 主播放列表 → 解析出多码率嵌套播放列表', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=720x480',
    'low/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1280x720',
    'high/index.m3u8'
  ].join('\n');
  const r = p.parseM3u8(text, BASE);
  assert.strictEqual(r.playlists.length, 2, '应解析出 2 个码率');
  assert.strictEqual(r.playlists[0].bandwidth, 1280000);
  assert.strictEqual(r.playlists[0].resolution, '720x480');
  assert.strictEqual(r.playlists[1].bandwidth, 2560000);
  assert.strictEqual(r.segments.length, 0, '主播放列表不应产出分片');
});

test('parseM3u8: 相对路径转绝对 URL（基于 m3u8 自身地址）', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=1280000',
    'low/index.m3u8'
  ].join('\n');
  const r = p.parseM3u8(text, BASE);
  assert.strictEqual(r.playlists[0].url, 'https://cdn.example.com/hls/low/index.m3u8');
});

test('parseM3u8: 媒体播放列表 → 分片数量与绝对地址', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:10',
    '#EXTINF:10.0,',
    'seg0.ts',
    '#EXTINF:10.0,',
    'seg1.ts'
  ].join('\n');
  const r = p.parseM3u8(text, BASE);
  assert.strictEqual(r.segments.length, 2);
  assert.strictEqual(r.segments[0].url, 'https://cdn.example.com/hls/seg0.ts');
  assert.strictEqual(r.segments[0].duration, 10);
  assert.strictEqual(r.playlists.length, 0);
});

test('parseM3u8: 分片去重（相同 URL 只保留一条）', () => {
  const text = [
    '#EXTM3U',
    '#EXTINF:10.0,',
    'seg0.ts',
    '#EXTINF:10.0,',
    'seg0.ts',
    '#EXTINF:10.0,',
    'seg1.ts'
  ].join('\n');
  const r = p.parseM3u8(text, BASE);
  assert.strictEqual(r.segments.length, 2, '重复分片必须被去掉');
  assert.strictEqual(r.segments[1].url, 'https://cdn.example.com/hls/seg1.ts');
});

test('parseM3u8: EXT-X-KEY 识别（method/uri/iv）', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.key",IV=0x1234567890abcdef1234567890abcdef',
    '#EXTINF:10.0,',
    'seg0.ts'
  ].join('\n');
  const r = p.parseM3u8(text, BASE);
  assert.strictEqual(r.keys.length, 1);
  assert.strictEqual(r.keys[0].method, 'AES-128');
  assert.strictEqual(r.keys[0].uri, 'https://cdn.example.com/hls/key.key');
  assert.ok(/^0x/i.test(r.keys[0].iv));
});

test('parseM3u8: EXT-X-MAP 初始化段与音轨标记', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="音频"',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:10.0,',
    'seg0.m4s'
  ].join('\n');
  const r = p.parseM3u8(text, BASE);
  assert.strictEqual(r.map, 'https://cdn.example.com/hls/init.mp4');
  assert.strictEqual(r.mediaType, 'audio');
});

test('parseM3u8: BYTERANGE 记录到分片', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-BYTERANGE:1000@0',
    '#EXTINF:10.0,',
    'all.ts'
  ].join('\n');
  const r = p.parseM3u8(text, BASE);
  assert.strictEqual(r.segments.length, 1);
  assert.strictEqual(r.segments[0].byterange, '1000@0');
});

test('parseM3u8: 空/非法输入返回空结果，不抛异常', () => {
  const r1 = p.parseM3u8('', BASE);
  assert.deepStrictEqual([r1.playlists.length, r1.segments.length], [0, 0]);
  const r2 = p.parseM3u8(null, BASE);
  assert.deepStrictEqual([r2.playlists.length, r2.segments.length], [0, 0]);
});

test('resolveUrl: 绝对地址原样返回，相对地址按 base 拼接', () => {
  assert.strictEqual(p.resolveUrl(BASE, 'https://x.com/a.ts'), 'https://x.com/a.ts');
  assert.strictEqual(p.resolveUrl(BASE, '../up/a.ts'), 'https://cdn.example.com/up/a.ts');
});
