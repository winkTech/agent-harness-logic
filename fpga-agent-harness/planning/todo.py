"""
待办管理

来自learn-claude-code s05: 先规划再执行
"""

import logging
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

logger = logging.getLogger(__name__)


class TodoStatus(Enum):
    """待办状态"""
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"


@dataclass
class TodoItem:
    """待办事项"""
    content: str
    status: TodoStatus = TodoStatus.PENDING
    active_form: str = ""


class TodoManager:
    """
    待办管理器

    来自s05的设计:
    - 先列出步骤，再执行
    - 完成率翻倍
    """

    def __init__(self):
        self.items: list[TodoItem] = []

    def update(self, items: list[dict]) -> str:
        """
        更新待办列表

        Args:
            items: 待办项列表，格式: [{"content": "...", "status": "...", "activeForm": "..."}]

        Returns:
            str: 渲染后的待办列表
        """
        validated = []
        in_progress_count = 0

        for i, item in enumerate(items):
            content = str(item.get("content", "")).strip()
            status_str = str(item.get("status", "pending")).lower()
            active_form = str(item.get("activeForm", "")).strip()

            if not content:
                raise ValueError(f"Item {i}: content required")

            try:
                status = TodoStatus(status_str)
            except ValueError:
                raise ValueError(f"Item {i}: invalid status '{status_str}'")

            if status == TodoStatus.IN_PROGRESS:
                in_progress_count += 1

            validated.append(TodoItem(
                content=content,
                status=status,
                active_form=active_form,
            ))

        if len(validated) > 20:
            raise ValueError("Max 20 todos")

        if in_progress_count > 1:
            raise ValueError("Only one in_progress allowed")

        self.items = validated
        return self.render()

    def render(self) -> str:
        """渲染待办列表"""
        if not self.items:
            return "No todos."

        lines = []
        for item in self.items:
            status_mark = {
                TodoStatus.COMPLETED: "[x]",
                TodoStatus.IN_PROGRESS: "[>]",
                TodoStatus.PENDING: "[ ]",
            }.get(item.status, "[?]")

            suffix = f" <- {item.active_form}" if item.status == TodoStatus.IN_PROGRESS else ""
            lines.append(f"{status_mark} {item.content}{suffix}")

        done = sum(1 for t in self.items if t.status == TodoStatus.COMPLETED)
        lines.append(f"\n({done}/{len(self.items)} completed)")

        return "\n".join(lines)

    def has_open_items(self) -> bool:
        """检查是否有未完成的项目"""
        return any(item.status != TodoStatus.COMPLETED for item in self.items)

    def get_in_progress(self) -> Optional[TodoItem]:
        """获取当前进行中的项目"""
        for item in self.items:
            if item.status == TodoStatus.IN_PROGRESS:
                return item
        return None

    def mark_completed(self, content: str) -> bool:
        """标记完成"""
        for item in self.items:
            if item.content == content:
                item.status = TodoStatus.COMPLETED
                return True
        return False

    def clear(self) -> None:
        """清空待办"""
        self.items = []
