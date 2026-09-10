#!/usr/bin/env node
/**
 * ============================================================
 * tools/build.js —— 零依赖打包 + 完整性校验脚本
 * ------------------------------------------------------------
 * 用途：
 *   1. 把扩展打包成 dist/<name>-v<version>.zip（version 从 manifest.json 读取）
 *   2. 打包后做完整性校验，防止"只按 manifest 引用打包"的打包器漏文件
 *
 * 为什么要自己写（不引第三方库）：
 *   项目坚持零第三方依赖；且历史上 img/gray16/48/128.png（暂停态灰图标）
 *   只被 js/background.js 的 ICON_OFF 字符串引用、不在 manifest 中声明，
 *   一旦漏打包就会让"暂停嗅探"的置灰图标失效 → 故脚本第 2 项校验会
 *   扫描源码里的 img/*.png 字符串并逐个确认已在包内。
 *
 * 用法：
 *   node tools/build.js               # 打包 + 校验
 *   node tools/build.js --check-only  # 只校验，不产出 zip
 *
 * 退出码：0 = 全部通过；1 = 运行期异常；2 = 完整性校验失败
 * ============================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist');

// ---------- 打包范围 ----------
// 顶层需要整体打包的目录
const INCLUDE_DIRS = ['css', 'js', 'img', 'lib', 'docs', '_locales'];
// 根目录下需要打包的单个文件（manifest 必打）与其扩展名白名单
const ROOT_FILE = 'manifest.json';
const INCLUDE_ROOT_EXT = ['.html', '.md', '.txt'];

// ---------- 排除规则 ----------
// 目录/文件名（任意层级）命中即排除
const EXCLUDE_NAMES = new Set([
  '.git', '.github', '.vscode', '.idea', '.svn', '.hg',
  'node_modules', 'dist', 'tools', 'tests',
  '.DS_Store', 'Thumbs.db'
]);
// 目录名前缀/模式命中即排除（临时目录、QA/校验脚本目录等）
const EXCLUDE_DIR_RE = /^_(?!locales$)|^(\.|_)?(qa|verify|verify2|tmp|temp|bak|old)[-_.]?/i;

/** 判断相对路径中的某一层是否应被排除。 */
function isExcludedName(name, isDir) {
  if (EXCLUDE_NAMES.has(name)) return true;
  if (!isDir) return false;
  // 排除下划线开头的目录（_locales 例外，它是 Chrome 标准语言目录）
  return EXCLUDE_DIR_RE.test(name);
}

/**
 * 收集待打包文件（相对 ROOT 的 posix 路径，已排序）。
 * @returns {string[]}
 */
function collectFiles() {
  const out = [];

  // 根目录：manifest.json + *.html/*.md/*.txt
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (isExcludedName(name, false)) continue;
    if (name === ROOT_FILE || INCLUDE_ROOT_EXT.includes(path.extname(name).toLowerCase())) {
      out.push(name);
    }
  }

  // 子目录白名单：递归收集
  const walk = (relDir) => {
    const abs = path.join(ROOT, relDir);
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      const rel = relDir + '/' + entry.name;
      if (isExcludedName(entry.name, entry.isDirectory())) continue;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  for (const dir of INCLUDE_DIRS) walk(dir);

  return out.sort();
}

// ---------- ZIP 写入（最小实现：deflate + 中央目录 + EOCD） ----------
let crcTableCache = null;
/** 生成 CRC32 查表。 */
function crcTable() {
  if (crcTableCache) return crcTableCache;
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  crcTableCache = table;
  return table;
}

/** 计算缓冲区 CRC32。 */
function crc32(buf) {
  const table = crcTable();
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** 取当前时间/日期的 DOS 格式字段。 */
function dosDateTime() {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

/**
 * 把文件列表写成 zip。
 * @param {string[]} files 相对 ROOT 的路径
 * @param {string} outPath 输出 zip 绝对路径
 */
function writeZip(files, outPath) {
  const { time, date } = dosDateTime();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const rel of files) {
    const data = fs.readFileSync(path.join(ROOT, rel));
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const nameBuf = Buffer.from(rel, 'utf8');
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);   // 本地文件头签名
    lh.writeUInt16LE(20, 4);           // 解压所需版本
    lh.writeUInt16LE(0, 6);            // 通用标志位
    lh.writeUInt16LE(8, 8);            // 压缩方法：8 = deflate
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);           // extra 长度
    locals.push(lh, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);   // 中央目录签名
    cd.writeUInt16LE(20, 4);           // 创建版本
    cd.writeUInt16LE(20, 6);           // 解压所需版本
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);           // extra
    cd.writeUInt16LE(0, 32);           // 注释
    cd.writeUInt16LE(0, 34);           // 起始磁盘号
    cd.writeUInt16LE(0, 36);           // 内部属性
    cd.writeUInt32LE(0, 38);           // 外部属性
    cd.writeUInt32LE(offset, 42);      // 本地头偏移
    centrals.push(cd, nameBuf);

    offset += lh.length + nameBuf.length + comp.length;
  }

  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.concat(locals.concat([cdBuf, eocd])));
}

