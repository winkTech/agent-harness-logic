#!/usr/bin/env node
'use strict';
/**
 * pg-synth.cjs — 由 manifest 驱动 Vivado 综合, 产出 G-C-01/02/03 的证据。
 *
 * 用法:
 *   node tools/pg-synth.cjs <asset-package-dir> [--top <module>] [--part <part>]
 *
 * 证据落地: engineering-assets/var/gates/pg/<asset_uid>/
 * 之后跑 tools/gate-runner.cjs <asset-package-dir> 即可得到机器判据。
 *
 * 设计约束:
 *  - 源文件清单只取自 manifest.sources (role=rtl/constraint), 不扫目录,
 *    保证"被综合的东西"与"被登记的东西"是同一份, 不给未登记源留后门。
 *  - top 默认取 manifest.top, 缺失则回退到 asset name; 可用 --top 覆盖。
 *  - part 默认取 manifest.device.part; 缺失时不猜, 报错退出 —— 器件是
 *    时序/资源结论的前提, 静默用默认器件会让 G-C-01/02 的数字失去意义。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function die(msg) { console.error(`[pg-synth] ${msg}`); process.exit(2); }

const args = process.argv.slice(2);
const pkgDir = args[0];
if (!pkgDir) die('用法: node tools/pg-synth.cjs <asset-package-dir> [--top M] [--part P]');
const argOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const manifestPath = path.join(pkgDir, 'manifest.json');
if (!fs.existsSync(manifestPath)) die(`缺 ${manifestPath}`);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const top = argOf('--top') || manifest.top || manifest.name;
const part = argOf('--part') || (manifest.device || {}).part;
if (!part) die('manifest.device.part 未声明且未给 --part —— 器件决定时序/资源结论, 不做默认猜测');

const sources = manifest.sources || [];
const rtl = sources.filter((s) => s.role === 'rtl').map((s) => path.resolve(pkgDir, s.path));
const xdc = sources.filter((s) => s.role === 'constraint').map((s) => path.resolve(pkgDir, s.path));
if (!rtl.length) die('manifest.sources 中无 role=rtl 的源文件');
const missing = [...rtl, ...xdc].filter((p) => !fs.existsSync(p));
if (missing.length) die(`登记的源不存在: ${missing.join(', ')}`);

// 头文件包含目录: 取 .vh/.svh 所在目录
const incDirs = [...new Set(sources.filter((s) => /\.(vh|svh)$/i.test(s.path))
  .map((s) => path.dirname(path.resolve(pkgDir, s.path))))];
const incdir = incDirs.length ? incDirs[0] : '-';

const repoRoot = path.resolve(__dirname, '..');
const outDir = path.join(repoRoot, 'var', 'gates', 'pg', manifest.asset_uid || manifest.name);
fs.mkdirSync(outDir, { recursive: true });

// CBB 默认按 out-of-context 综合(核级, 不插 I/O 缓冲) —— 见 pg-synth.tcl 说明。
// --mode top 可切到整片视角(端口插 IBUF/OBUF), 用于确实要出芯片引脚的顶层。
const synthMode = argOf('--mode') === 'top' ? 'top' : 'ooc';

const tcl = path.join(__dirname, 'pg-synth.tcl');
const vivadoArgs = [
  '-mode', 'batch', '-nojournal',
  '-log', path.join(outDir, 'synth.log'),
  '-source', tcl,
  '-tclargs', part, top, outDir, incdir, synthMode, ...rtl, ...xdc,
];

console.log(`[pg-synth] ${manifest.asset_uid}: top=${top} part=${part} mode=${synthMode}`);
console.log(`[pg-synth] rtl=${rtl.length} 个, 约束=${xdc.length} 个 -> ${outDir}`);

// Windows 上 vivado 是 .bat, Node 只能经 shell 启动。shell 模式下参数是拼接
// 而非转义, 故自行加引号并整条命令传入(数组+shell 会触发 DEP0190 且不转义),
// 避免路径中的空格/特殊字符被拆解或注入。
const useShell = process.platform === 'win32';
const quote = (a) => `"${String(a).replace(/"/g, '\\"')}"`;

// Vivado 会在 CWD 留下 .Xil/ 等临时物, 放到 outDir 内避免污染仓库
const r = useShell
  ? spawnSync(['vivado', ...vivadoArgs.map(quote)].join(' '), { cwd: outDir, stdio: 'inherit', shell: true })
  : spawnSync('vivado', vivadoArgs, { cwd: outDir, stdio: 'inherit' });
if (r.error) die(`无法调用 vivado: ${r.error.message} (确认已在 PATH 中)`);
if (r.status !== 0) { console.error(`[pg-synth] 综合失败, 退出码 ${r.status}; 见 ${path.join(outDir, 'synth.log')}`); process.exit(r.status || 1); }

console.log(`[pg-synth] 完成。下一步: node tools/gate-runner.cjs ${pkgDir} --repo-root <repo>`);
