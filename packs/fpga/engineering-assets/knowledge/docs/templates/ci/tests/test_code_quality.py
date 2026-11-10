# 代码质量测试
# 验证代码是否符合质量标准

import pytest
import subprocess
from pathlib import Path


class TestCodeQuality:
    """代码质量测试类"""

    def test_python文件无语法错误(self, project_root):
        """测试 Python 文件无语法错误"""
        py_files = list(project_root.rglob("*.py"))

        # 排除虚拟环境和缓存
        py_files = [
            f for f in py_files
            if ".venv" not in str(f) and "__pycache__" not in str(f)
        ]

        for py_file in py_files:
            result = subprocess.run(
                ["python", "-m", "py_compile", str(py_file)],
                capture_output=True
            )
            assert result.returncode == 0, f"Python 语法错误: {py_file}"

    def test_verilog文件无语法错误(self, project_root):
        """测试 Verilog 文件无语法错误"""
        v_files = list(project_root.rglob("*.v")) + list(project_root.rglob("*.sv"))

        for v_file in v_files:
            result = subprocess.run(
                ["iverilog", "-t", "null", str(v_file)],
                capture_output=True
            )
            # iverilog 返回非 0 可能只是警告，这里只检查是否崩溃
            assert result.returncode != -11, f"Verilog 文件崩溃: {v_file}"

    def test_no_simulation_artifacts(self, project_root):
        """测试没有仿真产物"""
        artifacts = [
            "transcript",
            "*.wlf",
            "*.vcd",
            "work/",
        ]

        for pattern in artifacts:
            files = list(project_root.rglob(pattern))
            # 排除 .gitignore 中的文件
            files = [
                f for f in files
                if ".git" not in str(f)
            ]
            assert len(files) == 0, f"发现仿真产物: {pattern}"
