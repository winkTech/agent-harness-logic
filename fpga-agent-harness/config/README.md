# FPGA Agent Harness 配置说明

## 配置文件

### settings.yaml
主配置文件，包含所有配置项。

### .env.example
环境变量示例文件。复制为 `.env` 并填入实际值。

### validate_config.py
配置验证脚本，用于检查配置是否正确。

## 快速配置

### 1. 使用小米 mimo API（默认）

配置已预设，只需设置环境变量：

```bash
# Windows
set ANTHROPIC_AUTH_TOKEN=your_token_here

# Linux/Mac
export ANTHROPIC_AUTH_TOKEN=your_token_here
```

或创建 `.env` 文件：

```bash
cp .env.example .env
# 编辑 .env 文件，填入 ANTHROPIC_AUTH_TOKEN
```

### 2. 使用本地 vLLM

编辑 `settings.yaml`：

```yaml
llm:
  base_url: "http://localhost:8000/v1"
  model: "your-model-name"
  api_key: "EMPTY"
```

### 3. 使用其他 OpenAI 兼容 API

编辑 `settings.yaml`：

```yaml
llm:
  base_url: "https://api.openai.com/v1"
  model: "gpt-4"
  api_key: "${OPENAI_API_KEY}"
```

## 配置项说明

### LLM 配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| base_url | API 地址 | https://token-plan-cn.xiaomimimo.com/anthropic |
| model | 模型名称 | mimo-v2.5-pro |
| api_key | API 密钥 | ${ANTHROPIC_AUTH_TOKEN} |
| max_tokens | 最大 token 数 | 4096 |
| temperature | 温度 | 0.1 |

### Agent 配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| max_iterations | 最大迭代次数 | 50 |
| token_threshold | 触发压缩的 token 阈值 | 100000 |
| keep_recent_results | 保留最近的工具结果数量 | 3 |

### 工具配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| workdir | 工作目录 | . |
| enabled | 启用的工具列表 | file, shell, verilog, matlab, fpga |

### FPGA 配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| vivado.path | Vivado 安装路径 | 系统 PATH |
| vivado.default_part | 默认 FPGA 器件 | xc7a35tcpg236-1 |
| modelsim.path | ModelSim 安装路径 | 系统 PATH |

### MATLAB 配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| path | MATLAB 安装路径 | 系统 PATH |
| default_timeout | 默认超时（秒） | 300 |

### 用户偏好

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| language | 界面语言 | zh-CN |
| encoding | 文件编码 | utf-8 |
| line_ending | 行尾符 | crlf |
| tab_size | Tab 大小 | 4 |

## 验证配置

运行配置验证脚本：

```bash
python config/validate_config.py
```

## 环境变量

支持的环境变量：

| 变量名 | 说明 |
|--------|------|
| ANTHROPIC_AUTH_TOKEN | 小米 mimo API 密钥 |
| OPENAI_API_KEY | OpenAI API 密钥 |
| VLLM_BASE_URL | vLLM 服务地址 |
| VLLM_MODEL | vLLM 模型名称 |
| VIVADO_PATH | Vivado 安装路径 |
| MODELSIM_PATH | ModelSim 安装路径 |
| MATLAB_PATH | MATLAB 安装路径 |
