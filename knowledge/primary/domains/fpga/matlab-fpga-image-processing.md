---
title: "MATLAB/FPGA 图像处理"
domain: fpga
tags: [matlab, image-processing, video, computer-vision]
created: 2026-06-01
updated: 2026-06-01
difficulty: advanced
source: "基于matlab与fpga的图像处理教程.pdf"
---

# MATLAB/FPGA 图像处理

## 概述

本文档介绍使用 MATLAB 和 FPGA 进行图像处理的方法，涵盖图像采集、预处理、特征提取和显示。

---

## 一、图像处理流程

### 标准流程

```
图像采集 → 预处理 → 特征提取 → 后处理 → 显示/存储
```

### 关键步骤

| 步骤 | 工具 | 输出 |
|------|------|------|
| **图像采集** | Camera/Video | 原始图像 |
| **预处理** | MATLAB/FPGA | 去噪、增强 |
| **特征提取** | MATLAB/FPGA | 边缘、角点 |
| **后处理** | MATLAB/FPGA | 二值化、形态学 |
| **显示/存储** | VGA/HDMI/DDR | 显示图像 |

---

## 二、MATLAB 图像处理

### 常用函数

| 函数 | 功能 |
|------|------|
| `imread` | 读取图像 |
| `imshow` | 显示图像 |
| `imfilter` | 滤波 |
| `edge` | 边缘检测 |
| `imbinarize` | 二值化 |
| `imerode` | 腐蚀 |
| `imdilate` | 膨胀 |

### 代码示例

```matlab
% 读取图像
img = imread('image.jpg');

% 灰度化
gray_img = rgb2gray(img);

% 高斯滤波
filtered_img = imgaussfilt(gray_img, 2);

% 边缘检测
edge_img = edge(filtered_img, 'Canny');

% 显示结果
imshow(edge_img);
```

---

## 三、FPGA 图像处理架构

### 系统架构

```
图像传感器 → DDR 缓存 → FPGA 处理 → VGA/HDMI 显示
```

### 关键模块

| 模块 | 功能 |
|------|------|
| **图像传感器接口** | OV5640/MT9V034 |
| **DDR 控制器** | 数据缓存 |
| **图像处理算法** | 滤波、边缘检测 |
| **VGA/HDMI 控制器** | 显示输出 |

---

## 四、图像滤波

### 均值滤波

```verilog
// 3x3 均值滤波
module mean_filter #(
    parameter DATA_WIDTH = 8,
    parameter IMG_WIDTH = 640
)(
    input  wire clk,
    input  wire rst_n,
    input  wire [DATA_WIDTH-1:0] pixel_in,
    input  wire valid_in,
    output reg  [DATA_WIDTH-1:0] pixel_out,
    output reg  valid_out
);

reg [DATA_WIDTH-1:0] line_buffer [0:IMG_WIDTH-1];
reg [DATA_WIDTH-1:0] window [0:8];

// 3x3 窗口生成
// 均值计算

endmodule
```

### 中值滤波

```verilog
// 3x3 中值滤波
module median_filter #(
    parameter DATA_WIDTH = 8,
    parameter IMG_WIDTH = 640
)(
    input  wire clk,
    input  wire rst_n,
    input  wire [DATA_WIDTH-1:0] pixel_in,
    input  wire valid_in,
    output reg  [DATA_WIDTH-1:0] pixel_out,
    output reg  valid_out
);

// 3x3 窗口生成
// 排序网络
// 中值选择

endmodule
```

---

## 五、边缘检测

### Sobel 算子

```
Gx = [-1 0 1; -2 0 2; -1 0 1]
Gy = [-1 -2 -1; 0 0 0; 1 2 1]
```

### 实现代码

```verilog
// Sobel 边缘检测
module sobel_edge #(
    parameter DATA_WIDTH = 8,
    parameter IMG_WIDTH = 640
)(
    input  wire clk,
    input  wire rst_n,
    input  wire [DATA_WIDTH-1:0] pixel_in,
    input  wire valid_in,
    output reg  [DATA_WIDTH-1:0] pixel_out,
    output reg  valid_out
);

// 3x3 窗口生成
// Gx, Gy 计算
// 梯度幅值计算
// 阈值判断

endmodule
```

---

## 六、形态学操作

### 腐蚀

```verilog
// 腐蚀操作
module erosion #(
    parameter DATA_WIDTH = 1,
    parameter IMG_WIDTH = 640
)(
    input  wire clk,
    input  wire rst_n,
    input  wire pixel_in,
    input  wire valid_in,
    output reg  pixel_out,
    output reg  valid_out
);

// 3x3 结构元素
// 与操作

endmodule
```

### 膨胀

```verilog
// 膨胀操作
module dilation #(
    parameter DATA_WIDTH = 1,
    parameter IMG_WIDTH = 640
)(
    input  wire clk,
    input  wire rst_n,
    input  wire pixel_in,
    input  wire valid_in,
    output reg  pixel_out,
    output reg  valid_out
);

// 3x3 结构元素
// 或操作

endmodule
```

---

## 七、图像二值化

### 固定阈值

```verilog
// 固定阈值二值化
module threshold_binary #(
    parameter DATA_WIDTH = 8,
    parameter THRESHOLD = 128
)(
    input  wire clk,
    input  wire rst_n,
    input  wire [DATA_WIDTH-1:0] pixel_in,
    input  wire valid_in,
    output reg  pixel_out,
    output reg  valid_out
);

always @(posedge clk) begin
    pixel_out <= (pixel_in >= THRESHOLD) ? 1'b1 : 1'b0;
    valid_out <= valid_in;
end

endmodule
```

### 自适应阈值

```verilog
// 自适应阈值二值化
module adaptive_threshold #(
    parameter DATA_WIDTH = 8,
    parameter IMG_WIDTH = 640,
    parameter BLOCK_SIZE = 15
)(
    input  wire clk,
    input  wire rst_n,
    input  wire [DATA_WIDTH-1:0] pixel_in,
    input  wire valid_in,
    output reg  pixel_out,
    output reg  valid_out
);

// 积分图计算
// 局部均值计算
// 阈值比较

endmodule
```

---

## 八、图像显示

### VGA 时序

```verilog
// VGA 控制器
module vga_controller (
    input  wire clk,
    input  wire rst_n,
    output wire hsync,
    output wire vsync,
    output wire [7:0] red,
    output wire [7:0] green,
    output wire [7:0] blue
);

// 水平时序
// 垂直时序
// 像素生成

endmodule
```

---

## 九、最佳实践

### 设计原则
- [ ] 使用流水线处理像素
- [ ] 优化存储器访问
- [ ] 考虑实时性要求

### 验证方法
- [ ] MATLAB 仿真对比
- [ ] 实际图像测试
- [ ] 性能指标验证

---

## 参考资源

- [基于matlab与fpga的图像处理教程.pdf](../../../source/datasheets/communications/)
- [Xilinx 视频处理指南](https://www.xilinx.com/support/documentation/)
- [MATLAB 图像处理工具箱](https://www.mathworks.com/products/image.html)
