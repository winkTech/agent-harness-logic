#!/usr/bin/env python3
"""
FPGA Agent Harness - 主入口

基于learn-claude-code架构，面向FPGA开发的本地Agent Harness
"""

import logging
import os
import sys
from pathlib import Path

import yaml

# 尝试加载 .env 文件
try:
    from dotenv import load_dotenv
    env_path = Path(__file__).parent / "config" / ".env"
    if env_path.exists():
        load_dotenv(env_path)
except ImportError:
    pass

# 核心模块
from core import AgentLoop, ToolDispatcher
from llm import VLLMAdapter
from safety import PermissionChecker, HookManager

# 上下文管理
from context import SkillLoader, ContextCompactor, MemorySystem

# 规划系统
from planning import TodoManager, TaskGraph

# 工具系统
from tools import FileTools, ShellTools, VerilogTools, MatlabTools, FpgaTools

# 错误恢复
from error import ErrorRecovery

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


def load_config(config_path: str = "config/settings.yaml") -> dict:
    """加载配置"""
    path = Path(config_path)
    if not path.exists():
        logger.warning(f"配置文件不存在: {config_path}，使用默认配置")
        return {}

    with open(path, 'r', encoding='utf-8') as f:
        return yaml.safe_load(f)


def resolve_env_vars(value: str) -> str:
    """解析环境变量占位符"""
    if isinstance(value, str) and value.startswith("${") and value.endswith("}"):
        env_var = value[2:-1]
        return os.environ.get(env_var, value)
    return value


def create_llm(config: dict) -> VLLMAdapter:
    """创建LLM适配器"""
    llm_config = config.get("llm", {})

    # 解析环境变量
    base_url = resolve_env_vars(llm_config.get("base_url", "http://localhost:8000/v1"))
    model = resolve_env_vars(llm_config.get("model", "default"))
    api_key = resolve_env_vars(llm_config.get("api_key", "EMPTY"))

    return VLLMAdapter(
        base_url=base_url,
        model=model,
        api_key=api_key,
        max_tokens=llm_config.get("max_tokens", 4096),
        temperature=llm_config.get("temperature", 0.1),
    )


def create_tools(config: dict) -> ToolDispatcher:
    """创建工具分发器"""
    dispatcher = ToolDispatcher()
    workdir = config.get("tools", {}).get("workdir", ".")

    # 注册文件工具
    file_tools = FileTools(workdir)
    for tool in file_tools.get_tools():
        dispatcher.register(tool)

    # 注册Shell工具
    shell_tools = ShellTools(workdir)
    for tool in shell_tools.get_tools():
        dispatcher.register(tool)

    # 注册Verilog工具
    verilog_tools = VerilogTools(workdir)
    for tool in verilog_tools.get_tools():
        dispatcher.register(tool)

    # 注册MATLAB工具
    matlab_tools = MatlabTools(workdir)
    for tool in matlab_tools.get_tools():
        dispatcher.register(tool)

    # 注册FPGA工具
    fpga_tools = FpgaTools(workdir)
    for tool in fpga_tools.get_tools():
        dispatcher.register(tool)

    return dispatcher


def create_system_prompt(config: dict, skill_loader: SkillLoader) -> str:
    """创建system prompt"""
    skills_list = skill_loader.list_skills()

    return f"""你是一个FPGA开发助手，专门帮助用户进行FPGA设计、Verilog/SV编码、MATLAB算法验证等工作。

## 可用技能
{skills_list}

## 工具使用规范
- 使用 read_file 读取文件
- 使用 write_file 写入文件
- 使用 edit_file 编辑文件
- 使用 bash 执行命令
- 使用 analyze_verilog 分析Verilog文件
- 使用 analyze_matlab 分析MATLAB文件

## 编码规范
- 遵循HDL编码规范（使用 load_skill hdl_coding 查看）
- 使用同步复位
- 输入输出寄存
- 命名规范：i_/o_/r_/w_ 前缀

## 工作流程
1. 先理解需求
2. 制定计划（使用 todo_update）
3. 逐步实现
4. 验证测试
"""


def main():
    """主函数"""
    print("=" * 60)
    print("FPGA Agent Harness")
    print("基于learn-claude-code架构，面向FPGA开发")
    print("=" * 60)

    # 加载配置
    config = load_config()

    # 创建LLM
    llm = create_llm(config)
    logger.info(f"LLM: {llm.model} @ {llm.client.base_url}")

    # 创建工具
    dispatcher = create_tools(config)
    logger.info(f"已注册 {len(dispatcher.get_definitions())} 个工具")

    # 创建安全系统
    permission_checker = PermissionChecker()
    hook_manager = HookManager()

    # 创建上下文管理
    skill_loader = SkillLoader(config.get("skills", {}).get("directory", "skills"))
    memory = MemorySystem(config.get("memory", {}).get("directory", ".memory"))
    compactor = ContextCompactor(llm)

    # 创建规划系统
    todo_manager = TodoManager()
    task_graph = TaskGraph(config.get("tasks", {}).get("directory", ".tasks"))

    # 创建错误恢复
    error_recovery = ErrorRecovery()

    # 创建system prompt
    system_prompt = create_system_prompt(config, skill_loader)

    # 创建Agent循环
    agent = AgentLoop(
        llm=llm,
        tool_dispatcher=dispatcher,
        permission_checker=permission_checker,
        hook_manager=hook_manager,
        system_prompt=system_prompt,
        max_iterations=config.get("agent", {}).get("max_iterations", 50),
    )

    # REPL循环
    print("\n输入 'quit' 或 'exit' 退出")
    print("-" * 60)

    while True:
        try:
            user_input = input("\n>> ").strip()

            if not user_input:
                continue

            if user_input.lower() in ['quit', 'exit']:
                print("再见！")
                break

            # 运行agent
            response = agent.run(user_input)
            print(f"\n{response}")

        except KeyboardInterrupt:
            print("\n\n再见！")
            break
        except Exception as e:
            logger.error(f"错误: {e}")
            print(f"\n错误: {e}")


if __name__ == "__main__":
    main()
