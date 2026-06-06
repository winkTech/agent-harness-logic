---
name: python-basics/ch02-34-setup
description: Python 开发环境配置 — Anaconda 安装、Spyder IDE
metadata:
  source: Book1《编程不难》Ch02, Ch34
  type: reference
---

# 开发环境配置

## Anaconda/miniconda
```bash
# 环境管理
conda create -n myenv python=3.11
conda activate myenv
conda deactivate
conda env list

# 包管理
conda install numpy pandas matplotlib
conda install -c conda-forge scikit-learn
pip install streamlit  # conda 没有的包用 pip

# 导出/导入环境
conda env export > environment.yml
conda env create -f environment.yml
```

## Spyder IDE
- 布局：编辑器 (左) + 变量浏览器 (右上) + 控制台 (右下)
- 快捷键：`F5` 运行，`F9` 执行选中行
- 变量浏览器：双击查看 DataFrame 内容
- IPython 控制台：`whos` 列出变量，`%debug` 进入调试
- 调试：`Ctrl+F5` 开始调试，`F10` 单步，`F11` 进入函数
