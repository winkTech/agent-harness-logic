"""
消息格式定义

统一的消息格式，适配不同LLM的API格式
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class MessageRole(Enum):
    """消息角色"""
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"


@dataclass
class ToolCallPart:
    """工具调用部分"""
    id: str
    name: str
    arguments: dict


@dataclass
class ToolResultPart:
    """工具结果部分"""
    tool_call_id: str
    content: str
    is_error: bool = False


@dataclass
class Message:
    """统一消息格式"""
    role: MessageRole
    content: str = ""
    tool_calls: list[ToolCallPart] = field(default_factory=list)
    tool_results: list[ToolResultPart] = field(default_factory=list)

    def to_dict(self) -> dict:
        """转换为API调用格式"""
        if self.role == MessageRole.TOOL:
            # 工具结果消息
            return {
                "role": "tool",
                "content": self.content,
                "tool_call_id": self.tool_results[0].tool_call_id if self.tool_results else "",
            }

        msg = {"role": self.role.value, "content": self.content}

        if self.tool_calls:
            msg["tool_calls"] = [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.name,
                        "arguments": str(tc.arguments),
                    }
                }
                for tc in self.tool_calls
            ]

        return msg

    @classmethod
    def user(cls, content: str) -> "Message":
        """创建用户消息"""
        return cls(role=MessageRole.USER, content=content)

    @classmethod
    def assistant(cls, content: str = "", tool_calls: list[ToolCallPart] = None) -> "Message":
        """创建助手消息"""
        return cls(role=MessageRole.ASSISTANT, content=content, tool_calls=tool_calls or [])

    @classmethod
    def tool_result(cls, tool_call_id: str, content: str, is_error: bool = False) -> "Message":
        """创建工具结果消息"""
        return cls(
            role=MessageRole.TOOL,
            content=content,
            tool_results=[ToolResultPart(
                tool_call_id=tool_call_id,
                content=content,
                is_error=is_error,
            )]
        )
