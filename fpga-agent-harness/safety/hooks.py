"""
钩子系统

来自learn-claude-code s04: PreToolUse/PostToolUse 扩展点
"""

import logging
from enum import Enum
from typing import Any, Callable, Optional
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


class HookType(Enum):
    """钩子类型"""
    PRE_TOOL_USE = "pre_tool_use"
    POST_TOOL_USE = "post_tool_use"
    PRE_LLM_CALL = "pre_llm_call"
    POST_LLM_CALL = "post_llm_call"
    ON_ERROR = "on_error"


@dataclass
class Hook:
    """钩子定义"""
    name: str
    hook_type: HookType
    handler: Callable
    priority: int = 0  # 优先级，数字越小越先执行


@dataclass
class HookResult:
    """钩子执行结果"""
    blocked: bool = False
    reason: str = ""
    modified_args: Optional[dict] = None


class HookManager:
    """
    钩子管理器

    来自s04的设计:
    - 钩子围绕循环，不重写循环
    - 支持多个钩子，按优先级执行
    - 钩子可以阻止操作或修改参数
    """

    def __init__(self):
        self._hooks: dict[HookType, list[Hook]] = {
            hook_type: [] for hook_type in HookType
        }

    def register(self, hook: Hook) -> None:
        """注册钩子"""
        self._hooks[hook.hook_type].append(hook)
        # 按优先级排序
        self._hooks[hook.hook_type].sort(key=lambda h: h.priority)
        logger.debug(f"注册钩子: {hook.name} ({hook.hook_type.value})")

    def register_function(
        self,
        name: str,
        hook_type: HookType,
        handler: Callable,
        priority: int = 0,
    ) -> None:
        """注册函数为钩子"""
        self.register(Hook(
            name=name,
            hook_type=hook_type,
            handler=handler,
            priority=priority,
        ))

    def trigger_pre_tool_use(self, tool_name: str, arguments: dict) -> Optional[HookResult]:
        """
        触发PreToolUse钩子

        Args:
            tool_name: 工具名称
            arguments: 工具参数

        Returns:
            Optional[HookResult]: 如果被阻止，返回HookResult
        """
        for hook in self._hooks[HookType.PRE_TOOL_USE]:
            try:
                result = hook.handler(tool_name, arguments)
                if isinstance(result, HookResult) and result.blocked:
                    logger.info(f"钩子 {hook.name} 阻止了工具 {tool_name}")
                    return result
            except Exception as e:
                logger.error(f"钩子 {hook.name} 执行失败: {e}")

        return None

    def trigger_post_tool_use(
        self,
        tool_name: str,
        arguments: dict,
        result: str,
    ) -> None:
        """
        触发PostToolUse钩子

        Args:
            tool_name: 工具名称
            arguments: 工具参数
            result: 工具执行结果
        """
        for hook in self._hooks[HookType.POST_TOOL_USE]:
            try:
                hook.handler(tool_name, arguments, result)
            except Exception as e:
                logger.error(f"钩子 {hook.name} 执行失败: {e}")

    def trigger_pre_llm_call(self, messages: list) -> Optional[list]:
        """
        触发PreLLMCall钩子

        Args:
            messages: 消息列表

        Returns:
            Optional[list]: 如果修改了消息，返回修改后的消息
        """
        modified = messages
        for hook in self._hooks[HookType.PRE_LLM_CALL]:
            try:
                result = hook.handler(modified)
                if result is not None:
                    modified = result
            except Exception as e:
                logger.error(f"钩子 {hook.name} 执行失败: {e}")

        return modified if modified != messages else None

    def trigger_on_error(self, error: Exception, context: dict) -> Optional[str]:
        """
        触发OnError钩子

        Args:
            error: 异常
            context: 上下文

        Returns:
            Optional[str]: 如果提供了恢复方案，返回恢复方案
        """
        for hook in self._hooks[HookType.ON_ERROR]:
            try:
                result = hook.handler(error, context)
                if result:
                    return result
            except Exception as e:
                logger.error(f"钩子 {hook.name} 执行失败: {e}")

        return None
