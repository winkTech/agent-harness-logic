"""
MATLAB专用工具
"""

import re
from pathlib import Path
from .base import BaseTool
from core.tool_dispatch import Tool


class MatlabTools(BaseTool):
    """MATLAB专用工具"""

    def get_tools(self) -> list[Tool]:
        return [
            Tool(
                name="analyze_matlab",
                description="分析MATLAB文件结构",
                handler=self.analyze_matlab,
                parameters={
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "MATLAB文件路径"},
                    },
                    "required": ["path"],
                },
                category="matlab",
            ),
            Tool(
                name="list_matlab_functions",
                description="列出MATLAB文件中的函数",
                handler=self.list_matlab_functions,
                parameters={
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "MATLAB文件路径"},
                    },
                    "required": ["path"],
                },
                category="matlab",
            ),
            Tool(
                name="check_matlab_syntax",
                description="检查MATLAB语法",
                handler=self.check_matlab_syntax,
                parameters={
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "MATLAB文件路径"},
                    },
                    "required": ["path"],
                },
                category="matlab",
            ),
        ]

    def analyze_matlab(self, path: str) -> str:
        """分析MATLAB文件"""
        try:
            safe_path = self._safe_path(path)
            content = Path(safe_path).read_text(encoding="utf-8")

            # 提取函数定义
            functions = re.findall(
                r'function\s+(?:\[.*?\]\s*=\s*|(\w+)\s*=\s*)?(\w+)\s*\((.*?)\)',
                content
            )

            # 提取类定义
            classes = re.findall(
                r'classdef\s+(\w+)',
                content
            )

            # 提取注释
            comments = re.findall(r'%(.+)', content)

            lines = [f"文件: {path}"]

            if classes:
                lines.append(f"类: {', '.join(classes)}")

            if functions:
                lines.append(f"函数: {len(functions)}")
                for _, name, args in functions[:10]:
                    lines.append(f"  - {name}({args})")

            lines.append(f"注释行数: {len(comments)}")

            return "\n".join(lines)

        except Exception as e:
            return f"Error: {e}"

    def list_matlab_functions(self, path: str) -> str:
        """列出MATLAB函数"""
        try:
            safe_path = self._safe_path(path)
            content = Path(safe_path).read_text(encoding="utf-8")

            # 匹配函数定义
            pattern = r'function\s+(?:\[.*?\]\s*=\s*|(\w+)\s*=\s*)?(\w+)\s*\((.*?)\)'
            matches = re.findall(pattern, content)

            if not matches:
                return "未找到函数定义"

            lines = []
            for output, name, args in matches:
                args_list = [a.strip() for a in args.split(',') if a.strip()]
                lines.append(f"函数: {name}")
                lines.append(f"  输入参数: {', '.join(args_list) if args_list else '无'}")
                if output:
                    lines.append(f"  输出参数: {output}")

            return "\n".join(lines)

        except Exception as e:
            return f"Error: {e}"

    def check_matlab_syntax(self, path: str) -> str:
        """检查MATLAB语法（基础检查）"""
        try:
            safe_path = self._safe_path(path)
            content = Path(safe_path).read_text(encoding="utf-8")

            issues = []

            # 检查基本语法问题
            lines = content.split('\n')
            for i, line in enumerate(lines, 1):
                stripped = line.strip()

                # 检查end配对
                if stripped.startswith('function') and 'end' not in content:
                    issues.append(f"第{i}行: 函数可能缺少end")

                # 检查括号配对
                open_parens = stripped.count('(')
                close_parens = stripped.count(')')
                if open_parens != close_parens:
                    issues.append(f"第{i}行: 括号不匹配")

            if not issues:
                return "语法检查通过（基础检查）"

            return "发现问题:\n" + "\n".join(f"  - {i}" for i in issues[:20])

        except Exception as e:
            return f"Error: {e}"
