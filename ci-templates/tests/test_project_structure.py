# 项目结构测试
# 验证项目目录结构是否符合规范

import pytest
from pathlib import Path


class TestProjectStructure:
    """项目结构测试类"""

    def test_prj目录存在(self, project_root):
        """测试 prj 目录是否存在"""
        assert (project_root / "prj").exists()

    def test_基础目录结构(self, project_root):
        """测试基础目录结构"""
        required_dirs = [
            "prj/00_comm",
            "prj/01_src",
            "prj/02_sim",
            "prj/03_xdc",
            "prj/04_prj",
            "prj/05_bin",
            "prj/06_doc",
        ]

        for dir_path in required_dirs:
            assert (project_root / dir_path).exists(), f"缺少目录: {dir_path}"

    def test_gitignore存在(self, project_root):
        """测试 .gitignore 文件存在"""
        assert (project_root / ".gitignore").exists()

    def test_claude_md存在(self, project_root):
        """测试 CLAUDE.md 文件存在"""
        assert (project_root / "CLAUDE.md").exists()
