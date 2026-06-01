"""
工具基类
"""

from abc import ABC, abstractmethod
from typing import Any
from core.tool_dispatch import Tool


class BaseTool(ABC):
    """工具基类"""

    def __init__(self, workdir: str = "."):
        self.workdir = workdir

    @abstractmethod
    def get_tools(self) -> list[Tool]:
        """获取工具定义列表"""
        pass

    def _safe_path(self, path: str) -> str:
        """安全路径检查"""
        import os
        from pathlib import Path

        full_path = Path(self.workdir) / path
        resolved = full_path.resolve()

        if not str(resolved).startswith(str(Path(self.workdir).resolve())):
            raise ValueError(f"Path escapes workspace: {path}")

        return str(resolved)
