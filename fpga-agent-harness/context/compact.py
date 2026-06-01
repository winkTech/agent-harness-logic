"""
上下文压缩

来自learn-claude-code s08: 多层压缩策略
"""

import json
import logging
from typing import Optional
from llm import VLLMAdapter

logger = logging.getLogger(__name__)


class ContextCompactor:
    """
    上下文压缩器

    来自s08的设计:
    - 上下文总会满，必须有办法腾出空间
    - 多层压缩策略：microCompact / autoCompact
    """

    def __init__(
        self,
        llm: VLLMAdapter,
        token_threshold: int = 100000,
        keep_recent_results: int = 3,
    ):
        self.llm = llm
        self.token_threshold = token_threshold
        self.keep_recent_results = keep_recent_results

    def estimate_tokens(self, messages: list) -> int:
        """估算token数"""
        return len(json.dumps(messages, default=str)) // 4

    def microcompact(self, messages: list) -> None:
        """
        微压缩：清除旧的工具结果

        来自s08的设计：只保留最近N个工具结果
        """
        tool_result_indices = []

        for i, msg in enumerate(messages):
            if msg.get("role") == "user" and isinstance(msg.get("content"), list):
                for part in msg["content"]:
                    if isinstance(part, dict) and part.get("type") == "tool_result":
                        tool_result_indices.append((i, part))

            # 也处理字典格式的消息
            elif isinstance(msg, dict) and msg.get("role") == "tool":
                tool_result_indices.append((i, msg))

        # 保留最近的N个，清除其他的
        if len(tool_result_indices) <= self.keep_recent_results:
            return

        for idx, part in tool_result_indices[:-self.keep_recent_results]:
            if isinstance(part.get("content"), str) and len(part["content"]) > 100:
                part["content"] = "[cleared]"

    def auto_compact(self, messages: list, system: str = "") -> list:
        """
        自动压缩：总结历史，保留连续性

        来自s08的设计：用LLM总结对话历史
        """
        if self.estimate_tokens(messages) < self.token_threshold:
            return messages

        logger.info("触发自动压缩")

        # 取最后部分对话进行总结
        recent_text = json.dumps(messages[-20:], default=str)
        if len(recent_text) > 80000:
            recent_text = recent_text[-80000:]

        try:
            response = self.llm.chat(
                messages=[{
                    "role": "user",
                    "content": f"请总结以下对话的要点，保持连续性：\n{recent_text}"
                }],
                system="你是一个对话总结助手，请简洁地总结对话要点。",
                max_tokens=2000,
            )

            summary = response.content

            # 返回压缩后的消息
            return [
                {
                    "role": "user",
                    "content": f"[对话已压缩]\n{summary}"
                }
            ]

        except Exception as e:
            logger.error(f"自动压缩失败: {e}")
            # 压缩失败，返回截断的消息
            return messages[-10:]

    def should_compact(self, messages: list) -> bool:
        """检查是否需要压缩"""
        return self.estimate_tokens(messages) > self.token_threshold
