# FPGA Agent Harness

基于 [learn-claude-code](https://github.com/shareAI-lab/learn-claude-code) 架构，面向FPGA开发的本地Agent Harness。

## 位置

```
C:\Users\Lihan\.claude\fpga-agent-harness\
```

## 架构设计

```
fpga-agent-harness/
├── core/               # 核心模块（Agent循环、工具分发）
├── safety/             # 安全模块（权限、钩子）
├── planning/           # 规划模块（待办、任务图）
├── context/            # 上下文管理（子agent、技能、压缩、记忆）
├── error/              # 错误恢复
├── llm/                # LLM适配层
├── tools/              # 工具系统
├── skills/             # 技能定义
├── config/             # 配置文件
└── main.py             # 主入口
```

## 核心能力（来自learn-claude-code）

| 机制 | 来源 | 作用 |
|------|------|------|
| Agent Loop | s01 | 核心循环 |
| Tool Dispatch | s02 | 工具分发 |
| Permission | s03 | 权限检查 |
| Hooks | s04 | 扩展点 |
| TodoWrite | s05 | 待办管理 |
| Subagent | s06 | 子agent隔离 |
| Skill Loading | s07 | 技能按需加载 |
| Context Compact | s08 | 上下文压缩 |
| Memory | s09 | 记忆系统 |
| Task Graph | s12 | 任务依赖图 |
| Error Recovery | s11 | 错误恢复 |

## 快速开始

### 1. 安装依赖

```bash
pip install openai pyyaml
```

### 2. 配置vLLM

编辑 `config/settings.yaml`：

```yaml
llm:
  base_url: "http://localhost:8000/v1"
  model: "your-model-name"
```

### 3. 运行

```bash
cd C:\Users\Lihan\.claude\fpga-agent-harness
python main.py
```

## 使用示例

```
>> 分析这个Verilog文件的结构
>> 帮我写一个FIFO模块
>> 检查这个MATLAB函数的语法
>> 运行ModelSim仿真
```

## 适配你的本地LLM

本项目使用OpenAI兼容API，适配vLLM、Ollama等本地推理框架。

只需修改 `config/settings.yaml` 中的 `base_url` 和 `model` 即可。

## 许可证

MIT
