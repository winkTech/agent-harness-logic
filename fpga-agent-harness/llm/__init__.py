"""LLM适配层 - 统一接口"""
from .vllm_adapter import VLLMAdapter, LLMResponse

__all__ = ["VLLMAdapter", "LLMResponse"]
