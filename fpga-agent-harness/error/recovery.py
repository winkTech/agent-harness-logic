"""
错误恢复

来自learn-claude-code s11: 重试、腾空间、换路径
"""

import logging
import time
from typing import Optional, Callable
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class RecoveryStrategy:
    """恢复策略"""
    name: str
    handler: Callable
    max_retries: int = 3
    delay_ms: int = 500


class ErrorRecovery:
    """
    错误恢复系统

    来自s11的设计:
    - 错误不是终点，是重试的起点
    - token升级、fallback模型、重试策略
    """

    def __init__(self):
        self.strategies: dict[str, RecoveryStrategy] = {}
        self._setup_default_strategies()

    def _setup_default_strategies(self) -> None:
        """设置默认恢复策略"""
        # 网络错误重试
        self.register_strategy(RecoveryStrategy(
            name="network_retry",
            handler=self._retry_with_backoff,
            max_retries=3,
            delay_ms=1000,
        ))

        # Token限制升级
        self.register_strategy(RecoveryStrategy(
            name="token_escalation",
            handler=self._escalate_tokens,
            max_retries=2,
            delay_ms=0,
        ))

    def register_strategy(self, strategy: RecoveryStrategy) -> None:
        """注册恢复策略"""
        self.strategies[strategy.name] = strategy

    def recover(self, error: Exception, context: dict) -> Optional[str]:
        """
        尝试恢复

        Args:
            error: 异常
            context: 上下文信息

        Returns:
            Optional[str]: 恢复方案描述，None表示无法恢复
        """
        error_type = type(error).__name__
        error_msg = str(error)

        # 根据错误类型选择策略
        if "timeout" in error_msg.lower() or "network" in error_msg.lower():
            return self._apply_strategy("network_retry", error, context)

        if "token" in error_msg.lower() or "limit" in error_msg.lower():
            return self._apply_strategy("token_escalation", error, context)

        # 尝试所有策略
        for strategy_name in self.strategies:
            result = self._apply_strategy(strategy_name, error, context)
            if result:
                return result

        return None

    def _apply_strategy(
        self,
        strategy_name: str,
        error: Exception,
        context: dict,
    ) -> Optional[str]:
        """应用恢复策略"""
        strategy = self.strategies.get(strategy_name)
        if not strategy:
            return None

        try:
            return strategy.handler(error, context, strategy)
        except Exception as e:
            logger.error(f"恢复策略 {strategy_name} 失败: {e}")
            return None

    def _retry_with_backoff(
        self,
        error: Exception,
        context: dict,
        strategy: RecoveryStrategy,
    ) -> str:
        """指数退避重试"""
        retry_count = context.get("retry_count", 0)

        if retry_count >= strategy.max_retries:
            return None

        delay = strategy.delay_ms * (2 ** retry_count) / 1000
        logger.info(f"将在 {delay}s 后重试 (第 {retry_count + 1} 次)")

        return f"retry_after_{delay}s"

    def _escalate_tokens(
        self,
        error: Exception,
        context: dict,
        strategy: RecoveryStrategy,
    ) -> str:
        """Token限制升级"""
        current_max = context.get("max_tokens", 4096)

        if current_max >= 16000:
            return None

        new_max = min(current_max * 2, 16000)
        return f"escalate_tokens_to_{new_max}"
