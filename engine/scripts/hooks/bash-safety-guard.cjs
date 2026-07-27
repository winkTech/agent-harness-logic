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
    ],
    message: 'Bash 写源码绕过: 请使用 Edit/Write 工具，让写入门禁检查源码变更',
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
function block(info, command) {
  console.error('');
  console.error('╔══════════════════════════════════════════════════════════════╗');
  console.error('║      🛑  BASH SAFETY GUARD — 命令被阻断                    ║');
  console.error('╠══════════════════════════════════════════════════════════════╣');
  console.error(`║  风险等级: ${info.severity.padEnd(40)}║`);
  console.error(`║  类别:     ${info.category.padEnd(40)}║`);
  console.error(`║  原因:     ${info.message.padEnd(40)}║`);
  console.error('║                                                              ║');
  console.error('║  此命令被 Bash 安全门禁止执行。                                 ║');
  console.error('║  如需绕过: 在 settings.local.json 中添加例外规则。             ║');
  console.error('╚══════════════════════════════════════════════════════════════╝');
  console.error('');
  console.error(`[BashSafetyGuard] BLOCKED: ${info.message}`);
  console.error(`[BashSafetyGuard] Command (truncated): ${command.slice(0, 200)}`);
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

// ── 主逻辑 ───────────────────────────────────────────────────────────────────

async function main() {
  try {
    const raw = (await readStdin()).replace(/^\uFEFF/, '');
    if (!raw) process.exit(0);

    const payload = JSON.parse(raw);

    // 兼容 stdin 格式:  (a) tool.input.command  (b) tool_input.command  (c) 平铺
    const command = (payload?.tool?.input?.command
      || payload?.tool_input?.command
      || payload?.input?.command
      || payload?.command
      || '').trim();

    if (!command) process.exit(0);

    const { matched, info } = scanCommand(command);

    if (matched) {
      block(info, command);
      process.exit(2); // 硬拦截
    }
  } catch (e) {
    // 解析失败时不阻断，静默放行
    console.error(`[BashSafetyGuard] 解析错误(放行): ${e.message}`);
  }

  process.exit(0);
}

main();
