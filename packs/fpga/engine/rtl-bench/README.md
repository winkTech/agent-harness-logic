# RTL Agent Benchmark

测试 agent 三种能力的基准：**Track A** 按 spec 写 RTL、**Track B** 为给定 RTL 写验证（TB 质量用变异测试量化）、**Track C** 依据综合报告修缮代码 QoR。评测矩阵为 agent × harness(bare|full)。

## 目录

```
engine/rtl-bench/
  schemas/task-manifest.schema.json   任务 manifest 格式
  graders/                            判卷脚本(判卷资产不进 agent 工作区)
    grade-track-a.cjs                 功能(隐藏 TB) + QoR 红线(vivado-flow OOC synth)
    grade-track-b.cjs                 mutation score(对参考实现零误报 + 变异体 kill 率)
    grade-track-c.cjs                 功能回归 + QoR 预算达标
    lock-task.cjs                     计算/刷新任务资产 sha256 锁
    lib/                              sim(ModelSim) / vivado / 公共库
  tasks/<id>/
    task.json                         manifest(含 locks 完整性哈希)
    briefs/spec-track-{a,b,c}.md      发给 agent 的任务书(每赛道一份)
    public/                           允许进 agent 工作区的文件
    ref/                              参考实现(判卷侧)
    seed/                             Track C 种子(功能正确但 QoR 差) + 其基线 flow_summary.json
    hidden/tb_hidden.sv               隐藏判卷 TB
    hidden/mutants/*.sv               Track B 变异体(每个单点注入一个真实故障模式)
    xdc/                              OOC 综合约束
```

运行产物统一落 `var/agent-evals/rtl-bench/<run-id>/`。

## 判卷契约

- TB stdout 必须含 `RESULT: PASS` 或 `RESULT: FAIL`（取最后一次出现）；超时/无 RESULT 视为无效。
- QoR 数字一律取 vivado-flow 的 `flow_summary.json`，不从 .rpt 人工抄。
- 判卷前校验 `task.json.locks` 中 ref/hidden/seed/xdc 资产哈希，防篡改与漂移。
- Track B 计分：agent TB 对参考实现必须 PASS（误报直接 fail），对每个变异体 FAIL 记一次 kill，`score = kills / mutants ≥ scoreMin` 通过。变异体上超时不计 kill（TB 契约要求自带看门狗）。

## 单次评测(runner)

```bash
# dry-run: 不跑 agent,把 --solution 当交付物直接判卷(验证链路/调试任务资产用;A/C 默认取 ref)
node engine/rtl-bench/run-bench.cjs --task engine/rtl-bench/tasks/axis_skid_buffer --track C --dry-run --out var/agent-evals/rtl-bench/<run>

# live: 驱动真实 agent(隔离沙箱 HOME,凭证走 CLAUDE_LIVE_EVAL_* / CODEX_LIVE_EVAL_* 环境变量)
node engine/rtl-bench/run-bench.cjs --task <taskDir> --track A --agent claude --harness full --out <dir> --allow-network
```

工作区按 manifest.tracks.<track>.workspace 装配（判卷资产不进工作区），任务书落为 `TASK.md`；`--harness full` 额外注入 `harness/`（hdl-coding SKILL、01-hdl 规则、vivado-flow）+ `AGENTS.md`（注意：不含 hook 强制层，live hook 版是后续项）。产物：`run.json`（含 verdict/工具调用数/成本/越界写检测）、`transcript.jsonl`、`grade/grade.json`。

## 判卷命令

```bash
node engine/rtl-bench/graders/grade-track-a.cjs --task engine/rtl-bench/tasks/axis_skid_buffer --rtl <agent交付的rtl文件或目录> --out var/agent-evals/rtl-bench/<run>
node engine/rtl-bench/graders/grade-track-b.cjs --task engine/rtl-bench/tasks/axis_skid_buffer --tb <agent交付的tb文件> --out ...
node engine/rtl-bench/graders/grade-track-c.cjs --task engine/rtl-bench/tasks/axis_skid_buffer --rtl <agent修缮后的rtl> --out ...
```

每个 grader 写 `<out>/grade.json` 并以退出码 0(pass)/1(fail)/2(用法或资产完整性错误) 结束。

## 状态

Pilot 已完成并实证（2026-07-30）：`axis_skid_buffer` 三赛道判卷链全部实跑验证——ref 过隐藏 TB、8/8 变异体被杀、Track A ref PASS（WNS 0.526/LUT 21/FF 35）、Track C seed FAIL（FF 140>48）/ ref PASS、Track B 自测 kills 8/8 零误报。任务 2 `mac_pipe`（MAC/DSP 推断，Track A+B）同样全绿，QoR 判定新增推断核查下限（dspMin/bramMin/srlMin）。证据：`var/agent-evals/rtl-bench/pilot-verify/`。

任务时钟约束纪律：新任务先跑 ref 综合实测再定 `clockNs`（mac_pipe 教训：拍脑袋的 2.5ns 实测不可达，按测量改 4.0ns）。

下一步（runner 矩阵化、任务集扩容、仪表盘）与环境坑见 `plans/rtl-agent-bench.md`。新任务入库纪律：先过 `verify-task.cjs` 全绿，再 `lock-task.cjs` 锁资产。
