"""
记忆系统

来自learn-claude-code s09: 记住重要的，忘记不重要的
"""

import json
import logging
from pathlib import Path
from typing import Optional
from dataclasses import dataclass, field
from datetime import datetime

logger = logging.getLogger(__name__)


@dataclass
class MemoryEntry:
    """记忆条目"""
    key: str
    content: str
    category: str = "general"
    created_at: str = ""
    access_count: int = 0
    metadata: dict = field(default_factory=dict)


class MemorySystem:
    """
    记忆系统

    来自s09的设计:
    - 三个子系统：选择、提取、巩固
    - 记住重要的，忘记不重要的
    """

    def __init__(self, memory_dir: str = ".memory"):
        self.memory_dir = Path(memory_dir)
        self.memory_dir.mkdir(parents=True, exist_ok=True)
        self.memories: dict[str, MemoryEntry] = {}
        self._load_memories()

    def _load_memories(self) -> None:
        """加载记忆"""
        for path in self.memory_dir.glob("*.json"):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                entry = MemoryEntry(**data)
                self.memories[entry.key] = entry
            except Exception as e:
                logger.error(f"加载记忆失败 {path}: {e}")

    def _save_memory(self, entry: MemoryEntry) -> None:
        """保存记忆"""
        path = self.memory_dir / f"{entry.key}.json"
        path.write_text(
            json.dumps({
                "key": entry.key,
                "content": entry.content,
                "category": entry.category,
                "created_at": entry.created_at,
                "access_count": entry.access_count,
                "metadata": entry.metadata,
            }, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )

    def remember(self, key: str, content: str, category: str = "general") -> None:
        """
        记住信息

        Args:
            key: 记忆键
            content: 记忆内容
            category: 类别
        """
        entry = MemoryEntry(
            key=key,
            content=content,
            category=category,
            created_at=datetime.now().isoformat(),
        )
        self.memories[key] = entry
        self._save_memory(entry)
        logger.debug(f"记住: {key}")

    def recall(self, key: str) -> Optional[str]:
        """
        回忆信息

        Args:
            key: 记忆键

        Returns:
            Optional[str]: 记忆内容
        """
        entry = self.memories.get(key)
        if entry:
            entry.access_count += 1
            self._save_memory(entry)
            return entry.content
        return None

    def forget(self, key: str) -> bool:
        """忘记信息"""
        if key in self.memories:
            del self.memories[key]
            path = self.memory_dir / f"{key}.json"
            if path.exists():
                path.unlink()
            return True
        return False

    def search(self, query: str, category: str = None) -> list[MemoryEntry]:
        """
        搜索记忆

        Args:
            query: 搜索关键词
            category: 类别过滤

        Returns:
            list[MemoryEntry]: 匹配的记忆
        """
        results = []
        query_lower = query.lower()

        for entry in self.memories.values():
            if category and entry.category != category:
                continue

            if (query_lower in entry.key.lower() or
                query_lower in entry.content.lower()):
                results.append(entry)

        # 按访问次数排序
        results.sort(key=lambda e: e.access_count, reverse=True)
        return results

    def list_categories(self) -> list[str]:
        """列出所有类别"""
        categories = set()
        for entry in self.memories.values():
            categories.add(entry.category)
        return sorted(categories)

    def get_stats(self) -> dict:
        """获取统计信息"""
        return {
            "total_memories": len(self.memories),
            "categories": len(self.list_categories()),
            "total_accesses": sum(e.access_count for e in self.memories.values()),
        }
