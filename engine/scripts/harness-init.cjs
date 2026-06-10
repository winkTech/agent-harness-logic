#!/usr/bin/env node
/**
 * engine/scripts/harness-init.cjs — FPGA 项目脚手架。
 *
 * 交互式引导创建新项目，自动：
 *   1. 检测 EDA 工具链
 *   2. 生成 Makefile（带 lint/compile/sim/regress 目标）
 *   3. 生成 fpga_constraints.yaml
 *   4. 生成 .f 文件列表
 *   5. 生成首模块模板（引用 templates/）
 *
 * 用法:
 *   node engine/scripts/harness-init.cjs                  # 交互式
 *   node engine/scripts/harness-init.cjs --project my_prj # 非交互（需全参数）
 *   node engine/scripts/harness-init.cjs --help           # 帮助
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { detect: detectEda, pickLintTool, report } = require('./eda-detect.cjs');

const HOME = path.join(os.homedir(), '.claude');
const TEMPLATES_DIR = path.join(HOME, 'skills', 'hdl-coding', 'templates');

// ── 工具函数 ────────────────────────────────────────────────────────────────

function ask(prompt, defaultVal) {
  return new Promise((resolve) => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    const hint = defaultVal ? ` [${defaultVal}]` : '';
    rl.question(`${prompt}${hint}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultVal || '');
    });
  });
}

function log(msg) { console.log(`  ${msg}`); }
function ok(msg) { console.log(`  ✅ ${msg}`); }
function warn(msg) { console.log(`  ⚠️  ${msg}`); }
function section(title) { console.log(`\n━━━ ${title} ━━━`); }

// ── Makefile 生成 ───────────────────────────────────────────────────────────

function generateMakefile(projectName, lintTool, simulator, edaTools) {
  // 检测最佳匹配的工具链 .mk 文件
  const HOME_DIR = path.join(os.homedir(), '.claude');
  let toolchainMk = '';

  if (edaTools.find(t => t.name === 'xvlog' && t.available)) {
    toolchainMk = 'vivado.mk';
  } else if (edaTools.find(t => t.name === 'vlog' && t.available)) {
    // 区分 ModelSim 与 Questa (vlog -version 输出含不同标识)
    const vlogTool = edaTools.find(t => t.name === 'vlog');
    const isModelSim = /modelsim/i.test(vlogTool?.versionRaw || '');
    toolchainMk = isModelSim ? 'modelsim.mk' : 'questa.mk';
  } else if (edaTools.find(t => t.name === 'iverilog' && t.available)) {
    toolchainMk = 'iverilog.mk';
  }

  const includeLine = toolchainMk
    ? `HARNESS_DIR ?= ${HOME_DIR.replace(/\\/g, '/')}\ninclude $(HARNESS_DIR)/engine/toolchains/${toolchainMk}`
    : '# 未检测到支持的工具链，请手动配置';

  return `# ${projectName} — 由 harness-init 自动生成
# 工具链: ${lintTool?.label || '未检测到'}, 仿真器: ${simulator || 'vsim'}

.PHONY: all clean help

all: lint compile

# ── 工具链 (引用 .claude/toolchains/*.mk) ─────────────────────────────────
${includeLine}

# ── 项目配置 ───────────────────────────────────────────────────────────────
TOP_MODULE ?= ${projectName}_top
SRC_DIR    ?= 01_src

clean:
\trm -rf work *.log *.vcd *.wlf *.vvp xsim.dir .Xil

help:
\t@echo "Targets: lint compile sim wave clean"
\t@echo "工具链: ${lintTool?.label || '未检测到'}"
\t@echo "Sim:    ${simulator || 'vsim'}"

# ── 回归 (多目标串联) ──────────────────────────────────────────────────────
regress: lint compile sim
\t@echo "=== Regression PASS ==="
`;
}

// ── fpga_constraints.yaml 生成 ─────────────────────────────────────────────

function generateConstraints(fmax, device) {
  return `# FPGA 约束 — ${device || 'xc7k325tffg900-2'}
# 由 harness-init 自动生成

target:
  fmax: ${fmax || '200MHz'}
  lut: 5000
  ff: 10000
  bram: 20
  dsp: 16

clocks:
  - name: i_clk_sys
    period: ${fmax ? (1000 / parseInt(fmax)).toFixed(1) : '5.0'}
    ports: [i_clk_p, i_clk_n]

iodelay:
  input_max: 3.0
  input_min: 1.0
  output_max: 2.5
  output_min: 0.5
`;
}

// ── 模块模板 ────────────────────────────────────────────────────────────────

function generateModule(name, bitWidth) {
  const bw = bitWidth || 16;
  return `// ${name} — 由 harness-init 生成
// template: ${name}
// version: 0.1.0
// domain: comm

module ${name} #(
  parameter DATA_WIDTH = ${bw}
) (
  input  logic                i_clk,
  input  logic                i_rst,
  input  logic [DATA_WIDTH-1:0] i_data,
  output logic [DATA_WIDTH-1:0] o_data
);

  // 输入寄存
  logic [DATA_WIDTH-1:0] ri_data;
  always_ff @(posedge i_clk) begin
    if (i_rst) ri_data <= '0;
    else       ri_data <= i_data;
  end

  // 输出寄存
  logic [DATA_WIDTH-1:0] ro_data;
  assign o_data = ro_data;

  // TODO: 实现逻辑

endmodule
`;
}

// ── TB 模板 ─────────────────────────────────────────────────────────────────

function generateTb(name) {
  return `// tb_${name} — 由 harness-init 生成

` + '`timescale 1ns/1ps\n' + `
module tb_${name}();

  localparam CLK_PERIOD = 10;
  localparam DATA_WIDTH = 16;

  logic                    clk;
  logic                    rst;
  logic [DATA_WIDTH-1:0]   data;
  logic [DATA_WIDTH-1:0]   result;

  // DUT
  ${name} #(
    .DATA_WIDTH(DATA_WIDTH)
  ) u_dut (
    .i_clk  (clk),
    .i_rst  (rst),
    .i_data (data),
    .o_data (result)
  );

  // 时钟
  initial clk = 0;
  always #(CLK_PERIOD/2) clk = ~clk;

  // 测试
  initial begin
    rst = 1; data = '0;
    repeat (10) @(posedge clk);
    rst = 0;

    data = 'h1234;
    repeat (5) @(posedge clk);

    data = 'hABCD;
    repeat (5) @(posedge clk);

    $display("=== TEST PASSED ===");
    $finish;
  end

  // 波形
  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, tb_${name});
  end

endmodule
`;
}

// ── 目录结构生成 ────────────────────────────────────────────────────────────

function toolchainLabel(tools) {
  if (tools.find(t => t.name === 'xvlog' && t.available)) return 'Vivado';
  if (tools.find(t => t.name === 'vlog' && t.available)) {
    const vlogTool = tools.find(t => t.name === 'vlog');
    return /modelsim/i.test(vlogTool?.versionRaw || '') ? 'ModelSim' : 'Questa';
  }
  if (tools.find(t => t.name === 'quartus_map' && t.available)) return 'Quartus';
  if (tools.find(t => t.name === 'vcs' && t.available)) return 'VCS';
  if (tools.find(t => t.name === 'xrun' && t.available)) return 'Xcelium';
  if (tools.find(t => t.name === 'iverilog' && t.available)) return 'Icarus';
  if (tools.find(t => t.name === 'verilator' && t.available)) return 'Verilator';
  return '未检测到';
}

function createProjectStructure(rootDir, projectName) {
  const dirs = [
    rootDir,
    path.join(rootDir, '01_src', 'tx'),
    path.join(rootDir, '01_src', 'rx'),
    path.join(rootDir, '01_src', 'top'),
    path.join(rootDir, '02_tb'),
    path.join(rootDir, '03_doc'),
    path.join(rootDir, '04_script'),
    path.join(rootDir, '05_result', 'synth'),
    path.join(rootDir, '05_result', 'sim'),
    path.join(rootDir, '05_result', 'rpt'),
    path.join(rootDir, '06_ref'),
  ];

  for (const d of dirs) {
    fs.mkdirSync(d, { recursive: true });
  }

  return dirs;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help')) {
    console.log('用法: node engine/scripts/harness-init.cjs [选项]');
    console.log('');
    console.log('选项:');
    console.log('  --project <name>    项目名称（非交互模式）');
    console.log('  --device  <part>    目标器件型号');
    console.log('  --fmax    <freq>    目标时钟频率');
    console.log('  --dir     <path>    项目目录（默认 ./<project>）');
    console.log('  --help              帮助');
    process.exit(0);
  }

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   FPGA 项目脚手架 — harness-init         ║');
  console.log('╚══════════════════════════════════════════╝');

  // ── 1. EDA 工具链检测 ────────────────────────────────────────────────
  section('检测 EDA 工具链');
  const edaTools = detectEda();
  console.log(report(edaTools));
  const lintTool = pickLintTool(edaTools);
  const simulators = edaTools.filter(t => t.name === 'xsim' || t.name === 'vsim' || t.name === 'iverilog');
  const defaultSim = simulators.find(t => t.available)?.cmd || 'vsim';

  // ── 2. 项目信息 ─────────────────────────────────────────────────────
  section('项目配置');

  const projectName = args.includes('--project')
    ? args[args.indexOf('--project') + 1]
    : await ask('项目名称', 'my_fpga_project');

  const device = args.includes('--device')
    ? args[args.indexOf('--device') + 1]
    : await ask('目标器件', 'xc7k325tffg900-2');

  const fmax = args.includes('--fmax')
    ? args[args.indexOf('--fmax') + 1]
    : await ask('目标时钟频率 (MHz)', '200');

  const projectDir = args.includes('--dir')
    ? args[args.indexOf('--dir') + 1]
    : path.join(process.cwd(), projectName);

  // ── 3. 创建目录 ─────────────────────────────────────────────────────
  section('创建项目结构');
  const dirs = createProjectStructure(projectDir, projectName);
  ok(`项目目录: ${projectDir}`);
  for (const d of dirs.slice(0, 6)) {
    const short = path.relative(projectDir, d) || '.';
    ok(`创建 ${short}/`);
  }

  // ── 4. 生成文件 ─────────────────────────────────────────────────────
  section('生成文件');

  // Makefile (引用 toolchains/*.mk)
  const makefile = generateMakefile(projectName, lintTool, defaultSim, edaTools);
  fs.writeFileSync(path.join(projectDir, 'Makefile'), makefile);
  ok(`Makefile (toolchain=${toolchainLabel(edaTools)}, sim=${defaultSim})`);

  // .gitignore
  const gitignore = `*.log
*.vcd
*.wlf
*.vvp
work/
xsim.dir/
.Xil/
`;
  fs.writeFileSync(path.join(projectDir, '.gitignore'), gitignore);
  ok(`.gitignore (仿真临时文件/波形)`);

  // fpga_constraints.yaml
  const constraints = generateConstraints(fmax + 'MHz', device);
  fs.writeFileSync(path.join(projectDir, 'fpga_constraints.yaml'), constraints);
  ok(`fpga_constraints.yaml (fmax=${fmax}MHz, device=${device})`);

  // 源文件 .f 列表
  const fContent = `# ${projectName} — 源文件列表\n# 由 harness-init 生成\n\n# 请手动添加源文件，一条一行\n`;
  fs.writeFileSync(path.join(projectDir, `${projectName}.f`), fContent);
  ok(`${projectName}.f (源文件列表，请手动编辑)`);

  // 首模块
  const moduleContent = generateModule(`${projectName}_top`, 16);
  fs.writeFileSync(path.join(projectDir, '01_src', 'top', `${projectName}_top.sv`), moduleContent);
  ok(`01_src/top/${projectName}_top.sv (模块模板)`);

  // TB
  const tbContent = generateTb(`${projectName}_top`);
  fs.writeFileSync(path.join(projectDir, '02_tb', `tb_${projectName}_top.sv`), tbContent);
  ok(`02_tb/tb_${projectName}_top.sv (TB 模板)`);

  // ── 5. 模板引用 ─────────────────────────────────────────────────────
  section('可用模板');
  if (fs.existsSync(TEMPLATES_DIR)) {
    const domains = fs.readdirSync(TEMPLATES_DIR).filter(f =>
      fs.statSync(path.join(TEMPLATES_DIR, f)).isDirectory()
    );
    for (const d of domains) {
      const files = fs.readdirSync(path.join(TEMPLATES_DIR, d)).filter(f => f.endsWith('.v') || f.endsWith('.sv'));
      log(`${d}/: ${files.join(', ')}`);
    }
  } else {
    warn('模板目录不存在');
  }

  // ── 汇总 ───────────────────────────────────────────────────────────
  section('项目就绪');
  console.log(`
  📁 ${projectDir}
  ├── Makefile               — lint / compile / sim / regress
  ├── fpga_constraints.yaml  — 资源/时序预算
  ├── ${projectName}.f          — 源文件列表
  ├── 01_src/
  │   ├── tx/                — 发送模块
  │   ├── rx/                — 接收模块
  │   └── top/               — 顶层模块
  ├── 02_tb/                 — Testbench
  ├── 03_doc/                — 文档
  ├── 04_script/             — 脚本
  ├── 05_result/             — 综合/仿真结果
  └── 06_ref/                — 参考

  下一步:
    cd ${projectName}
    make lint                 # 检查语法
    make sim                  # 运行仿真
    code fpga_constraints.yaml # 调整资源预算
`);
}

main().catch(e => {
  console.error(`\n❌ 错误: ${e.message}`);
  process.exit(1);
});
