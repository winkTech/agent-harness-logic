# FPGA 开发环境 Docker 镜像
# 包含: Icarus Verilog, Python, cocotb, 基础工具

FROM ubuntu:22.04

# 设置中文环境
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

# 安装基础工具
RUN apt-get update && apt-get install -y \
    build-essential \
    git \
    curl \
    wget \
    vim \
    && rm -rf /var/lib/apt/lists/*

# 安装 Icarus Verilog
RUN apt-get update && apt-get install -y \
    iverilog \
    && rm -rf /var/lib/apt/lists/*

# 安装 Python
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# 设置工作目录
WORKDIR /workspace

# 复制依赖文件
COPY requirements/python/ /tmp/requirements/

# 安装 Python 依赖
RUN pip3 install --no-cache-dir -r /tmp/requirements/fpga-tools.txt

# 清理
RUN rm -rf /tmp/requirements

# 默认命令
CMD ["/bin/bash"]
