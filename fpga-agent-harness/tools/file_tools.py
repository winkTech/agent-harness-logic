"""
文件工具
"""

import os
from pathlib import Path
from .base import BaseTool
from core.tool_dispatch import Tool


class FileTools(BaseTool):
    """文件读写工具"""

    def get_tools(self) -> list[Tool]:
        return [
            Tool(
                name="read_file",
                description="读取文件内容",
                handler=self.read_file,
                parameters={
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "文件路径"},
                        "limit": {"type": "integer", "description": "读取行数限制"},
                    },
                    "required": ["path"],
                },
                category="file",
            ),
            Tool(
                name="write_file",
                description="写入文件内容",
                handler=self.write_file,
                parameters={
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "文件路径"},
                        "content": {"type": "string", "description": "文件内容"},
                    },
                    "required": ["path", "content"],
                },
                category="file",
            ),
            Tool(
                name="edit_file",
                description="编辑文件（替换文本）",
                handler=self.edit_file,
                parameters={
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "文件路径"},
                        "old_text": {"type": "string", "description": "要替换的文本"},
                        "new_text": {"type": "string", "description": "新文本"},
                    },
                    "required": ["path", "old_text", "new_text"],
                },
                category="file",
            ),
            Tool(
                name="list_files",
                description="列出目录文件",
                handler=self.list_files,
                parameters={
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "目录路径"},
                        "pattern": {"type": "string", "description": "文件模式"},
                    },
                },
                category="file",
            ),
        ]

    def read_file(self, path: str, limit: int = None) -> str:
        """读取文件"""
        try:
            safe_path = self._safe_path(path)
            lines = Path(safe_path).read_text(encoding="utf-8").splitlines()

            if limit and limit < len(lines):
                lines = lines[:limit] + [f"... ({len(lines) - limit} more lines)"]

            return "\n".join(lines)[:50000]
        except Exception as e:
            return f"Error: {e}"

    def write_file(self, path: str, content: str) -> str:
        """写入文件"""
        try:
            safe_path = self._safe_path(path)
            Path(safe_path).parent.mkdir(parents=True, exist_ok=True)
            Path(safe_path).write_text(content, encoding="utf-8")
            return f"Wrote {len(content)} bytes to {path}"
        except Exception as e:
            return f"Error: {e}"

    def edit_file(self, path: str, old_text: str, new_text: str) -> str:
        """编辑文件"""
        try:
            safe_path = self._safe_path(path)
            content = Path(safe_path).read_text(encoding="utf-8")

            if old_text not in content:
                return f"Error: Text not found in {path}"

            new_content = content.replace(old_text, new_text, 1)
            Path(safe_path).write_text(new_content, encoding="utf-8")
            return f"Edited {path}"
        except Exception as e:
            return f"Error: {e}"

    def list_files(self, path: str = ".", pattern: str = "*") -> str:
        """列出文件"""
        try:
            safe_path = self._safe_path(path)
            files = sorted(Path(safe_path).glob(pattern))

            if not files:
                return f"No files matching '{pattern}' in {path}"

            lines = []
            for f in files[:100]:  # 限制输出
                size = f.stat().st_size if f.is_file() else 0
                type_mark = "[D]" if f.is_dir() else "[F]"
                lines.append(f"{type_mark} {f.name} ({size} bytes)")

            if len(files) > 100:
                lines.append(f"... and {len(files) - 100} more")

            return "\n".join(lines)
        except Exception as e:
            return f"Error: {e}"
