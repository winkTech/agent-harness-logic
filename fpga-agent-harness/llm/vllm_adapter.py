"""
vLLM适配层 - 统一LLM调用接口

适配learn-claude-code的Anthropic API调用模式到vLLM的OpenAI兼容API
"""

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Optional

from openai import OpenAI

logger = logging.getLogger(__name__)


@dataclass
class ToolCall:
    """工具调用"""
    id: str
    name: str
    arguments: dict


@dataclass
class LLMResponse:
    """统一的LLM响应格式"""
    content: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    finish_reason: str = "stop"
    usage: dict = field(default_factory=dict)

    @property
    def has_tool_calls(self) -> bool:
        return len(self.tool_calls) > 0


class VLLMAdapter:
    """
    vLLM适配器

    将learn-claude-code的Anthropic API调用模式转换为vLLM的OpenAI兼容API
    """

    def __init__(
        self,
        base_url: str = "http://localhost:8000/v1",
        model: str = "default",
        api_key: str = "EMPTY",
        max_tokens: int = 4096,
        temperature: float = 0.1,
    ):
        self.client = OpenAI(
            base_url=base_url,
            api_key=api_key,
        )
        self.model = model
        self.max_tokens = max_tokens
        self.temperature = temperature

    def chat(
        self,
        messages: list[dict],
        tools: Optional[list[dict]] = None,
        system: Optional[str] = None,
        **kwargs,
    ) -> LLMResponse:
        """
        聊天调用

        Args:
            messages: 消息列表
            tools: 工具定义列表
            system: system prompt
            **kwargs: 其他参数

        Returns:
            LLMResponse: 统一响应格式
        """
        # 构建消息
        full_messages = []
        if system:
            full_messages.append({"role": "system", "content": system})
        full_messages.extend(messages)

        # 构建工具定义（OpenAI格式）
        openai_tools = None
        if tools:
            openai_tools = [self._convert_tool_to_openai(t) for t in tools]

        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=full_messages,
                tools=openai_tools,
                max_tokens=kwargs.get("max_tokens", self.max_tokens),
                temperature=kwargs.get("temperature", self.temperature),
            )

            choice = response.choices[0]
            message = choice.message

            # 解析工具调用
            tool_calls = []
            if message.tool_calls:
                for tc in message.tool_calls:
                    try:
                        arguments = json.loads(tc.function.arguments)
                    except json.JSONDecodeError:
                        arguments = {"raw": tc.function.arguments}

                    tool_calls.append(ToolCall(
                        id=tc.id,
                        name=tc.function.name,
                        arguments=arguments,
                    ))

            return LLMResponse(
                content=message.content or "",
                tool_calls=tool_calls,
                finish_reason=choice.finish_reason,
                usage={
                    "prompt_tokens": response.usage.prompt_tokens,
                    "completion_tokens": response.usage.completion_tokens,
                    "total_tokens": response.usage.total_tokens,
                },
            )

        except Exception as e:
            logger.error(f"LLM调用失败: {e}")
            raise

    def _convert_tool_to_openai(self, tool: dict) -> dict:
        """
        将工具定义转换为OpenAI格式

        learn-claude-code格式:
        {
            "name": "bash",
            "description": "Run command.",
            "input_schema": {
                "type": "object",
                "properties": {"command": {"type": "string"}},
                "required": ["command"]
            }
        }

        OpenAI格式:
        {
            "type": "function",
            "function": {
                "name": "bash",
                "description": "Run command.",
                "parameters": {
                    "type": "object",
                    "properties": {"command": {"type": "string"}},
                    "required": ["command"]
                }
            }
        }
        """
        return {
            "type": "function",
            "function": {
                "name": tool["name"],
                "description": tool.get("description", ""),
                "parameters": tool.get("input_schema", tool.get("parameters", {})),
            }
        }
