---
name: python-basics/ch03-jupyterlab
description: JupyterLab 使用 — cell 类型、快捷键、环境管理
metadata:
  source: Book1《编程不难》Ch03
  type: reference
---

# JupyterLab 使用

## Cell 类型
- **Code**：Python 代码，可执行
- **Markdown**：文本/公式/图片说明
- **Raw**：原始文本，不渲染

## 快捷键
| 快捷键 | 作用 |
|--------|------|
| `Shift+Enter` | 运行当前 cell，选中下一个 |
| `Ctrl+Enter` | 运行当前 cell |
| `Alt+Enter` | 运行当前 cell，下方插入新 cell |
| `A` / `B` | 上方 / 下方插入 cell |
| `D D` | 删除 cell |
| `M` / `Y` | 切换 Markdown / Code 模式 |
| `Ctrl+/` | 注释/取消注释 |

## 魔术命令
```python
%matplotlib inline   # 图形嵌入 notebook
%timeit func()       # 计时
%run script.py       # 运行外部脚本
!pip install pkg     # 执行 shell 命令
%who                 # 列出所有变量
%%writefile out.py   # 将 cell 内容写入文件
```

## 环境管理
```bash
conda create -n myenv python=3.11
conda activate myenv
python -m ipykernel install --user --name myenv --display-name "My Env"
```
刷新页面后即可在 Kernel → Change Kernel 中选择新环境。
