"""
Shell工具
"""

import subprocess
from .base import BaseTool
from core.tool_dispatch import Tool


class ShellTools(BaseTool):
    """Shell命令工具"""

    DANGEROUS_COMMANDS = [
        "rm -rf /", "sudo", "shutdown", "reboot", "> /dev/",
        "mkfs", "dd if=", ":(){:|:&};:",
    ]

    def get_tools(self) -> list[Tool]:
        return [
            Tool(
                name="bash",
                description="执行Shell命令",
                handler=self.run_bash,
                parameters={
                    "type": "object",
                    "properties": {
                        "command": {"type": "string", "description": "要执行的命令"},
                        "timeout": {"type": "integer", "description": "超时时间（秒）"},
                    },
                    "required": ["command"],
                },
                category="shell",
            ),
        ]

    def run_bash(self, command: str, timeout: int = 120) -> str:
        """执行Shell命令"""
        # 检查危险命令
        for dangerous in self.DANGEROUS_COMMANDS:
            if dangerous in command:
                return f"Error: Dangerous command blocked: {dangerous}"

        try:
            result = subprocess.run(
                command,
                shell=True,
                cwd=self.workdir,
                capture_output=True,
                text=True,
                timeout=timeout,
            )

            output = (result.stdout + result.stderr).strip()
            return output[:50000] if output else "(no output)"

        except subprocess.TimeoutExpired:
            return f"Error: Timeout ({timeout}s)"
        except Exception as e:
            return f"Error: {e}"
