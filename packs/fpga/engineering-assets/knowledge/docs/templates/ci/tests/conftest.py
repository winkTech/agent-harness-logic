# pytest 配置文件
# 共享的 fixtures 和配置

import pytest
import subprocess
import sys
from pathlib import Path


@pytest.fixture(scope="session")
def project_root():
    """返回项目根目录"""
    return Path(__file__).parent.parent


@pytest.fixture(scope="session")
def check工具可用性():
    """检查开发工具是否可用"""
    tools = {
        'iverilog': 'iverilog -V 2>/dev/null | head -1',
        'python': 'python --version',
        'ruff': 'ruff --version',
    }

    available = {}
    for tool, cmd in tools.items():
        try:
            result = subprocess.run(
                cmd, shell=True, capture_output=True, text=True, timeout=5
            )
            available[tool] = result.returncode == 0
        except (subprocess.TimeoutExpired, FileNotFoundError):
            available[tool] = False

    return available


@pytest.fixture
def skip_if_no_tool():
    """根据工具可用性跳过测试"""
    def _skip(tool_name, tools_status):
        if not tools_status.get(tool_name, False):
            pytest.skip(f"{tool_name} 不可用")
    return _skip
