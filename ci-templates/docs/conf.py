# Sphinx 配置文件
# 用于 Python 项目文档生成

import os
import sys

# 添加项目根目录
sys.path.insert(0, os.path.abspath('../prj/08_py'))

# -- 项目信息 ---------------------------------------------------------------
project = 'FPGA Project'
copyright = '2024, Lihan'
author = 'Lihan'
release = '1.0'

# -- 一般配置 ---------------------------------------------------------------
extensions = [
    'sphinx.ext.autodoc',
    'sphinx.ext.napoleon',
    'sphinx.ext.viewcode',
    'sphinx.ext.intersphinx',
    'sphinx.ext.todo',
]

# Napoleon 设置 (Google/NumPy 风格文档)
napoleon_google_docstring = True
napoleon_numpy_docstring = True
napoleon_include_init_with_doc = True

# Intersphinx 映射
intersphinx_mapping = {
    'python': ('https://docs.python.org/3', None),
    'numpy': ('https://numpy.org/doc/stable/', None),
}

# 模板路径
templates_path = ['_templates']

# 排除模式
exclude_patterns = ['_build', 'Thumbs.db', '.DS_Store']

# -- HTML 输出 ---------------------------------------------------------------
html_theme = 'sphinx_rtd_theme'
html_static_path = ['_static']

html_theme_options = {
    'navigation_depth': 4,
    'collapse_navigation': False,
    'sticky_navigation': True,
    'includehidden': True,
    'titles_only': False
}

# -- 扩展配置 ---------------------------------------------------------------
todo_include_todos = True
