# Claude Code Constraints

## 环境工具
- 开发工具详细说明请参考 @<TOOL.md>

## 设计规则约束
- 进行hdl编码时，需要遵从RTL编码规则@<RTL_DESIGN_RULE.md>
- 进行matlab编码时，需要遵从matlab代码约束@<MATLAB_RULE.md>
- 进行python编码时，需要遵从python代码约束@<PYTHON_RULE.md>
- 进行框图绘制时，需要遵从绘图或者演示规则@<DRAW_RULE.md>

### 新建设计目录
- 只在有明确新建项目的要求时，添加以下设计目录
- 在已有目录下，没有明确地文件夹改动指令时，路径下的文件夹不做任何改动
- prj
-  |—— 00_comm      //存入设计全局脚本，如json文件等
-  |—— 01_src       //存入hdl和ip工程设计代码
-      |——00_hdl    //存入hdl代码文件，内部应该按模块功能划分新目录进行保存
-      |——01_ip     //存入工程使用的IP文件，内部应该按模块功能划分新目录进行保存
-  |—— 02_sim       //存入逻辑仿真testbench以及测试数据文件等
-  |—— 03_xdc       //存入工程设计约束文件
-  |—— 04_prj       //存入工程跟文件
-  |—— 05_bin       //存入烧写文件与版本说明
-  |—— 06_doc       //存入工程相关文档
-  |—— 07_mat       //存入matlab代码文件
-      |——00_fx     //存入matlab 函数文件
-      |——01_conf   //存入matlab 配置常量文件
-      |——02_script //存入matlab 模型代码和计算模块等
-  |—— 08_py        //存入python程序，内部按模块功能划分新目录进行保存

## 语言要求
- 所有输出对话使用中文，特殊字符或者信号除外
- 所有输出文档使用中文，特殊字符或者信号除外

## 版本管理
- 进行项目开发实施时，按照@<GIT_RULE.md>进行版本管理
- 代码编写完成后需调用对应语言 lint 工具检查语法，无错误才能提交
  - Verilog/SV → vlog -lint
  - VHDL → vcom -lint
  - Python → ruff check 或 flake8
  - MATLAB → checkcode()
