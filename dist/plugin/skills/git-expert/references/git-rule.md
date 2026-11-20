# Git Constraints

## Git 提交流程
- 新建项目或者需要修改项目文件时，应先检测是否创建git管理分支，如果没有，则需要立即创建，分支名为main
- commit前必须运行 lint/syntax check，确保代码无语法错误
- commit前必须验证仿真通过（如vsim -c -do run.do）
- 暂存区只添加与本次修改相关的文件，禁止使用 `git add -A` 或 `git add .`

## 分支管理策略
- main分支只接受 squash merge，不接受直接提交
- 功能开发在独立分支上进行，分支命名规则：
  - feat/<功能名>         //新功能
  - fix/<bug简要描述>     //修bug
  - refactor/<模块名>     //重构
- 合并到main前先 rebase 到最新的 main，解决冲突后再合并
- 分支合并后删除远端和本地分支

## .gitignore 必需包含项
- 使用git管理项目时，检测是否存在.gitignore，如没有则需要添加
- FPGA: *.vcd, *.vcd.lxt, *.wlf, transcript, vsim.wlf, work/
- Modelsim: transcript, vsim.dump, *.wlftmp
- TD软件: *.td_ip, *.td_impl, *.td_tcl
- Python: __pycache__/, *.pyc, .venv/
- Matlab: *.asv, slprj/
- 仿真输出: *_sim/, wave_*.do

## 大文件和二进制文件规则
- 超过 50MB 的文件不应提交到 git（FPGA bitstream、IP核压缩包等）
- Modelsim .vsim 文件夹、工程自动生成的build输出，使用 .gitignore 排除
- 确需版本管理的IP核，仅提交 IP 配置文件（.xci / .ip 等），不提交综合后的网表

## Git 提交信息规范
- 格式: <type>(<scope>): <简短描述>
- 类型: feat/fix/refactor/docs/test/chore
- 描述使用英文，首字母小写，不超过72字符
- 正文（如需）用中文详细说明改动原因（非内容）
- 示例:
  feat(fft): add 1024-point pipelined FFT module
  fix(uart): fix baud rate misalignment at 115200bps

## 代码 Lint 规则
- commit 前必须通过 lint 检查，无语法错误才能提交
- lint 检查由 .githooks/pre-commit 自动执行，也可手动运行

### Verilog / SystemVerilog
- 工具: `vlog -lint`（Modelsim）
- 检查扩展名: .v, .sv
- 手动运行: `vlog -lint <file>.v`
- 规则: 所有新建 .v/.sv 文件必须保持零 Error，Warning 应尽量清零

### VHDL
- 工具: `vcom -lint`（Modelsim）
- 检查扩展名: .vhd, .vhdl
- 手动运行: `vcom -lint <file>.vhd`

### Python
- 语法检查: `python3 -m py_compile <file>.py`
- 风格检查（推荐安装其一）:
  - `pip install flake8` — 传统 linter，稳定成熟
  - `pip install ruff` — Rust 实现，比 flake8 快 10-100 倍，推荐
- 手动运行: `ruff check <file>.py` 或 `flake8 <file>.py`
- 行宽限制: 100 字符

### MATLAB
- 工具: `checkcode()`（MATLAB 内置）
- 手动运行: `matlab -batch "checkcode('<file>.m'); exit;"`
- 注意: MATLAB 启动较慢，pre-commit hook 中会跳过耗时检查，建议编码完成后手动运行一次

## 提交前自动检查（双重防护）

### 1. Git pre-commit hook（硬拦截）
在工程根目录执行以下命令启用：
```
git config core.hooksPath .githooks
```
脚本 .githooks/pre-commit 会检查：
- 是否在 main 分支直接提交（❌ 拦截）
- 暂存区是否有 >50MB 大文件（❌ 拦截）
- 是否混入仿真产物 transcript/*.wlf/*.vcd（❌ 拦截）
- 代码中是否有 DEBUG/TODO/FIXME 标记（⚠️ 警告）

### 2. Claude Code hookify 规则（AI 行为约束）
规则文件 .claude/hookify.prevent-*.local.md 会自动生效：
- `hookify.prevent-main-commit` — 拦截 Claude 在 main 分支执行 git commit
- `hookify.prevent-sim-artifacts` — 警告 Claude 提交仿真产物
- `hookify.prevent-large-files` — 警告暂存区有大文件
