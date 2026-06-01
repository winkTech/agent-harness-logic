"""
子Agent系统

来自learn-claude-code s06: 任务分解，上下文隔离
"""

import logging
from typing import Optional
from llm import VLLMAdapter
from core.tool_dispatch import ToolDispatcher

logger = logging.getLogger(__name__)


class SubagentRunner:
    """
    子Agent运行器

    来自s06的设计:
    - 大任务拆小，每个子任务获得干净上下文
    - 子agent做侧边工作，只带结果回来
    """

    def __init__(self, llm: VLLMAdapter, max_iterations: int = 30):
        self.llm = llm
        self.max_iterations = max_iterations

    def run(
        self,
        prompt: str,
        tools: list[dict] = None,
        system: str = "",
        max_tokens: int = 8000,
    ) -> str:
        """
        运行子agent

        Args:
            prompt: 任务提示
            tools: 工具定义列表
            system: system prompt
            max_tokens: 最大token数

        Returns:
            str: 子agent的最终响应
        """
        # 创建独立的工具分发器
        dispatcher = ToolDispatcher()
        if tools:
            for tool_def in tools:
                dispatcher.register_function(
                    name=tool_def["name"],
                    handler=self._create_echo_handler(tool_def["name"]),
                    description=tool_def.get("description", ""),
                    parameters=tool_def.get("parameters", {}),
                )

        # 独立的消息历史
        messages = [{"role": "user", "content": prompt}]

        for _ in range(self.max_iterations):
            response = self.llm.chat(
                messages=messages,
                tools=tools,
                system=system,
                max_tokens=max_tokens,
            )

            messages.append({
                "role": "assistant",
                "content": response.content,
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.name,
                            "arguments": str(tc.arguments),
                        }
                    }
                    for tc in response.tool_calls
                ] if response.tool_calls else None,
            })

            # 如果没有工具调用，返回文本
            if not response.has_tool_calls:
                return response.content

            # 执行工具调用
            tool_results = []
            for tc in response.tool_calls:
                output = dispatcher.dispatch(tc.name, tc.arguments)
                tool_results.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": str(output)[:50000],
                })

            messages.extend(tool_results)

        return "(子agent达到最大迭代次数)"

    def _create_echo_handler(self, tool_name: str):
        """创建回显处理器（用于演示）"""
        def handler(**kwargs):
            return f"[Subagent] {tool_name} called with: {kwargs}"
        return handler
