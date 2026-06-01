"""
权限系统

来自learn-claude-code s03: 权限规则、审批流水线
"""

import logging
from dataclasses import dataclass
from typing import Optional
from enum import Enum

logger = logging.getLogger(__name__)


class PermissionAction(Enum):
    """权限动作"""
    ALLOW = "allow"
    DENY = "deny"
    ASK = "ask"


@dataclass
class PermissionResult:
    """权限检查结果"""
    denied: bool
    reason: str = ""
    action: PermissionAction = PermissionAction.ALLOW


@dataclass
class PermissionRule:
    """权限规则"""
    name: str
    tool_pattern: str  # 工具名模式，支持 * 通配符
    input_pattern: Optional[str] = None  # 输入模式
    action: PermissionAction = PermissionAction.ALLOW
    description: str = ""


class PermissionChecker:
    """
    权限检查器

    来自s03的设计:
    - 规则列表，按顺序匹配
    - 支持通配符
    - 默认允许，除非被明确拒绝
    """

    def __init__(self):
        self.rules: list[PermissionRule] = []
        self._setup_default_rules()

    def _setup_default_rules(self) -> None:
        """设置默认规则"""
        # 危险命令拒绝
        self.rules.append(PermissionRule(
            name="block_dangerous_commands",
            tool_pattern="bash",
            input_pattern="rm -rf /|sudo|shutdown|reboot",
            action=PermissionAction.DENY,
            description="阻止危险的shell命令",
        ))

        # 文件路径逃逸拒绝
        self.rules.append(PermissionRule(
            name="block_path_escape",
            tool_pattern="*",
            input_pattern="../",
            action=PermissionAction.DENY,
            description="阻止路径逃逸",
        ))

    def add_rule(self, rule: PermissionRule) -> None:
        """添加规则"""
        self.rules.append(rule)

    def check(self, tool_name: str, arguments: dict) -> PermissionResult:
        """
        检查权限

        Args:
            tool_name: 工具名称
            arguments: 工具参数

        Returns:
            PermissionResult: 权限检查结果
        """
        import re

        for rule in self.rules:
            # 匹配工具名
            if not self._match_pattern(tool_name, rule.tool_pattern):
                continue

            # 匹配输入
            if rule.input_pattern:
                input_str = str(arguments)
                if not re.search(rule.input_pattern, input_str, re.IGNORECASE):
                    continue

            # 匹配成功
            if rule.action == PermissionAction.DENY:
                return PermissionResult(
                    denied=True,
                    reason=rule.description,
                    action=rule.action,
                )
            elif rule.action == PermissionAction.ASK:
                # 在CLI模式下，ASK可以转换为交互式确认
                return PermissionResult(
                    denied=False,
                    reason=f"需要确认: {rule.description}",
                    action=rule.action,
                )

        # 默认允许
        return PermissionResult(denied=False)

    def _match_pattern(self, text: str, pattern: str) -> bool:
        """模式匹配，支持 * 通配符"""
        import fnmatch
        return fnmatch.fnmatch(text, pattern)
