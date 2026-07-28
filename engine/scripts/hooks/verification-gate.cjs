#!/usr/bin/env node
/**
 * engine/scripts/hooks/verification-gate.cjs — 验证闭环硬门禁 (P0)
 *
 * ⚠️ 验证必须是功能验证，不只是语法检查 ⚠️
 *
 * 强制规则: 编辑文件后必须先运行**功能验证**命令，否则阻断后续 Bash 操作。
 * 所谓"功能验证"是指：用真实场景确认修改生效，而不是跑 lint/type-check 清门禁。
 *
 * 示例（正确）:
 *   - 改 Hook 脚本 → 用真实 stdin 格式调用 + 检查副作用
 *   - 改 RTL 模块   → vsim 仿真 + 波形检查
 *   - 改 Python 逻辑 → pytest 真实测试用例
 *
 * 示例（错误 — 仅清门禁，不算验证）:
 *   - 改 Hook 脚本 → 只跑 node --check
 *   - 改 RTL 模块   → 只跑 vlog -lint
 *   - 改 Python 逻辑 → 只跑 ruff check
 *
 * 门禁自身无法判断命令质量，它只检查命令名。真正的验证质量依赖开发者自律。
 * 见 memory: verification-must-be-functional
 *
 * 机制:
 *   PostToolUse(Edit|Write|MultiEdit) — 标记「有待验证的修改」
 *   PreToolUse(Bash) — 检查标记:
 *     - 无标记 → 放行
 *     - 命令匹配 VERIFY_PATTERNS → 放行 + 清除标记
 *     - 命令匹配 SAFE_PATTERNS → 放行（保留标记）
 *     - 其他 → exit 2 拦截 + 提示先验证
 *
 * 状态文件: ~/.claude/var/verify-gate.json
 *
 * 退出码:
 *   0 — 放行
 *   2 — 硬拦截 (exit 2 = Hook 系统硬拦截)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { evaluateGuardBypass } = require('../lib/gate-bypass.cjs');

const GATE_ID = 'verification-gate.cjs';
const {
  markEditedFromPayload,
  markVerifiedForCwd,
  pendingForPayload,
  readVerificationState,
  resetVerificationState,
  sessionIdFromPayload,
  writeVerificationState,
} = require('../lib/verification-state.cjs');
const { payloadCwd, payloadFilePath } = require('../lib/project-scope.cjs');
const { HARNESS_ROOT } = require('../lib/harness-root.cjs');
const {
  commandEvidence,
  ensureEvidenceDir,
  writeEvidenceLedger,
} = require('../lib/evidence-ledger.cjs');

const STATE_DIR = path.join(HARNESS_ROOT, 'var');
const STATE_FILE = path.join(STATE_DIR, 'verify-gate.json');
const LEDGER_FILE = process.env.CLAUDE_VERIFICATION_LEDGER_FILE ||
  path.join(STATE_DIR, 'verification-ledger.json');

// ── 模式定义 ────────────────────────────────────────────────────────────────

/**
 * ⚠️ 两层验证模式 ⚠️
 *
 * 第一层 — 语法检查 (LINT_PATTERNS): 仅检查语法/风格，不清除待验证标记。
 *   匹配时输出 "仅语法检查通过，仍需功能验证"，保留 edited=true 状态。
 *   目的: 防止"跑个 lint 就算验证了"的虚假通过。
 *
 * 第二层 — 功能验证 (TEST_PATTERNS): 用真实场景确认修改生效。
 *   匹配时输出 "✅ 功能验证通过" + 清除待验证标记。
 *   例: 改 Hook 脚本 → 用真实 stdin 格式调用 + 检查 SQLite
 *       改 RTL 模块   → vsim 仿真 + 波形/数据对比
 *       改 Python 逻辑 → pytest 加真实测试用例
 *
 * 自定义验证 (CUSTOM_PATTERNS): 项目特有功能验证，行为同第二层。
 */

