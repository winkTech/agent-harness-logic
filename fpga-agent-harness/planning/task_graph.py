"""
任务依赖图

来自learn-claude-code s12: 文件持久化任务图
"""

import json
import logging
import random
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class Task:
    """任务"""
    id: str
    subject: str
    description: str = ""
    status: str = "pending"  # pending, in_progress, completed, deleted
    owner: Optional[str] = None
    blocked_by: list[str] = field(default_factory=list)


class TaskGraph:
    """
    任务图管理器

    来自s12的设计:
    - 大目标分解为小任务
    - 任务有序、持久化到磁盘
    - 为多agent协作打基础
    """

    def __init__(self, tasks_dir: str = ".tasks"):
        self.tasks_dir = Path(tasks_dir)
        self.tasks_dir.mkdir(parents=True, exist_ok=True)

    def _task_path(self, task_id: str) -> Path:
        """获取任务文件路径"""
        return self.tasks_dir / f"{task_id}.json"

    def create(
        self,
        subject: str,
        description: str = "",
        blocked_by: list[str] = None,
    ) -> Task:
        """创建任务"""
        task_id = f"task_{int(time.time())}_{random.randint(0, 9999):04d}"
        task = Task(
            id=task_id,
            subject=subject,
            description=description,
            blocked_by=blocked_by or [],
        )
        self._save(task)
        return task

    def get(self, task_id: str) -> Optional[Task]:
        """获取任务"""
        path = self._task_path(task_id)
        if not path.exists():
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
        return Task(**data)

    def _save(self, task: Task) -> None:
        """保存任务"""
        path = self._task_path(task.id)
        path.write_text(json.dumps(asdict(task), indent=2), encoding="utf-8")

    def list_all(self) -> list[Task]:
        """列出所有任务"""
        tasks = []
        for path in sorted(self.tasks_dir.glob("task_*.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                tasks.append(Task(**data))
            except Exception as e:
                logger.error(f"读取任务失败 {path}: {e}")
        return tasks

    def can_start(self, task_id: str) -> bool:
        """检查任务是否可以开始"""
        task = self.get(task_id)
        if not task:
            return False

        for dep_id in task.blocked_by:
            dep = self.get(dep_id)
            if not dep or dep.status != "completed":
                return False

        return True

    def claim(self, task_id: str, owner: str = "agent") -> str:
        """认领任务"""
        task = self.get(task_id)
        if not task:
            return f"Task {task_id} not found"

        if task.status != "pending":
            return f"Task {task_id} is {task.status}, cannot claim"

        if task.owner:
            return f"Task {task_id} already owned by {task.owner}"

        if not self.can_start(task_id):
            blocking = [
                dep_id for dep_id in task.blocked_by
                if (dep := self.get(dep_id)) and dep.status != "completed"
            ]
            return f"Cannot start — blocked by: {blocking}"

        task.owner = owner
        task.status = "in_progress"
        self._save(task)
        return f"Claimed {task.id} ({task.subject})"

    def complete(self, task_id: str) -> str:
        """完成任务"""
        task = self.get(task_id)
        if not task:
            return f"Task {task_id} not found"

        if task.status != "in_progress":
            return f"Task {task_id} is {task.status}, cannot complete"

        task.status = "completed"
        self._save(task)

        # 检查解锁的任务
        unblocked = [
            t.subject for t in self.list_all()
            if t.status == "pending" and t.blocked_by and self.can_start(t.id)
        ]

        msg = f"Completed {task.id} ({task.subject})"
        if unblocked:
            msg += f"\nUnblocked: {', '.join(unblocked)}"

        return msg

    def delete(self, task_id: str) -> str:
        """删除任务"""
        path = self._task_path(task_id)
        if path.exists():
            path.unlink()
            return f"Deleted {task_id}"
        return f"Task {task_id} not found"

    def render(self) -> str:
        """渲染任务列表"""
        tasks = self.list_all()
        if not tasks:
            return "No tasks."

        lines = []
        for task in tasks:
            status_mark = {
                "pending": "[ ]",
                "in_progress": "[>]",
                "completed": "[x]",
            }.get(task.status, "[?]")

            owner = f" @{task.owner}" if task.owner else ""
            blocked = f" (blocked by: {task.blocked_by})" if task.blocked_by else ""
            lines.append(f"{status_mark} #{task.id}: {task.subject}{owner}{blocked}")

        return "\n".join(lines)
