"""
Agent循环

来自learn-claude-code s01: 核心循环模式

    User --> messages[] --> LLM --> response
                                    |
                          stop_reason == "tool_use"?
                         /                          \
                       yes                           no
                        |                             |
                  execute tools                    return text
                  append results
                  loop back -----------------> messages[]
"""

import logging
from typing import Optional

from llm import VLLMAdapter, LLMResponse
from safety import PermissionChecker, HookManager
from .message import Message, MessageRole, ToolCallPart
from .tool_dispatch import ToolDispatcher

logger = logging.getLogger(__name__)


class AgentLoop:
    """
    Agent核心循环

    来自learn-claude-code的核心设计:
    - 循环本身不变
    - 工具、知识、权限通过harness注入
    """

    def __init__(
        self,
        llm: VLLMAdapter,
        tool_dispatcher: ToolDispatcher,
        permission_checker: Optional[PermissionChecker] = None,
        hook_manager: Optional[HookManager] = None,
        system_prompt: str = "",
        max_iterations: int = 50,
    ):
        self.llm = llm
        self.tool_dispatcher = tool_dispatcher
        self.permission_checker = permission_checker or PermissionChecker()
        self.hook_manager = hook_manager or HookManager()
        self.system_prompt = system_prompt
        self.max_iterations = max_iterations
        self.messages: list[Message] = []

    def run(self, user_input: str) -> str:
        """
        运行agent循环

        Args:
            user_input: 用户输入

        Returns:
            str: 最终响应
        """
        # 添加用户消息
        self.messages.append(Message.user(user_input))

        for iteration in range(self.max_iterations):
            logger.debug(f"迭代 {iteration + 1}/{self.max_iterations}")

            # 调用LLM
            response = self._call_llm()

            # 解析响应
            assistant_msg = self._parse_response(response)
            self.messages.append(assistant_msg)

            # 如果没有工具调用，返回文本响应
            if not response.has_tool_calls:
                return response.content

            # 执行工具调用
            tool_results = self._execute_tool_calls(response.tool_calls)

            # 添加工具结果到消息历史
            for result in tool_results:
                self.messages.append(result)

        return "达到最大迭代次数限制"

    def _call_llm(self) -> LLMResponse:
        """调用LLM"""
        # 转换消息格式
        messages_dicts = [msg.to_dict() for msg in self.messages]

        # 获取工具定义
        tools = self.tool_dispatcher.get_definitions()

        return self.llm.chat(
            messages=messages_dicts,
            tools=tools,
            system=self.system_prompt,
        )

    def _parse_response(self, response: LLMResponse) -> Message:
        """解析LLM响应"""
        tool_calls = [
            ToolCallPart(id=tc.id, name=tc.name, arguments=tc.arguments)
            for tc in response.tool_calls
        ] if response.tool_calls else []

        return Message.assistant(
            content=response.content,
            tool_calls=tool_calls,
        )

    def _execute_tool_calls(self, tool_calls: list) -> list[Message]:
        """执行工具调用"""
        results = []

        for tc in tool_calls:
            # PreToolUse钩子
            hook_result = self.hook_manager.trigger_pre_tool_use(tc.name, tc.arguments)
            if hook_result and hook_result.get("blocked"):
                results.append(Message.tool_result(
                    tool_call_id=tc.id,
                    content=f"Blocked by hook: {hook_result.get('reason', 'unknown')}",
                    is_error=True,
                ))
                continue

            # 权限检查
            permission = self.permission_checker.check(tc.name, tc.arguments)
            if permission.denied:
                results.append(Message.tool_result(
                    tool_call_id=tc.id,
                    content=f"Permission denied: {permission.reason}",
                    is_error=True,
                ))
                continue

            # 执行工具
            output = self.tool_dispatcher.dispatch(tc.name, tc.arguments)

            # PostToolUse钩子
            self.hook_manager.trigger_post_tool_use(tc.name, tc.arguments, output)

            results.append(Message.tool_result(
                tool_call_id=tc.id,
                content=output,
                is_error=output.startswith("Error:"),
            ))

        return results

    def clear_history(self) -> None:
        """清空消息历史"""
        self.messages = []

    def get_history(self) -> list[Message]:
        """获取消息历史"""
        return self.messages.copy()