/** 第二层: 功能验证命令 — 清除「待验证」标记 ✅ */
const TEST_PATTERNS = [
  // Python 测试
  /^pytest\b/,
  /^python\s+-m\s+pytest\b/,
  /^python\s+-m\s+unittest\b/,
  // HDL 仿真 — 运行仿真 = 功能验证
  /^vsim\b/,
  /^xsim\b/,
  // Icarus Verilog: iverilog 编译 + vvp 执行都算仿真闭环
  /^iverilog\b/,
  /^vvp\b/,
  /^verilator(?:_bin)?\b/,
  // Xilinx Vivado 批处理与 xsim 前端
  /^vivado\b/,
  /^xvlog\b/,
  /^xelab\b/,
  // MATLAB / Octave 批处理 —— 本仓库的 golden model 与向量生成都在这里,
  // 跑 golden 复算属功能验证 (与 vsim 同级), 不是语法检查。
  /^matlab\s+(?:-batch|-r)\b/,
  /^octave(?:-cli)?\b/,
  // 项目约定的模块校验脚本 02_sim/<mod>/check_<mod>.py
  // (命名约定见 engine/scripts/lib/project-directory-contract.cjs)
  /^(?:uv\s+run\s+)?python3?\s+["']?(?:[^\s"']*[\/\\])?check_[A-Za-z0-9_]+\.py\b/,
  /^make\s+(regress|sim|test|check|run)\b/,
  // Node/JS 测试
  /^npm\s+test\b/,
  /^npm\s+run\s+test\b/,
  /^node\s+.*engine[\/\\]scripts[\/\\]test-hooks[\/\\].+\.(?:cjs|js)\b/,
  // engineering-assets 的准入门 runner —— 它自己就会跑 vlog 并判读仿真/综合
  // 证据, 是本仓库 CBB 的验收判定, 属功能验证而非语法检查。
  /^node\s+.*\btools[\/\\]gate-runner\.cjs\b/,
  // 同一套证据链的综合侧: pg-synth 会真的跑 Vivado 出时序/资源报告
  /^node\s+.*\btools[\/\\]pg-synth\.cjs\b/,
  /^jest\b/,
  /^vitest\b/,
  /^uv\s+run\s+pytest\b/,
  /^uvx\s+pytest\b/,
  // Go
  /^go\s+test\b/,
  // Java/Scala
  /^sbt\s+test\b/,
  /^mvn\s+test\b/,
  /^gradle\s+test\b/,
  // Rust
  /^cargo\s+test\b/,
  /** 项目自定义功能验证 — 编辑此数组添加 */
];

/** 第一层: 仅语法/风格检查 — 不清除待验证标记，提示仍需功能验证 ⚠️ */
const LINT_PATTERNS = [
  // Python
  /^ruff\s+check\b/,
  /^ruff\s+format\s+--check\b/,
  /^flake8\b/,
  /^black\s+--check\b/,
  /^mypy\b/,
  // Node/JS
  /^tsc\s+--noEmit\b/,
  /^eslint\b/,
  /^biome\s+check\b/,
  /^biome\s+ci\b/,
  /^npm\s+run\s+check\b/,
  /^npm\s+run\s+lint\b/,
  // Go
  /^go\s+vet\b/,
  // Rust
  /^cargo\s+check\b/,
  // HDL — vlog 单独调用是语法检查，不算功能验证
  /^vlog\b/,
  // Node 脚本检查
  /^node\s+--check\b/,
  /** 项目自定义语法检查 — 编辑此数组添加 */
];

/** git 的全局选项 (可重复), 出现在 git 与子命令之间: `git -C <path> -c k=v status` */
const GIT_GLOBAL_OPTS = '(?:(?:-C\\s+(?:"[^"]*"|\'[^\']*\'|\\S+)|-c\\s+\\S+|--no-pager|--git-dir(?:=|\\s+)\\S+|--work-tree(?:=|\\s+)\\S+)\\s+)*';

/** git 只读子命令 — 允许在待验证状态下运行 */
const GIT_READONLY_SUBCOMMANDS = ['status', 'diff', 'log', 'blame', 'show', 'branch', 'remote', 'config'];

/** 安全只读命令 — 放行但保留「待验证」标记 */
const SAFE_PATTERNS = [
  /^ls\b/,
  /^cd\b/,
  /^which\b/,
  /^type\b/,
  /^pwd\b/,
  /^dir\b/,
  /^date\b/,
  /^whoami\b/,
  /^id\b/,
  /^printenv\b/,
  /^env\b/,
  // 只允许不含输出重定向的 echo；commandSegments 已先按 | & ; 切段。
  // `echo ... > file` / `echo ... >> file` 仍由本门禁硬拦。
  /^echo\b[^>]*$/,
  /^cat\b/,
  /^head\b/,
  /^tail\b/,
  /^less\b/,
  /^more\b/,
  // git 全局选项 (-C <path> / -c k=v) 会夹在 git 与子命令之间, 例如
  // `git -C "D:\repo" status --short`。早期模式把子命令直接锚在 git 后面,
  // 于是这类极常见的调用被判为不安全而硬拦 —— 又是一条把人逼向 --reset 的路径。
  ...GIT_READONLY_SUBCOMMANDS.map((sub) => new RegExp(`^git\\s+${GIT_GLOBAL_OPTS}${sub}\\b`)),
  /^(?:python|node|go|rustc|javac)\s+--version\b/,
  /^(?:python|node|go|rustc)\s+-V\b/,
  // PowerShell 只读 cmdlet —— 本门禁现在也覆盖 PowerShell 工具 (见 isShellTool),
  // 而上面那批安全模式全是 POSIX 命令名。缺了这一段, Windows 上任何一条
  // `Get-ChildItem ... | Select-Object ...` 都会被 matchesAll 判为不安全而硬拦,
  // 反过来逼人 --reset, 等于又把门禁废掉。刻意不含 Remove-Item / Set-Content /
  // Out-File / New-Item 一类写操作, 它们仍应受门禁管辖。
  /^Get-(?:ChildItem|Content|Command|Item|ItemProperty|Location|Date|Process|Member|Help|History|Unique)\b/i,
  /^(?:Select|Where|ForEach|Measure|Sort|Group|Compare)-Object\b/i,
  /^Select-String\b/i,
  /^Format-(?:Table|List|Wide)\b/i,
  /^Out-(?:String|Host|Null)\b/i,
  /^ConvertFrom-Json\b/i,
  /^ConvertTo-Json\b/i,
  /^Test-Path\b/i,
  /^(?:Resolve|Split|Join)-Path\b/i,
  /^Write-(?:Output|Host|Verbose|Debug)\b/i,
  /^Set-Location\b/i,
  /^Get-ChildItem\b/i,
  // 变量赋值 / 管道续行 / 表达式求值等 PowerShell 语法片段
  /^\$[A-Za-z_]\w*\s*=/,
  /^if\s*\(/i,
  /^foreach\s*\(/i,
  /^\}/,
  /^\{/,
  // 无害的文件/目录操作 — 建仿真产物目录、拷贝激励向量等，与"是否验证过"无关
  // 刻意不含 rm / rmdir -r：删除仍应受门禁与 bash-safety-guard 管辖
  /^mkdir\b/,
  /^cp\b/,
  /^mv\b/,
  /^touch\b/,
  // 只读检索/统计
  /^(?:rg|grep|egrep|fgrep)\b/,
  /^find\b/,
  /^(?:wc|sort|uniq|diff|tree|du|stat|file|basename|dirname|realpath)\b/,
  /^sed\s+-n\b/,
  /^awk\b/,
  // echo 仅由上面的无 `>` 模式放行；带重定向的写文件向量保持被拦。
  // git 暂存与只读查询 — 刻意不含 commit/push/reset，那些仍须先通过验证
  ...['add', 'rev-parse', 'ls-files', 'check-ignore', 'stash\\s+list']
    .map((sub) => new RegExp(`^git\\s+${GIT_GLOBAL_OPTS}${sub}\\b`)),
  // 本门禁自身的自救命令 — 误拦时必须还能解除，否则形成死锁
  /verification-gate\.cjs["']?\s+--(?:reset|status)\b/,
  /^\s*#/,
  /^\s*$/,
];

// ── 状态管理 ─────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readState() {
  return readVerificationState();
}

function writeState(state) {
  ensureDir(STATE_DIR);
  writeVerificationState(state);
}

function markEdited(payload, toolName) {
  markEditedFromPayload(payload, { toolName });
}

function markVerified(payload, command) {
  markVerifiedForCwd(payloadCwd(payload), {
    command,
    sessionId: sessionIdFromPayload(payload),
  });
}

function normalizeStatus(status) {
  if (typeof status === 'number') return status;
  if (typeof status === 'string' && status.trim() !== '') {
    const parsed = Number(status);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function bashResultFromPayload(payload) {
  // 真实 Claude Code PostToolUse 载荷的 tool_response 没有 status/exit_code
  // (Bash 形如 {stdout, stderr, interrupted}), 也可能是纯字符串或 content
  // block 数组。旧实现只认对象 + status 字段, 于是真实会话里每次通过的
  // 验证都被判 'missing exit status', pending 永不清除 (2026-07-27 实测:
  // 与 progress-watchdog 冻结互锁成全工具死锁)。
  const raw = payload?.tool_response ?? payload?.tool_result ?? payload?.response ?? {};
  let result = raw;
  if (typeof raw === 'string') result = { stdout: raw };
  else if (Array.isArray(raw)) {
    result = { stdout: raw.map((b) => (typeof b === 'string' ? b : String(b?.text || ''))).join('\n') };
  } else if (!raw || typeof raw !== 'object') result = {};
  const stdout = typeof result.stdout === 'string' ? result.stdout
    : (typeof result.output === 'string' ? result.output : '');
  return {
    status: normalizeStatus(result.status ?? result.exit_code ?? result.exitCode),
    signal: result.signal || null,
    error: result.error || '',
    stdout,
    stderr: result.stderr || '',
    interrupted: result.interrupted === true,
  };
}

/**
 * 通过证据 (正面标记)。
 *
 * 判定必须是**正面**的: 退出码 0 且没扫到失败标记 ≠ 验证通过。
 * 反例都是真实发生过的:
 *   - Icarus 的 `$finish(n)` 里 n 是诊断详细程度 (0/1/2), **不是退出码**,
 *     所以把 $finish(1) 当"失败退出"用的 TB 永远 exit 0;
 *   - TB 在 0 时刻就挂掉 / 向量没加载 / 跑的是过期 binary, 都是静默 exit 0;
 *   - 编译成功但根本没执行仿真, 同样 exit 0 无输出。
 * 以上在旧的"无失败标记即通过"判据下全部记为验证通过 —— 假绿由此产生。
 */
const PASS_MARKERS = [
  /\bRESULT:\s*PASS\b/i,
  /\b(?:ALL\s+)?(?:TESTS?|CHECKS?)\s+PASSED\b/i,
  /\bPASSED\b/,
  /\bPASS\b/,
  /\b\d+\s+passed\b/i,
  /\b0\s+(?:failed|failures|errors|mismatches)\b/i,
  /\bno\s+(?:errors|mismatches|failures)\b/i,
  /\bbit-true\b/i,
  /\bsuccess(?:ful(?:ly)?)?\b/i,
  /\bcompleted\s+successfully\b/i,
  /\b(?:ok|OK)\b/,
  /** 项目自定义通过标记 — 编辑此数组添加 */
];

function verificationVerdict(command, result) {
  const stdout = String(result?.stdout || '');
  const stderr = String(result?.stderr || '');
  const error = String(result?.error || '');
  const combined = `${stdout}\n${stderr}\n${error}`;
  const status = normalizeStatus(result?.status);

  // 真实载荷没有退出码 (status=null) —— 不能因此判失败: PostToolUse 事件
  // 本身说明命令跑完了 (硬失败走 PostToolUseFailure), 成败交给下面的
  // 正面 PASS / 失败标记判据。只有明确的非零退出码才在这里判失败。
  if (status !== null && status !== 0) {
    return { ok: false, reason: `exit=${status}` };
  }
  if (result?.interrupted) return { ok: false, reason: 'command interrupted' };
  if (result?.signal) return { ok: false, reason: `signal=${result.signal}` };
  if (error.trim()) return { ok: false, reason: 'tool error present' };
  if (/\bRESULT:\s*FAIL\b/i.test(combined)) return { ok: false, reason: 'RESULT: FAIL in output' };
  const failedCount = combined.match(/\b(\d+)\s+failed\b/i);
  if (failedCount && Number(failedCount[1]) > 0) return { ok: false, reason: 'failed test count in output' };
  if (/\b(?:FAILURE|FATAL|ASSERTION\s+FAILED)\b/i.test(combined) ||
      (/\bFAILED\b/i.test(combined) && !/\b0\s+failed\b/i.test(combined))) {
    return { ok: false, reason: 'failure marker in output' };
  }

  // 能走到这里的命令必定命中 TEST_PATTERNS (调用方保证), 也就是说它是一条
  // "功能验证"命令。这类命令静默成功没有意义 —— 早期版本只对手抄的一小份
  // 名单要求日志, 而那份名单漏掉了 `vvp` (Icarus 真正执行仿真的命令),
  // 于是 `vvp tb.vvp` 空输出直接算通过。改为对全部验证命令一律要求日志,
  // 从根上消除"两份名单漂移"这一类缺陷。
  if (!combined.trim()) {
    return { ok: false, reason: 'verification command produced no log evidence' };
  }

  if (!PASS_MARKERS.some((re) => re.test(combined))) {
    return { ok: false, reason: 'no explicit PASS evidence in output' };
  }

  return { ok: true, reason: 'exit code 0 with explicit PASS evidence' };
}

function recordVerificationEvidence(payload, command, result, verdict) {
  const entry = commandEvidence(command, result);
  entry.verification = {
    accepted: verdict.ok,
    reason: verdict.reason,
    gate: 'verification-gate',
  };
  if (!verdict.ok) {
    entry.status = 'failed';
    entry.classification = {
      ...entry.classification,
      status: entry.classification?.status === 'toolchain_failure' ? 'toolchain_failure' : 'command_failed',
      reason: verdict.reason,
    };
  }
  entry.cwd = payloadCwd(payload);
  ensureEvidenceDir(LEDGER_FILE);
  writeEvidenceLedger(LEDGER_FILE, entry);
}

// ── stdin 读取 ───────────────────────────────────────────────────────────────

function readStdin() {
  return new Promise(resolve => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { raw += chunk; });
    process.stdin.on('end', () => resolve(raw));
  });
}

// ── 模式匹配 ─────────────────────────────────────────────────────────────────

/**
 * 命令分段。
 *
 * 上面所有模式都以 `^` 锚定，而 matchesAny 此前直接测原始整串。真实调用几乎
 * 总是带前缀的 —— 多根仓库里跑仿真就是 `cd <pkg> && vsim -c -do run.do`。
 * 于是 `/^vsim\b/` 永远匹配不上：实测一个跑满了 vsim 与 vivado 的会话，
 * verify-gate.json 的 lastVerifyTime 仍是 null，本门禁从未记录过任何一次验证，
 * 只会不断累积 pending 然后拦住后续命令，逼人用 --reset 绕开 —— 那等于废掉门禁。
 *
 * (SAFE_PATTERNS 里唯一没锚定的 `verification-gate\.cjs\s+--reset` 就是这个
 *  问题的局部补丁: 它必须能在 `node ...` 前缀下工作。这里做通用修复。)
 *
 * 切分后剥掉环境变量赋值与 time/exec 一类包装，让模式作用在真正被执行的命令上。
 */
function commandSegments(cmd) {
  const raw = String(cmd).trim();

  // 按 shell 分隔符切分, 但**跳过引号内的内容**。
  // 朴素的 split(/[;|]/) 会把 `grep "a\|b" f` 这类模式串切碎成假命令段,
  // 既造成误拦 (matchesAll 下每段都要安全), 也可能造成误放
  // (matchesAny 下引号里出现 "vsim" 就被当成跑过验证)。
  const segs = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      cur += c;
      if (c === quote && raw[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '\\' && raw[i + 1] === '\n') { i++; continue; }
    if (c === '<' && raw[i + 1] === '#'
        && (i === 0 || /\s|[;|&(){}]/.test(raw[i - 1]))) {
      if (cur && !/\s$/.test(cur)) cur += ' ';
      i += 2;
      let depth = 1;
      while (i < raw.length && depth > 0) {
        if (raw[i] === '<' && raw[i + 1] === '#') { depth++; i += 2; continue; }
        if (raw[i] === '#' && raw[i + 1] === '>') { depth--; i += 2; continue; }
        i++;
      }
      i--;
      continue;
    }
    if (c === '#' && (i === 0 || /\s|[;|&()]/.test(raw[i - 1]))) {
      while (i + 1 < raw.length && raw[i + 1] !== '\n' && raw[i + 1] !== '\r') i++;
      segs.push(cur);
      cur = '';
      continue;
    }
    if (c === '\n' || c === '\r' || c === ';' || c === '|' || c === '&') {
      // 吃掉成对的 && / ||
      if ((c === '&' || c === '|') && raw[i + 1] === c) i++;
      segs.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  segs.push(cur);

  const out = segs
    .map((s) => s.trim())
    .map((s) => s.replace(/^(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, ''))
    .map((s) => s.replace(/^(?:time|exec|nohup|command|builtin)\s+/, ''))
    .filter(Boolean);
  return out.length ? out : [raw];
}

/**
 * Return the first controlled Git action in a shell command chain.
 *
 * Git global options live between `git` and the subcommand, so matching only
 * `^git push` misses common forms such as `git -C repo push`.  Reusing the
 * quote-aware command splitter also keeps `echo "git push"` from being
 * classified as a real Git operation.
 */
function shellWords(segment) {
  const words = [];
  let current = '';
  let quote = null;
  let started = false;
  for (let index = 0; index < String(segment).length; index++) {
    const char = String(segment)[index];
    if (quote) {
      if (char === '\\' && quote === '"' && index + 1 < String(segment).length) {
        const escaped = String(segment)[index + 1];
        if (['"', '\\', '$', '`'].includes(escaped)) {
          current += escaped;
          index++;
        } else {
          current += char;
        }
        started = true;
      } else if (char === quote) {
        quote = null;
      } else {
        current += char;
        started = true;
      }
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (/\s/.test(char)) {
      if (started) { words.push(current); current = ''; started = false; }
      continue;
    }
    if (char === '\\' && index + 1 < String(segment).length) {
      const escaped = String(segment)[index + 1];
      if (/\s/.test(escaped) || ['"', "'", '\\'].includes(escaped)) {
        current += escaped;
        index++;
      } else {
        current += char;
      }
      started = true;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) words.push(current);
  return words;
}

function commandSubstitutions(command) {
  const source = String(command || '');
  const substitutions = [];
  let quote = null;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '\\') { index++; continue; }
    if (char === "'") {
      if (quote === 'single') quote = null;
      else if (!quote) quote = 'single';
      continue;
    }
    if (char === '"') {
      if (quote === 'double') quote = null;
      else if (!quote) quote = 'double';
      continue;
    }
    if (quote === 'single') continue;
    if (!quote && char === '<' && source[index + 1] === '#'
        && (index === 0 || /\s|[;|&(){}]/.test(source[index - 1]))) {
      index += 2;
      let depth = 1;
      while (index < source.length && depth > 0) {
        if (source[index] === '<' && source[index + 1] === '#') { depth++; index += 2; continue; }
        if (source[index] === '#' && source[index + 1] === '>') { depth--; index += 2; continue; }
        index++;
      }
      index--;
      continue;
    }
    if (!quote && char === '#' && (index === 0 || /\s|[;|&()]/.test(source[index - 1]))) {
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index++;
      continue;
    }
    if (char === '`') {
      const end = source.indexOf('`', index + 1);
      if (end !== -1) {
        substitutions.push(source.slice(index + 1, end));
        index = end;
      }
      continue;
    }
    const startsSubstitution = source[index + 1] === '('
      && (char === '$' || (!quote && (char === '<' || char === '>')));
    if (!startsSubstitution) continue;
    const start = index + 2;
    let depth = 1;
    let innerQuote = null;
    let innerComment = false;
    let end = start;
    for (; end < source.length; end++) {
      const inner = source[end];
      if (innerComment) {
        if (inner === '\n' || inner === '\r') innerComment = false;
        continue;
      }
      if (inner === '\\') { end++; continue; }
      if (inner === "'" && innerQuote !== 'double') {
        innerQuote = innerQuote === 'single' ? null : 'single';
        continue;
      }
      if (inner === '"' && innerQuote !== 'single') {
        innerQuote = innerQuote === 'double' ? null : 'double';
        continue;
      }
      if (innerQuote) continue;
      if (inner === '<' && source[end + 1] === '#'
          && (end === start || /\s|[;|&(){}]/.test(source[end - 1]))) {
        end += 2;
        let commentDepth = 1;
        while (end < source.length && commentDepth > 0) {
          if (source[end] === '<' && source[end + 1] === '#') { commentDepth++; end += 2; continue; }
          if (source[end] === '#' && source[end + 1] === '>') { commentDepth--; end += 2; continue; }
          end++;
        }
        end--;
        continue;
      }
      if (inner === '#' && (end === start || /\s|[;|&()]/.test(source[end - 1]))) {
        innerComment = true;
        continue;
      }
      if (inner === '(') depth++;
      else if (inner === ')' && --depth === 0) break;
    }
    if (depth === 0) {
      substitutions.push(source.slice(start, end));
      index = end;
    }
  }
  return substitutions;
}

function directGitSubcommand(segment, allowed, depth = 0) {
  const words = shellWords(segment);
  let index = 0;
  const controlPrefixes = new Set(['if', 'then', 'elif', 'else', 'while', 'until', 'do', '!']);
  const wrappers = new Set(['time', 'exec', 'nohup', 'command', 'builtin']);
  while (index < words.length) {
    const rawWord = String(words[index] || '');
    const ungrouped = rawWord.replace(/^[({]+/, '');
    if (ungrouped !== rawWord) {
      if (ungrouped) words[index] = ungrouped;
      else index++;
      continue;
    }
    const word = rawWord.toLowerCase();
    if (word === 'case') {
      const inIndex = words.findIndex((candidate, candidateIndex) => (
        candidateIndex > index && String(candidate).toLowerCase() === 'in'
      ));
      if (inIndex === -1) return '';
      index = inIndex + 1;
      while (index < words.length && !/\)$/.test(words[index])) index++;
      if (index < words.length) index++;
      continue;
    }
    if (/^[A-Za-z_]\w*=/.test(rawWord) || controlPrefixes.has(word) || wrappers.has(word)) {
      index++;
      continue;
    }
    if (word === 'env') {
      index++;
      const envOptionsWithValue = new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']);
      while (index < words.length) {
        const option = words[index];
        if (option === '-S' || option === '--split-string') {
          if (index + 1 >= words.length) return '';
          return gitSubcommand(words.slice(index + 1).join(' '), [...allowed], depth + 1);
        }
        if (/^--split-string=/.test(option)) {
          const inline = option.slice(option.indexOf('=') + 1);
          return gitSubcommand([inline, ...words.slice(index + 1)].join(' '), [...allowed], depth + 1);
        }
        if (envOptionsWithValue.has(option)) { index += 2; continue; }
        if (/^--(?:unset|chdir|split-string)=/.test(option)
            || option.startsWith('-')
            || /^[A-Za-z_]\w*=/.test(option)) {
          index++;
          continue;
        }
        break;
      }
      continue;
    }
    break;
  }
  const executable = String(words[index] || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
  if (executable === 'cmd' || executable === 'cmd.exe') {
    const commandIndex = words.findIndex((word, wordIndex) => (
      wordIndex > index && /^\/(?:c|k)$/i.test(word)
    ));
    if (commandIndex !== -1 && commandIndex + 1 < words.length) {
      return gitSubcommand(words.slice(commandIndex + 1).join(' '), [...allowed], depth + 1);
    }
    return '';
  }
  if (['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(executable)) {
    const flags = new Set(['-nologo', '-noprofile', '-noninteractive', '-mta', '-sta']);
    const optionsWithValue = new Set([
      '-configurationname', '-custompipename', '-executionpolicy', '-inputformat',
      '-outputformat', '-settingsfile', '-windowstyle', '-workingdirectory',
      '-encodedcommand', '-e', '-ec', '-file', '-f',
    ]);
    let cursor = index + 1;
    while (cursor < words.length) {
      const option = words[cursor].toLowerCase();
      if (option === '-command' || option === '-c') {
        return cursor + 1 < words.length
          ? gitSubcommand(words.slice(cursor + 1).join(' '), [...allowed], depth + 1)
          : '';
      }
      if (flags.has(option)) { cursor++; continue; }
      if (optionsWithValue.has(option)) { cursor += 2; continue; }
      if (option.startsWith('-')) return '';
      return gitSubcommand(words.slice(cursor).join(' '), [...allowed], depth + 1);
    }
    return '';
  }
  if (['bash', 'sh', 'zsh'].includes(executable)) {
    const commandIndex = words.findIndex((word, wordIndex) => (
      wordIndex > index && (/^(?:-c|--command)$/i.test(word) || /^-[a-z]*c[a-z]*$/i.test(word))
    ));
    if (commandIndex !== -1 && commandIndex + 1 < words.length) {
      return gitSubcommand(words.slice(commandIndex + 1).join(' '), [...allowed], depth + 1);
    }
    return '';
  }
  if (executable !== 'git' && executable !== 'git.exe') return '';
  index++;

  const optionsWithValue = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env']);
  const flagOptions = new Set([
    '--bare', '--literal-pathspecs', '--no-literal-pathspecs', '--glob-pathspecs',
    '--noglob-pathspecs', '--icase-pathspecs', '--no-pager', '--paginate',
    '--no-replace-objects', '--no-optional-locks',
  ]);
  while (index < words.length) {
    const word = words[index];
    if (word === '--') { index++; break; }
    if (optionsWithValue.has(word)) { index += 2; continue; }
    if (/^-C.+/.test(word) || /^-c.+/.test(word)
        || /^--(?:git-dir|work-tree|namespace|config-env)=/.test(word)
        || flagOptions.has(word)) {
      index++;
      continue;
    }
    if (word.startsWith('-')) return '';
    break;
  }
  const action = String(words[index] || '').replace(/[)}]+$/, '').toLowerCase();
  return allowed.has(action) ? action : '';
}

function gitSubcommand(cmd, actions = ['commit', 'push'], depth = 0) {
  const allowed = new Set(actions.map((action) => String(action || '').trim().toLowerCase()).filter(Boolean));
  if (allowed.size === 0 || depth > 8) return '';
  for (const segment of commandSegments(cmd)) {
    const action = directGitSubcommand(segment, allowed, depth);
    if (action) return action;
  }
  for (const nested of commandSubstitutions(cmd)) {
    const action = gitSubcommand(nested, [...allowed], depth + 1);
    if (action) return action;
  }
  return '';
}

/** 任一段命中 → 命中。用于 TEST/LINT/CUSTOM: 链中出现过验证命令就算跑过验证。 */
function matchesAny(cmd, patterns) {
  for (const seg of commandSegments(cmd)) {
    for (const re of patterns) {
      if (re.test(seg)) return true;
    }
  }
  return false;
}

/**
 * 每一段都命中 → 命中。SAFE_PATTERNS 必须用这个，不能用 matchesAny：
 * `^cd\b` 在安全表里，若按"任一段命中"判定，`cd x && <任意命令>` 会被整条放行。
 * 注意这比改动前更严 —— 改动前测原始整串，`/^cd\b/` 同样会让该串通过。
 */
function matchesAll(cmd, patterns) {
  const segs = commandSegments(cmd);
  if (!segs.length) return false;
  return segs.every((seg) => patterns.some((re) => re.test(seg)));
}

/**
 * 本门禁自身的解除命令 —— 只要**任一段**是它就放行。
 *
 * SAFE_PATTERNS 走的是 matchesAll(每段都得安全), 而解除命令常被顺手接上
 * 别的东西 (`... --reset && echo done`)。那种链条会被整条拒绝, 于是误拦
 * 之后连解除都做不到 —— 正是 SAFE_PATTERNS 里那条注释想避免的死锁。
 * 这里单独按"任一段命中"判定, 保住逃生通道。
 */
const RESCUE_PATTERN = /verification-gate\.cjs["']?\s+--(?:reset|status)\b/;

function isRescue(cmd) {
  return commandSegments(cmd).some((seg) => RESCUE_PATTERN.test(seg));
}

function allow(diagnostics = [], extra = {}) {
  return { source: 'verification-gate', decision: 'allow', diagnostics, ...extra };
}

function warn(diagnostics, extra = {}) {
  return { source: 'verification-gate', decision: 'warn', diagnostics, ...extra };
}

function block(diagnostics, extra = {}) {
  return { source: 'verification-gate', decision: 'block', diagnostics, ...extra };
}

function evaluate(payload, _runtime = {}) {
  if (evaluateGuardBypass({ gateId: GATE_ID, payload }).allowed) {
    return allow([], { bypassed: true });
  }

  const eventName = payload?.hook_event_name || '';
  const toolName = String(payload?.tool?.name || payload?.tool_name || payload?.name || '').toLowerCase();
  const isShellTool = toolName === 'bash' || toolName === 'powershell';
  const command = String(
    payload?.tool_input?.command
    || payload?.tool?.input?.command
    || payload?.input?.command
    || payload?.command
    || ''
  ).trim();

  if ((eventName === 'PostToolUse' || !eventName) && ['edit', 'write', 'multiedit'].includes(toolName)) {
    const filePath = payloadFilePath(payload);
    const normalizedPath = filePath.toLowerCase();
    const isCode = /\.(sv|v|vh|py|c|cpp|h|vhd)$/i.test(filePath);
    const isGateFile = /[\\/]var[\\/]gates[\\/]/.test(normalizedPath)
      || normalizedPath.endsWith('verify-gate.json');
    if (isCode && !isGateFile) markEdited(payload, toolName);
    return allow([], { stateUpdated: isCode && !isGateFile });
  }

  if ((eventName === 'PostToolUse' || eventName === 'PostToolUseFailure') && isShellTool && command) {
    const pending = pendingForPayload(readState(), payload);
    if (pending.length === 0 || !matchesAny(command, TEST_PATTERNS)) return allow([], { pending });

    const result = bashResultFromPayload(payload);
    const verdict = eventName === 'PostToolUseFailure'
      ? { ok: false, reason: 'PostToolUseFailure event' }
      : verificationVerdict(command, result);
    recordVerificationEvidence(payload, command, result, verdict);
    if (verdict.ok) {
      markVerified(payload, command);
      return allow([], { pending, verification: verdict, stateUpdated: true });
    }
    const diagnostics = [`[VerificationGate] verification result rejected: ${verdict.reason}`];
    if (verdict.reason === 'no explicit PASS evidence in output') {
      diagnostics.push(
        'Exit code 0 without failure markers is insufficient without explicit PASS evidence.',
        'Emit RESULT: PASS / 0 errors and make failure paths return a non-zero exit code.',
      );
    }
    if (verdict.reason === 'verification command produced no log evidence') {
      diagnostics.push('The verification command produced no output evidence.');
    }
    return warn(diagnostics, { pending, verification: verdict, stateUpdated: false });
  }

  if ((eventName === 'PreToolUse' || !eventName) && isShellTool && command) {
    const pending = pendingForPayload(readState(), payload);
    if (pending.length === 0 || isRescue(command)) return allow([], { pending });

    if (matchesAny(command, TEST_PATTERNS)) {
      if (matchesAll(command, [...TEST_PATTERNS, ...LINT_PATTERNS, ...SAFE_PATTERNS])) {
        return allow([], { pending, reason: 'verification-command' });
      }
      return block([
        '[VerificationGate] mixed verification chain rejected.',
        'Run the verification command separately before the remaining command.',
        `command: ${command.slice(0, 160)}`,
      ], { pending, reason: 'mixed-verification-chain' });
    }

    if (matchesAny(command, LINT_PATTERNS)) {
      return warn([
        '[VerificationGate] LINT PASSED - functional verification is still required.',
      ], { pending, reason: 'lint-only' });
    }
    if (matchesAll(command, SAFE_PATTERNS)) return allow([], { pending, reason: 'safe-command' });

    return block([
      '[VerificationGate] command blocked: functional verification is still pending.',
      'Run functional verification (pytest / vsim / iverilog / check_*.py) first.',
      `command: ${command.slice(0, 160)}`,
    ], { pending, reason: 'verification-required' });
  }

  return allow();
}

// ── 主逻辑 ───────────────────────────────────────────────────────────────────

async function main() {
  // --reset / reset: 清除待验证标记 (两种写法都接受, 与 progress-watchdog 对齐)
  if (process.argv.includes('--reset') || process.argv.includes('reset')) {
    resetVerificationState();
    console.error('[VerificationGate] ✅ 验证状态已重置');
    process.exit(0);
  }

  const raw = await readStdin();
  if (!raw) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // 解析失败不阻断
  }
  if (evaluateGuardBypass({ gateId: GATE_ID, payload }).allowed) process.exit(0);

  // 提取事件名和工具名 (兼容多种 stdin 格式)
  const eventName = payload?.hook_event_name || '';
  const toolName = (payload?.tool?.name || payload?.tool_name || payload?.name || '').toLowerCase();
  // settings.json 一直按 "Bash|PowerShell" 注册本门禁, 但代码只认 Bash ——
  // 于是在 Windows 这类以 PowerShell 为主 shell 的机器上, 换个工具就能整体绕过
  // 验证门禁。这里把 PowerShell 一并纳入, 与注册意图对齐。
  const isShellTool = toolName === 'bash' || toolName === 'powershell'
    || payload?.tool_name === 'Bash' || payload?.tool_name === 'PowerShell';
  const command = (payload?.tool_input?.command || payload?.tool?.input?.command || payload?.input?.command || payload?.command || '').trim();

  // ── PostToolUse: 编辑代码文件 → 标记待验证 ───────────────────────────────
  if ((eventName === 'PostToolUse' || !eventName) && ['edit', 'write', 'multiedit'].includes(toolName)) {
    // 仅代码文件触发验证标记，文档/配置/gate 文件不触发
    const filePath = payloadFilePath(payload);
    const fp = filePath.toLowerCase();
    const isCode = /\.(sv|v|vh|py|c|cpp|h|vhd)$/i.test(filePath);
    const isGateFile = /[\/\\]var[\/\\]gates[\/\\]/.test(fp) || fp.endsWith('verify-gate.json');
    if (isCode && !isGateFile) {
      markEdited(payload, toolName);
    }
    process.exit(0);
  }

  if ((eventName === 'PostToolUse' || eventName === 'PostToolUseFailure') && isShellTool && command) {
    const state = readState();
    const pending = pendingForPayload(state, payload);
    if (pending.length === 0 || !matchesAny(command, TEST_PATTERNS)) process.exit(0);

    const result = bashResultFromPayload(payload);
    // PostToolUseFailure = 工具层已判定执行失败, 无条件按验证失败记录
    const verdict = eventName === 'PostToolUseFailure'
      ? { ok: false, reason: 'PostToolUseFailure event' }
      : verificationVerdict(command, result);
    recordVerificationEvidence(payload, command, result, verdict);
    if (verdict.ok) {
      markVerified(payload, command);
    } else {
      console.error(`[VerificationGate] verification result rejected: ${verdict.reason}`);
      if (verdict.reason === 'no explicit PASS evidence in output') {
        console.error('  退出码 0 且无失败标记, 但输出里没有任何通过证据 —— 这不算验证通过。');
        console.error('  常见成因: TB 用 $finish(n) 表示失败 (n 是诊断级别, 不是退出码, 进程仍 exit 0);');
        console.error('            TB 在 0 时刻挂掉 / 向量未加载 / 跑的是过期 binary。');
        console.error('  修法: 让验证在结束时打印明确结论 (如 "RESULT: PASS" / "0 errors"),');
        console.error('        失败路径改用 $fatal(1, ...) 以真正返回非零退出码。');
      }
      if (verdict.reason === 'verification command produced no log evidence') {
        console.error('  验证命令没有产生任何输出 —— 无法证明它真的执行过。');
        console.error('  请确认命令确实运行了仿真/测试, 而不是只完成了编译。');
      }
    }
    process.exit(0);
  }

  // ── PreToolUse: Bash 命令 → 检查验证状态 ─────────────────────────────────
  if ((eventName === 'PreToolUse' || !eventName) && isShellTool && command) {
    const state = readState();
    const pending = pendingForPayload(state, payload);

    // 没有待验证的修改 → 放行
    if (pending.length === 0) process.exit(0);

    // 本门禁自身的解除/查询命令 → 始终放行 (逃生通道, 不受链式命令影响)
    if (isRescue(command)) process.exit(0);

    // Verification commands are allowed to run here. The pending state is
    // cleared only in PostToolUse after exit code and output evidence exist.
    //
    // 链中含验证命令即放行, 但**每一段**都必须是验证/语法/安全命令。
    // 旧版只用 matchesAny(TEST_PATTERNS) 判定, 于是 `pytest && <任意命令>`
    // 会整条放行 —— 等于给任何命令加个测试前缀就能绕过本门禁。
    // 用交集判据既保住真实用法 (`cd pkg && vsim -c -do run.do`: cd 安全 + vsim 验证),
    // 又堵住搭车。搭车链被拦后仍可拆成两条命令分别执行, 不形成死锁。
    if (matchesAny(command, TEST_PATTERNS)) {
      if (matchesAll(command, [...TEST_PATTERNS, ...LINT_PATTERNS, ...SAFE_PATTERNS])) {
        process.exit(0);
      }
      console.error('');
      console.error('[VerificationGate] 拒绝搭车链: 命令链中含验证命令, 但同时含未授权命令段。');
      console.error('  请把验证命令单独执行, 再执行其余命令 (验证通过后门禁自动放行)。');
      console.error(`  命令: ${command.slice(0, 160)}`);
      console.error('');
      process.exit(2);
    }

    // 命令是第一层: 仅语法检查 → 放行但不清除标记，提示仍需功能验证 ⚠️
    if (matchesAny(command, LINT_PATTERNS)) {
      console.error('');
      console.error('╔══════════════════════════════════════════════════════════════╗');
      console.error('║  ⚠️  LINT PASSED — 仍需功能验证                           ║');
      console.error('╠══════════════════════════════════════════════════════════════╣');
      console.error('║  语法检查通过，但验证门禁仍为「待验证」状态。                ║');
      console.error('║  根据 docs/rules/00-core.md: "验证 = 功能验证，不只是语法检查"     ║');
      console.error('║                                                              ║');
      console.error('║  请继续运行功能验证命令 (如 pytest / vsim / E2E stdin 调用):  ║');
      console.error('║  - Hook 脚本 → echo \'{"hook_event":...}\' | node hook.cjs   ║');
      console.error('║  - Python   → pytest <test_file>                            ║');
      console.error('║  - HDL      → vsim -c -do "run -all" <testbench>             ║');
      console.error('╚══════════════════════════════════════════════════════════════╝');
      console.error('');
      process.exit(0);
    }

    // 命令是安全只读命令 → 放行（保留标记）
    // 用 matchesAll: 每一段都必须安全, 否则 `cd x && <危险命令>` 会整条溜过。
    if (matchesAll(command, SAFE_PATTERNS)) {
      process.exit(0);
    }

    // 其他命令 → 拦截
    console.error('');
    console.error('╔══════════════════════════════════════════════════════════════╗');
    console.error('║    🔒 VERIFICATION GATE — 验证闭环硬门禁                   ║');
    console.error('╠══════════════════════════════════════════════════════════════╣');
    console.error('║                                                              ║');
    console.error('║  已编辑文件但尚未通过功能验证。                               ║');
    console.error('║  验证要求见 docs/rules/00-core.md。                           ║');
    console.error('║                                                              ║');
    console.error('║  ❌ 仅跑语法检查不算验证。                                     ║');
    console.error('║  ✅ 请运行功能验证 (pytest / vsim / iverilog / check_*.py)    ║');
    console.error('║                                                              ║');
    console.error('║  若这是合法验证命令但被误拦，解除方式:                        ║');
    console.error('║  node engine/scripts/hooks/verification-gate.cjs --reset      ║');
    console.error('║                                                              ║');
    console.error('║  [VerificationGate] 命令被阻断:                              ║');
    console.error(`║  ${command.slice(0, 72).padEnd(72)}║`);
    console.error('╚══════════════════════════════════════════════════════════════╝');
    console.error('');
    process.exit(2);
  }

  process.exit(0);
}

if (require.main === module) main();

module.exports = {
  bashResultFromPayload,
  commandSegments,
  evaluate,
  gitSubcommand,
  matchesAll,
  matchesAny,
  verificationVerdict,
};
