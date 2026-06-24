#!/usr/bin/env node
/**
 * engine/scripts/hdl-lint/logic-analyzer.cjs — RTL 逻辑级数/扇出静态分析
 *
 * 对 .sv/.v 文件做轻量级静态分析，估算:
 *   1. 组合逻辑级数 (Logic Level)
 *   2. 扇出计数 (Fan-out)
 *   3. 嵌套深度 (Nesting Depth)
 *
 * 不依赖综合工具，基于词法扫描。准确度足够拦截明显违规。
 *
 * 阈值 (符合 FPGA 设计最佳实践):
 *   MAX_LOGIC_LEVEL:   8  (超过需流水线拆分)
 *   MAX_FANOUT:      1000 (超过需寄存器复制)
 *   MAX_NESTING:       4  (超过需状态机拆分)
 */

'use strict';

const fs = require('fs');

const THRESHOLDS = {
  MAX_LOGIC_LEVEL: 8,
  MAX_FANOUT: 1000,
  MAX_NESTING: 4,
};

// ── 词法分析 ─────────────────────────────────────────────────────────────────

/**
 * 估算一个 always_comb 块内的组合逻辑级数。
 * 通过查看赋值右侧的链式操作符深度判断。
 */
function estimateLogicLevel(body) {
  let maxDepth = 0;
  const lines = body.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    // 跳过注释和空行
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || !trimmed) continue;

    // 找赋值语句: a = b + c;
    if (/<=|=(?!=)/.test(trimmed) && !trimmed.startsWith('//')) {
      const rhs = trimmed.replace(/^.*?<=|=(?!=)/, '').trim().replace(/;.*$/, '');
      if (!rhs) continue;

      // 操作符链深度: a + b + c + d → 3 级
      const ops = rhs.match(/[+\-*/&|^%<>]=?/g);
      const opDepth = ops ? ops.length : 0;

      // 三目运算符链: a ? b : c ? d : e → 2 级
      const ternaryChain = (rhs.match(/\?/g) || []).length;

      // 函数调用嵌套: func1(func2(x)) → 2 级
      const callDepth = (rhs.match(/\(/g) || []).length;

      const lineDepth = Math.max(opDepth, ternaryChain, callDepth);
      if (lineDepth > maxDepth) maxDepth = lineDepth;
    }
  }

  return maxDepth;
}

/**
 * 计算扇出: 统计每个信号在模块中被引用的次数（排除声明行）。
 */
function estimateFanout(content) {
  const signals = new Map();  // signalName → { declared: boolean, refCount: number }

  // 行级别处理
  const lines = content.split('\n');
  const declared = new Set();  // 本行是声明的信号

  // 阶段1: 收集所有信号声明
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || !trimmed) continue;

    // 匹配声明:  wire [7:0] sig_name;  reg sig_name;  logic sig_a, sig_b;
    // input/output 也是声明
    const declMatch = trimmed.match(/^\s*(?:input|output|inout|wire|reg|logic)\s+(?:\[.*?\]\s+)?(\w[\w,]*(?:\s*,\s*\w[\w,]*)*)/);
    if (declMatch) {
      const names = declMatch[1].split(',').map(n => n.trim()).filter(Boolean);
      for (const n of names) {
        declared.add(n);
      }
    }

    // 匹配 .name(signal) 例化语法
    const instMatch = trimmed.matchAll(/\.(\w+)\s*\(/g);
    for (const m of instMatch) {
      declared.add(m[1]);
    }
  }

  // 阶段2: 统计引用次数
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || !trimmed) continue;

    // 跳过声明行本身
    const isDeclLine = /^\s*(?:input|output|inout|wire|reg|logic)\s/.test(trimmed);
    if (isDeclLine) continue;

    // 在非声明行中查找所有信号名
    const wordRegex = /\b([a-z_]\w*)\b/gi;
    let match;
    while ((match = wordRegex.exec(trimmed)) !== null) {
      const sig = match[1];
      // 过滤掉 Verilog 关键字
      if (KEYWORDS.has(sig)) continue;
      if (declared.has(sig)) {
        signals.set(sig, (signals.get(sig) || 0) + 1);
      }
    }
  }

  return signals;
}

const KEYWORDS = new Set([
  'module', 'endmodule', 'input', 'output', 'inout', 'wire', 'reg', 'logic',
  'assign', 'always', 'initial', 'begin', 'end', 'if', 'else', 'case',
  'endcase', 'for', 'while', 'repeat', 'forever', 'posedge', 'negedge',
  'or', 'and', 'nand', 'nor', 'xor', 'xnor', 'not', 'buf', 'bufif0', 'bufif1',
  'notif0', 'notif1', 'parameter', 'localparam', 'genvar', 'generate',
  'endgenerate', 'function', 'endfunction', 'task', 'endtask', 'specify',
  'endspecify', 'integer', 'real', 'time', 'realtime', 'supply0', 'supply1',
  'tri', 'tri0', 'tri1', 'wand', 'wor', 'triand', 'trior', 'trireg',
  'default', 'unique', 'priority', 'modport', 'clocking', 'assert', 'assume',
  'cover', 'property', 'sequence', 'typedef', 'enum', 'struct', 'union',
  'package', 'endpackage', 'import', 'new', 'this', 'super', 'void',
  'automatic', 'static', 'bit', 'byte', 'int', 'shortint', 'longint',
  'shortreal', 'string', 'event', 'ref', 'const', 'class', 'extends',
  'implements', 'interface', 'endinterface', 'modport', 'clocking',
  'virtual', 'protected', 'local', 'rand', 'randc', 'randcase',
  'constraint', 'solve', 'dist', 'inside',
]);

// ── main ─────────────────────────────────────────────────────────────────────