// ---------- 完整性校验 ----------
/** 从 manifest 收集所有被引用的相对文件路径。 */
function manifestRefs(manifest) {
  const refs = [];
  const push = (p) => { if (typeof p === 'string' && p && !/^([a-z]+:)?\/\//i.test(p)) refs.push(p); };
  const pushMap = (obj) => { if (obj && typeof obj === 'object') Object.keys(obj).forEach((k) => push(obj[k])); };

  pushMap(manifest.icons);
  if (manifest.action) {
    pushMap(manifest.action.default_icon);
    push(manifest.action.default_popup);
  }
  if (manifest.side_panel) push(manifest.side_panel.default_path);
  if (manifest.options_ui) push(manifest.options_ui.page);
  if (manifest.background) {
    push(manifest.background.service_worker);
    (manifest.background.scripts || []).forEach(push);
  }
  (manifest.content_scripts || []).forEach((cs) => (cs.js || []).forEach(push));
  (manifest.web_accessible_resources || []).forEach((w) => {
    if (typeof w === 'string') push(w);
    else if (w && Array.isArray(w.resources)) w.resources.forEach(push);
  });
  return Array.from(new Set(refs));
}

/**
 * 扫描源码文本里出现的 img/xxx.png 之类资源引用。
 * 专门防"只在 JS 里引用、不在 manifest 声明"的图标（灰图标）漏打包。
 */
const ASSET_RE = /(['"`(])((?:img|css|js|lib)\/[A-Za-z0-9_\-./]+\.(?:png|jpe?g|gif|svg|webp|ico|woff2?))/gi;

/**
 * 执行完整性校验。
 * @param {string[]} files 包内文件（相对路径）
 * @param {object} manifest 已解析的 manifest
 * @returns {{errors:string[], stats:object}}
 */
function verifyPackage(files, manifest) {
  const inPkg = new Set(files);
  const errors = [];

  // 1) manifest 引用文件是否都在包内
  const refs = manifestRefs(manifest);
  const missingRefs = refs.filter((r) => !inPkg.has(r));
  missingRefs.forEach((r) => errors.push(`manifest 引用文件缺失：${r}`));

  // 2) 源码里 img/xxx.png 等资源引用是否都在包内
  const scanned = [];
  const assets = new Map(); // 文件 -> 引用它的源文件集合
  for (const rel of files) {
    if (!/\.(js|html|css|json)$/i.test(rel)) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { continue; }
    scanned.push(rel);
    let m = ASSET_RE.exec(text);
    while (m) {
      const asset = m[2];
      if (!assets.has(asset)) assets.set(asset, new Set());
      assets.get(asset).add(rel);
      m = ASSET_RE.exec(text);
    }
  }
  const missingAssets = [];
  assets.forEach((_srcs, asset) => { if (!inPkg.has(asset)) missingAssets.push(asset); });
  missingAssets.forEach((a) => {
    const srcs = Array.from(assets.get(a) || []).join(', ');
    errors.push(`源码引用的资源文件缺失：${a}（被引用于：${srcs}）`);
  });

  const stats = {
    fileCount: files.length,
    manifestRefs: refs.length,
    missingRefs: missingRefs.length,
    scannedSourceFiles: scanned.length,
    assetRefs: assets.size,
    missingAssets: missingAssets.length
  };
  return { errors, stats };
}

// ---------- 主流程 ----------
function main() {
  const checkOnly = process.argv.includes('--check-only');

  const manifestPath = path.join(ROOT, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error('[错误] 未找到 manifest.json：' + manifestPath);
    process.exit(1);
  }
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    console.error('[错误] manifest.json 解析失败：' + String(e && e.message || e));
    process.exit(1);
  }

  const version = String(manifest.version || '0.0.0');
  // manifest 的 name 可能是 __MSG_ext_name__（i18n 占位），此时回退到目录名
  let base = String(manifest.name || path.basename(ROOT));
  if (/^__MSG_/i.test(base)) base = path.basename(ROOT);
  base = base.replace(/[\\/:*?"<>|\s]+/g, '-');

  const files = collectFiles();
  if (!files.length) {
    console.error('[错误] 待打包文件为空，请检查打包范围配置');
    process.exit(1);
  }

  const zipName = `${base}-v${version}.zip`;
  const zipPath = path.join(OUT_DIR, zipName);

  if (!checkOnly) {
    try {
      writeZip(files, zipPath);
    } catch (e) {
      console.error('[错误] 写 zip 失败：' + String(e && e.message || e));
      process.exit(1);
    }
    const sizeKb = (fs.statSync(zipPath).size / 1024).toFixed(1);
    console.log(`[打包] ${zipPath}`);
    console.log(`[打包] 文件数 ${files.length}，大小 ${sizeKb} KB`);
  } else {
    console.log(`[校验] 仅校验模式，文件数 ${files.length}`);
  }

  const { errors, stats } = verifyPackage(files, manifest);
  console.log(`[校验] manifest 引用文件 ${stats.manifestRefs} 个，缺失 ${stats.missingRefs} 个`);
  console.log(`[校验] 扫描源码 ${stats.scannedSourceFiles} 个 → 资源引用 ${stats.assetRefs} 个，缺失 ${stats.missingAssets} 个`);

  if (errors.length) {
    console.error('[校验失败] 共 ' + errors.length + ' 项：');
    errors.forEach((e) => console.error('  - ' + e));
    if (!checkOnly && fs.existsSync(zipPath)) {
      // 校验不通过就不留下可疑产物，避免误发布
      try { fs.unlinkSync(zipPath); } catch (e) { /* ignore */ }
      console.error('[校验失败] 已删除产物：' + zipPath);
    }
    process.exit(2);
  }

  console.log('[校验通过] 包内文件与引用完整' + (checkOnly ? '（未生成 zip）' : '：' + zipPath));
  process.exit(0);
}

try {
  main();
} catch (e) {
  console.error('[异常] ' + String(e && e.stack || e));
  process.exit(1);
}
