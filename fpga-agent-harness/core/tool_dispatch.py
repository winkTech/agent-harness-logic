"""
工具分发系统

来自learn-claude-code s02: 一个handler = 一个工具
"""

import logging
from typing import Any, Callable, Optional
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class Tool:
    """工具定义"""
    name: str
    description: str
    handler: Callable
    parameters: dict = field(default_factory=dict)
    category: str = "general"


class ToolDispatcher:
    """
    工具分发器

    核心模式（来自s02）:
    TOOL_HANDLERS = {"bash": run_bash, "read": run_read, ...}
    output = TOOL_HANDLERS[name](**input)
    """

    def __init__(self):
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        """注册工具"""
        self._tools[tool.name] = tool
        logger.debug(f"注册工具: {tool.name}")

    def register_function(
        self,
        name: str,
        handler: Callable,
        description: str = "",
        parameters: dict = None,
        category: str = "general",
    ) -> None:
        """注册函数为工具"""
        self.register(Tool(
            name=name,
            description=description,
            handler=handler,
            parameters=parameters or {},
            category=category,
        ))

    def dispatch(self, name: str, arguments: dict) -> str:
        """
        分发工具调用

        Args:
            name: 工具名称
            arguments: 工具参数

        Returns:
            str: 工具执行结果
        """
        tool = self._tools.get(name)
        if not tool:
            available = ", ".join(self._tools.keys())
            return f"Error: Unknown tool '{name}'. Available: {available}"

        try:
            result = tool.handler(**arguments)
            return str(result)[:50000]  # 限制输出长度
        except Exception as e:
            logger.error(f"工具 {name} 执行失败: {e}")
            return f"Error: {e}"

    def get_definitions(self) -> list[dict]:
        """获取所有工具定义（用于LLM调用）"""
        return [
            {
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
            }
            for tool in self._tools.values()
        ]

    def get_tools_by_category(self, category: str) -> list[Tool]:
        """按类别获取工具"""
        return [t for t in self._tools.values() if t.category == category]

    def has_tool(self, name: str) -> bool:
        """检查工具是否存在"""
        return name in self._tools
