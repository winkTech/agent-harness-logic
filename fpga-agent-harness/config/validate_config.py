#!/usr/bin/env python3
"""配置验证脚本"""

import os
import sys
from pathlib import Path

import yaml


def validate_config():
    """验证配置文件"""
    config_path = Path(__file__).parent / "settings.yaml"

    if not config_path.exists():
        print("ERROR: settings.yaml not found")
        return False

    with open(config_path, 'r', encoding='utf-8') as f:
        config = yaml.safe_load(f)

    print("=== FPGA Agent Harness Configuration ===\n")

    # LLM 配置
    llm_config = config.get("llm", {})
    print("LLM Configuration:")
    print(f"  Base URL: {llm_config.get('base_url', 'NOT SET')}")
    print(f"  Model: {llm_config.get('model', 'NOT SET')}")

    api_key = llm_config.get("api_key", "")
    if api_key.startswith("${") and api_key.endswith("}"):
        env_var = api_key[2:-1]
        env_value = os.environ.get(env_var)
        if env_value:
            print(f"  API Key: {env_var} = {env_value[:10]}...")
        else:
            print(f"  API Key: {env_var} = NOT SET")
    else:
        print(f"  API Key: {'*' * 10 if api_key else 'NOT SET'}")

    print(f"  Max Tokens: {llm_config.get('max_tokens', 4096)}")
    print(f"  Temperature: {llm_config.get('temperature', 0.1)}")

    # Agent 配置
    agent_config = config.get("agent", {})
    print("\nAgent Configuration:")
    print(f"  Max Iterations: {agent_config.get('max_iterations', 50)}")
    print(f"  Token Threshold: {agent_config.get('token_threshold', 100000)}")

    # 工具配置
    tools_config = config.get("tools", {})
    print("\nTools Configuration:")
    print(f"  Workdir: {tools_config.get('workdir', '.')}")
    print(f"  Enabled: {', '.join(tools_config.get('enabled', []))}")

    # 技能配置
    skills_config = config.get("skills", {})
    print("\nSkills Configuration:")
    print(f"  Directory: {skills_config.get('directory', 'skills')}")

    # FPGA 配置
    fpga_config = config.get("fpga", {})
    print("\nFPGA Configuration:")
    print(f"  Vivado Path: {fpga_config.get('vivado', {}).get('path', 'System PATH')}")
    print(f"  ModelSim Path: {fpga_config.get('modelsim', {}).get('path', 'System PATH')}")
    print(f"  Default Part: {fpga_config.get('vivado', {}).get('default_part', 'NOT SET')}")

    # MATLAB 配置
    matlab_config = config.get("matlab", {})
    print("\nMATLAB Configuration:")
    print(f"  Path: {matlab_config.get('path', 'System PATH')}")

    # 用户偏好
    prefs_config = config.get("preferences", {})
    print("\nUser Preferences:")
    print(f"  Language: {prefs_config.get('language', 'en-US')}")
    print(f"  Encoding: {prefs_config.get('encoding', 'utf-8')}")
    print(f"  Line Ending: {prefs_config.get('line_ending', 'lf')}")

    print("\n=== Configuration Valid ===")
    return True


if __name__ == "__main__":
    # 尝试加载 .env 文件
    try:
        from dotenv import load_dotenv
        env_path = Path(__file__).parent / ".env"
        if env_path.exists():
            load_dotenv(env_path)
            print(f"Loaded .env from: {env_path}\n")
    except ImportError:
        pass

    success = validate_config()
    sys.exit(0 if success else 1)
