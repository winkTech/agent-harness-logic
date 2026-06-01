"""
技能加载系统

来自learn-claude-code s07: 按需加载知识
"""

import logging
import re
from pathlib import Path
from typing import Optional
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class Skill:
    """技能定义"""
    name: str
    description: str
    content: str
    metadata: dict = field(default_factory=dict)


class SkillLoader:
    """
    技能加载器

    来自s07的设计:
    - 先列出技能，再按需展开
    - 知识按需加载，不预先塞入
    """

    def __init__(self, skills_dir: str = "skills"):
        self.skills_dir = Path(skills_dir)
        self.skills: dict[str, Skill] = {}
        self._load_skills()

    def _load_skills(self) -> None:
        """加载所有技能"""
        if not self.skills_dir.exists():
            logger.warning(f"技能目录不存在: {self.skills_dir}")
            return

        for skill_file in sorted(self.skills_dir.rglob("SKILL.md")):
            try:
                self._parse_skill(skill_file)
            except Exception as e:
                logger.error(f"解析技能失败 {skill_file}: {e}")

    def _parse_skill(self, path: Path) -> None:
        """解析技能文件"""
        text = path.read_text(encoding="utf-8")

        # 解析YAML frontmatter
        match = re.match(r"^---\n(.*?)\n---\n(.*)", text, re.DOTALL)
        if not match:
            # 没有frontmatter，使用文件名作为技能名
            name = path.parent.name
            self.skills[name] = Skill(
                name=name,
                description="",
                content=text,
            )
            return

        # 解析metadata
        metadata = {}
        for line in match.group(1).strip().splitlines():
            if ":" in line:
                key, value = line.split(":", 1)
                metadata[key.strip()] = value.strip()

        name = metadata.get("name", path.parent.name)
        description = metadata.get("description", "")
        content = match.group(2).strip()

        self.skills[name] = Skill(
            name=name,
            description=description,
            content=content,
            metadata=metadata,
        )

    def list_skills(self) -> str:
        """列出所有技能"""
        if not self.skills:
            return "(no skills)"

        lines = []
        for name, skill in self.skills.items():
            lines.append(f"  - {name}: {skill.description}")

        return "\n".join(lines)

    def load(self, name: str) -> str:
        """
        加载技能内容

        Args:
            name: 技能名称

        Returns:
            str: 技能内容
        """
        skill = self.skills.get(name)
        if not skill:
            available = ", ".join(self.skills.keys())
            return f"Error: Unknown skill '{name}'. Available: {available}"

        return f'<skill name="{name}">\n{skill.content}\n</skill>'

    def get_skill(self, name: str) -> Optional[Skill]:
        """获取技能对象"""
        return self.skills.get(name)

    def has_skill(self, name: str) -> bool:
        """检查技能是否存在"""
        return name in self.skills

    def reload(self) -> None:
        """重新加载技能"""
        self.skills.clear()
        self._load_skills()
