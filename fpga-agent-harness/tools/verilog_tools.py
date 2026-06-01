"""
Verilog专用工具
"""

import re
from pathlib import Path
from .base import BaseTool
from core.tool_dispatch import Tool


class VerilogTools(BaseTool):
    """Verilog/SV专用工具"""

    def get_tools(self) -> list[Tool]:
        return [
            Tool(
                name="analyze_verilog",
                description="分析Verilog/SV文件结构",
                handler=self.analyze_verilog,
                parameters={
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Verilog文件路径"},
                    },
                    "required": ["path"],
                },
                category="verilog",
            ),
            Tool(
                name="check_verilog_syntax",
                description="检查Verilog语法",
                handler=self.check_verilog_syntax,
                parameters={
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Verilog文件路径"},
                    },
                    "required": ["path"],
                },
                category="verilog",
            ),
            Tool(
                name="list_modules",
                description="列出Verilog文件中的模块",
                handler=self.list_modules,
                parameters={
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Verilog文件路径"},
                    },
                    "required": ["path"],
                },
                category="verilog",
            ),
        ]

    def analyze_verilog(self, path: str) -> str:
        """分析Verilog文件"""
        try:
            safe_path = self._safe_path(path)
            content = Path(safe_path).read_text(encoding="utf-8")

            # 提取模块信息
            modules = re.findall(
                r'module\s+(\w+)\s*(?:#\s*\(.*?\))?\s*\(.*?\);',
                content,
                re.DOTALL
            )

            # 提取端口信息
            ports = re.findall(
                r'(input|output|inout)\s+(?:reg|wire)?\s*(?:\[.*?\])?\s*(\w+)',
                content
            )

            # 提取参数
            params = re.findall(
                r'parameter\s+(\w+)\s*=\s*(.*?)(?:,|;)',
                content
            )

            lines = [f"文件: {path}"]
            lines.append(f"模块: {', '.join(modules) if modules else '未找到'}")
            lines.append(f"端口数: {len(ports)}")

            if ports:
                lines.append("端口列表:")
                for direction, name in ports[:20]:
                    lines.append(f"  - {direction} {name}")

            if params:
                lines.append(f"参数: {len(params)}")
                for name, value in params[:10]:
                    lines.append(f"  - {name} = {value}")

            return "\n".join(lines)

        except Exception as e:
            return f"Error: {e}"

    def check_verilog_syntax(self, path: str) -> str:
        """检查Verilog语法（基础检查）"""
        try:
            safe_path = self._safe_path(path)
            content = Path(safe_path).read_text(encoding="utf-8")

            issues = []

            # 检查基本语法问题
            if 'module' not in content:
                issues.append("缺少module定义")

            if 'endmodule' not in content:
                issues.append("缺少endmodule")

            # 检查begin/end配对
            begin_count = content.count('begin')
            end_count = content.count('end')
            if begin_count != end_count:
                issues.append(f"begin/end不匹配: {begin_count} vs {end_count}")

            # 检查括号配对
            open_parens = content.count('(')
            close_parens = content.count(')')
            if open_parens != close_parens:
                issues.append(f"括号不匹配: {open_parens} vs {close_parens}")

            if not issues:
                return "语法检查通过（基础检查）"

            return "发现问题:\n" + "\n".join(f"  - {i}" for i in issues)

        except Exception as e:
            return f"Error: {e}"

    def list_modules(self, path: str) -> str:
        """列出模块"""
        try:
            safe_path = self._safe_path(path)
            content = Path(safe_path).read_text(encoding="utf-8")

            # 匹配module定义
            pattern = r'module\s+(\w+)\s*(?:#\s*\((.*?)\))?\s*\((.*?)\);'
            matches = re.findall(pattern, content, re.DOTALL)

            if not matches:
                return "未找到模块定义"

            lines = []
            for name, params, ports in matches:
                lines.append(f"模块: {name}")

                if params.strip():
                    lines.append(f"  参数: {params.strip()[:100]}...")

                # 简化端口显示
                port_list = [p.strip() for p in ports.split(',') if p.strip()]
                lines.append(f"  端口数: {len(port_list)}")

            return "\n".join(lines)

        except Exception as e:
            return f"Error: {e}"