function analyzeFile(filePath) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch {
    return { error: `无法读取文件: ${filePath}` };
  }

  const fileName = filePath.split(/[/\\]/).pop();

  // 提取模块名
  const modMatch = content.match(/module\s+(\w+)/);
  const moduleName = modMatch ? modMatch[1] : fileName;

  // 提取 always_comb / always @* 块
  const alwaysCombs = [];
  const combRegex = /always_(?:comb|@\s*\*)\s*(?:begin\s*)?([^]*?)(?=\bend\b|always_|endmodule)/gi;
  let match;
  while ((match = combRegex.exec(content)) !== null) {
    alwaysCombs.push(match[1] || '');
  }

  // 计算逻辑级数
  let maxLogicLevel = 0;
  let worstCombLine = '';
  for (const body of alwaysCombs) {
    const level = estimateLogicLevel(body);
    if (level > maxLogicLevel) {
      maxLogicLevel = level;
      // 找最深的行
      const lines = body.split('\n');
      for (const line of lines) {
        const ops = (line.match(/[+\-*/&|^%<>]=?/g) || []).length;
        const ternary = (line.match(/\?/g) || []).length;
        if (Math.max(ops, ternary) === level) {
          worstCombLine = line.trim().slice(0, 60);
        }
      }
    }
  }

  // 计算扇出
  const fanoutMap = estimateFanout(content);
  let maxFanout = 0;
  let worstSignal = '';
  for (const [sig, count] of fanoutMap) {
    if (count > maxFanout) {
      maxFanout = count;
      worstSignal = sig;
    }
  }

  // 计算嵌套深度 (if/case/for 嵌套)
  let maxNesting = 0;
  let curNesting = 0;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//')) continue;
    if (/\b(if|else\s+if|case|for|while|begin)\b/.test(trimmed)) curNesting++;
    if (/\b(end|endcase)\b/.test(trimmed)) curNesting = Math.max(0, curNesting - 1);
    if (trimmed.includes('end') && !trimmed.includes('begin')) curNesting = Math.max(0, curNesting - 1);
    if (curNesting > maxNesting) maxNesting = curNesting;
  }

  // 汇总结果
  const violations = [];

  if (maxLogicLevel > THRESHOLDS.MAX_LOGIC_LEVEL) {
    violations.push({
      type: '逻辑级数超标',
      severity: 'HIGH',
      actual: maxLogicLevel,
      threshold: THRESHOLDS.MAX_LOGIC_LEVEL,
      detail: `组合逻辑 ${maxLogicLevel} 级 (阈值 ${THRESHOLDS.MAX_LOGIC_LEVEL}) — 需插入流水线寄存器`,
      location: worstCombLine ? `最深层赋值: ${worstCombLine}` : '',
    });
  }

  if (maxFanout > THRESHOLDS.MAX_FANOUT) {
    violations.push({
      type: '扇出超标',
      severity: 'HIGH',
      actual: maxFanout,
      threshold: THRESHOLDS.MAX_FANOUT,
      detail: `信号 ${worstSignal} 扇出 ${maxFanout} (阈值 ${THRESHOLDS.MAX_FANOUT}) — 需寄存器复制`,
      location: `最差信号: ${worstSignal}`,
    });
  }

  if (maxNesting > THRESHOLDS.MAX_NESTING) {
    violations.push({
      type: '嵌套深度超标',
      severity: 'MEDIUM',
      actual: maxNesting,
      threshold: THRESHOLDS.MAX_NESTING,
      detail: `嵌套深度 ${maxNesting} 层 (阈值 ${THRESHOLDS.MAX_NESTING}) — 需拆分状态机或逻辑`,
      location: '',
    });
  }

  return {
    moduleName,
    fileName,
    metrics: {
      maxLogicLevel,
      maxFanout,
      maxNesting,
      alwaysCombCount: alwaysCombs.length,
      signalCount: fanoutMap.size,
    },
    violations,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    // 从 stdin 读取文件路径
    const stdin = fs.readFileSync(0, 'utf8').trim();
    if (!stdin) {
      console.log('用法: node logic-analyzer.cjs <file.sv> 或 管道传路径');
      process.exit(0);
    }
    args.push(...stdin.split('\n').map(s => s.trim()).filter(Boolean));
  }

  let allViolations = [];
  let hasError = false;

  for (const filePath of args) {
    if (!fs.existsSync(filePath)) {
      console.error(`[LogicAnalyzer] 文件不存在: ${filePath}`);
      continue;
    }

    const result = analyzeFile(filePath);

    if (result.error) {
      console.error(`[LogicAnalyzer] ${result.error}`);
      continue;
    }

    console.log(`\n${result.fileName} (${result.moduleName}):`);
    console.log(`  组合逻辑级数: ${result.metrics.maxLogicLevel} / ${THRESHOLDS.MAX_LOGIC_LEVEL}`);
    console.log(`  最大扇出:     ${result.metrics.maxFanout} / ${THRESHOLDS.MAX_FANOUT}`);
    console.log(`  嵌套深度:     ${result.metrics.maxNesting} / ${THRESHOLDS.MAX_NESTING}`);
    console.log(`  always_comb:  ${result.metrics.alwaysCombCount} 块`);

    if (result.violations.length > 0) {
      hasError = true;
      allViolations.push(...result.violations);
      for (const v of result.violations) {
        const tag = v.severity === 'HIGH' ? 'FAIL' : 'WARN';
        console.log(`  [${tag}] ${v.detail}`);
        if (v.location) console.log(`        ${v.location}`);
      }
    } else {
      console.log(`  [PASS] 全部指标正常`);
    }
  }

  console.log('');
  if (hasError) {
    process.exit(2);
  }
}

if (require.main === module) {
  main();
}

module.exports = { analyzeFile, THRESHOLDS };
