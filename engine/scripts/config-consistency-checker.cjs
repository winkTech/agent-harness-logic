#!/usr/bin/env node
/**
 * engine/scripts/config-consistency-checker.cjs — 配置一致性检查器
 *
 * 🔍 P1-2: 配置一致性检查
 * 参照: [1] MMLU — 多维度评估，配置一致性是 HDL 项目的关键维度
 *
 * 检查 RTL 端口声明与平台配置文件（YAML/JSON/TCL）之间的信号一致性。
 * 发现位宽不匹配、信号缺失、顺序不一致等问题。
 *
 * 用法:
 *   node engine/scripts/config-consistency-checker.cjs check <rtl_file> <config_file>
 *   node engine/scripts/config-consistency-checker.cjs scan <directory>
 *   node engine/scripts/config-consistency-checker.cjs report
 */

'use strict';

const { HARNESS_ROOT } = require('./lib/harness-root.cjs');

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const os = require('node:os');

const HOME = HARNESS_ROOT;
const RESULTS_DIR = path.join(HOME, 'var', 'index');

// ── RTL 端口提取 ───────────────────────────────────────────────────────────

const PORT_PATTERNS = [
  // input/output [signed] [range] name
  /^\s*(input|output|inout)\s+(reg|wire|logic|tri|signed|unsigned)?\s*(?:\[(\d+):(\d+)\])?\s*(\w+)/,
  // 接口声明: interface_name #(...) name
  /^\s*(\w+)\s+#\(/,
  // AXI-Stream: .*name
  /^\s*\.(\w+)\s*\(/,
  // 参数: parameter type name = value
  /^\s*parameter\s+(?:logic|int|bit|\[.*?\])?\s*(\w+)\s*=/,
];

function extractPorts(rtlContent) {
  const ports = [];
  const lines = rtlContent.split('\n');
  let inPortList = false;

  for (const line of lines) {
    const trimmed = line.trim();
    // 检测端口列表开始
    if (trimmed.match(/^\s*#\s*\(/)) { inPortList = true; continue; }
    if (inPortList && trimmed === ')') { inPortList = false; continue; }
    if (!inPortList && !trimmed.match(/^\s*(input|output|inout)\b/)) continue;

    for (const pattern of PORT_PATTERNS) {
      const m = trimmed.match(pattern);
      if (m) {
        ports.push({
          direction: m[1] || 'interface',
          type: m[2] || '',
          msb: m[3] ? parseInt(m[3]) : null,
          lsb: m[4] ? parseInt(m[4]) : null,
          name: m[5] || m[1] || m[4] || '',
        });
        break;
      }
    }

    // 端口列表结束
    if (inPortList && trimmed === ');') inPortList = false;
  }

  return ports;
}

// ── 配置文件解析 ────────────────────────────────────────────────────────────

function parseConfig(content, ext) {
  switch (ext) {
    case '.json':
      return parseJsonConfig(content);
    case '.yaml':
    case '.yml':
      return parseYamlConfig(content);
    case '.tcl':
      return parseTclConfig(content);
    case '.py':
      return parsePyConfig(content);
    default:
      return [];
  }
}

function parseJsonConfig(content) {
  try {
    const obj = JSON.parse(content);
    return flattenObject(obj, '');
  } catch {
    return [];
  }
}

function parseYamlConfig(content) {
  // 简单 YAML 解析（补丁级，不引入依赖）
  const entries = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*(\w[\w_]*)\s*:\s*(\d+|0x[\da-fA-F]+|0b[01]+|".*?")/);
    if (m) {
      entries.push({ key: m[1], value: m[2].replace(/"/g, ''), source: 'yaml' });
    }
  }
  return entries;
}

function parseTclConfig(content) {
  const entries = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const m = line.match(/set\s+(\w[\w_]*)\s+(.+)/);
    if (m) entries.push({ key: m[1], value: m[2].trim(), source: 'tcl' });
  }
  return entries;
}

function parsePyConfig(content) {
  const entries = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*(\w[\w_]*)\s*=\s*(\d+|0x[\da-fA-F]+|0b[01]+|".*?")/);
    if (m) entries.push({ key: m[1], value: m[2].replace(/"/g, ''), source: 'py' });
  }
  return entries;
}

function flattenObject(obj, prefix) {
  const entries = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'object' && v !== null) {
      entries.push(...flattenObject(v, key));
    } else {
      entries.push({ key, value: String(v), source: 'json' });
    }
  }
  return entries;
}

// ── 信号名匹配 ──────────────────────────────────────────────────────────────

function inferSignalName(configKey) {
  // 尝试从配置键名推断 RTL 信号名
  // data_width → data_width, DATA_WIDTH → data_width
  const name = configKey.replace(/^.*[._]/, '').toLowerCase();
  // 常见映射
  const MAPPINGS = {
    data_width: ['data_width', 'dw', 'DATA_WIDTH'],
    addr_width: ['addr_width', 'aw', 'ADDR_WIDTH'],
    id_width: ['id_width', 'iw', 'ID_WIDTH'],
    user_width: ['user_width', 'uw', 'USER_WIDTH'],
    dest_width: ['dest_width', 'dw', 'DEST_WIDTH'],
  };
  return MAPPINGS[name] || [name, configKey.toLowerCase()];
}

// ── 检查 ────────────────────────────────────────────────────────────────────

function checkConsistency(rtlFile, configFile) {
  console.log(`\n📋 检查: ${path.basename(rtlFile)} ↔ ${path.basename(configFile)}`);

  if (!fs.existsSync(rtlFile)) return { error: `RTL 文件不存在: ${rtlFile}` };
  if (!fs.existsSync(configFile)) return { error: `配置文件不存在: ${configFile}` };

  const rtlContent = fs.readFileSync(rtlFile, 'utf8');
  const configContent = fs.readFileSync(configFile, 'utf8');

  const ports = extractPorts(rtlContent);
  const configEntries = parseConfig(configContent, path.extname(configFile));

  console.log(`  RTL 端口: ${ports.length} 个`);
  console.log(`  配置项:   ${configEntries.length} 个`);

  const findings = [];

  // 1. 检查配置中的位宽是否与 RTL 一致
  for (const entry of configEntries) {
    const candidateNames = inferSignalName(entry.key);
    const matchingPorts = ports.filter(p => candidateNames.includes(p.name.toLowerCase()));

    for (const port of matchingPorts) {
      if (port.msb !== null && port.lsb !== null) {
        const portWidth = Math.abs(port.msb - port.lsb) + 1;
        const configWidth = parseInt(entry.value);
        if (!isNaN(configWidth) && portWidth !== configWidth) {
          findings.push({
            type: '位宽不匹配',
            severity: 'error',
            signal: port.name,
            rtl: `${portWidth} bit [${port.msb}:${port.lsb}]`,
            config: `${configWidth} bit (${entry.key}=${entry.value})`,
          });
        }
      }
    }
  }

  // 2. 检查 RTL 端口是否在配置中有对应
  for (const port of ports.filter(p => p.name && /width|size|depth|len/i.test(p.name))) {
    const match = configEntries.some(e =>
      e.key.toLowerCase().includes(port.name.toLowerCase()) ||
      port.name.toLowerCase().includes(e.key.toLowerCase())
    );
    if (!match && port.msb !== null) {
      const portWidth = Math.abs(port.msb - port.lsb) + 1;
      findings.push({
        type: '配置可能缺失',
        severity: 'warn',
        signal: port.name,
        rtl: `${portWidth} bit [${port.msb}:${port.lsb}]`,
        config: '未找到对应项',
      });
    }
  }

  if (findings.length === 0) {
    console.log('  ✅ 一致');
  } else {
    for (const f of findings) {
      const icon = f.severity === 'error' ? '❌' : '⚠️';
      console.log(`  ${icon} [${f.type}] ${f.signal}: RTL=${f.rtl}, Config=${f.config}`);
    }
  }

  return { ports, configEntries, findings };
}

// ── 目录扫描 ────────────────────────────────────────────────────────────────

function scanDirectory(dir) {
  if (!fs.existsSync(dir)) {
    console.error(`目录不存在: ${dir}`);
    return;
  }

  const files = fs.readdirSync(dir, { recursive: true })
    .filter(f => /\.(sv|v|vh)$/i.test(f))
    .map(f => path.join(dir, f));

  console.log(`\n扫描 ${dir} 下 ${files.length} 个 RTL 文件...`);

  // 查找同名的 .json/.yaml/.tcl 配置文件
  for (const rtlFile of files) {
    const basename = path.basename(rtlFile, path.extname(rtlFile));
    for (const ext of ['.json', '.yaml', '.yml', '.tcl', '.py']) {
      const configFile = rtlFile.replace(/\.(sv|v|vh)$/i, ext);
      if (fs.existsSync(configFile)) {
        checkConsistency(rtlFile, configFile);
      }
    }
  }
}

// ── 报告 ────────────────────────────────────────────────────────────────────

function generateReport() {
  // 从 var/index/consistency-results.json 读取历史
  const resultsFile = path.join(RESULTS_DIR, 'consistency-results.json');
  if (!fs.existsSync(resultsFile)) {
    console.log('[config-consistency-checker] 暂无历史数据。运行 check 或 scan 生成。');
    return;
  }

  try {
    const data = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
    console.log(`\n━━━ 配置一致性历史 ━━━`);
    console.log(`  总扫描: ${data.scans || 0}`);
    console.log(`  发现问题: ${data.issues || 0}`);
    console.log(`  最后检查: ${data.lastCheck || '未知'}`);
  } catch {
    console.log('[config-consistency-checker] 数据读取失败');
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────

function main() {
  const cmd = process.argv[2];

  switch (cmd) {
    case 'check': {
      const rtlFile = process.argv[3];
      const configFile = process.argv[4];
      if (!rtlFile || !configFile) {
        console.error('用法: node config-consistency-checker.cjs check <rtl_file> <config_file>');
        process.exit(1);
      }
      const result = checkConsistency(rtlFile, configFile);
      // 保存结果
      if (result && !result.error) {
        ensureDir(RESULTS_DIR);
        const rf = path.join(RESULTS_DIR, 'consistency-results.json');
        fs.writeFileSync(rf, JSON.stringify({
          scans: 1,
          issues: result.findings.length,
          lastCheck: new Date().toISOString(),
          lastResult: {
            rtl: path.basename(rtlFile),
            config: path.basename(configFile),
            findings: result.findings,
          },
        }, null, 2), 'utf8');
      }
      break;
    }

    case 'scan': {
      const dir = process.argv[3] || '.';
      scanDirectory(dir);
      break;
    }

    case 'report':
      generateReport();
      break;

    default:
      console.log(`
用法:
  node engine/scripts/config-consistency-checker.cjs check <rtl.sv> <config.json>
  node engine/scripts/config-consistency-checker.cjs scan <directory>
  node engine/scripts/config-consistency-checker.cjs report
`);
  }
}

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

main();
