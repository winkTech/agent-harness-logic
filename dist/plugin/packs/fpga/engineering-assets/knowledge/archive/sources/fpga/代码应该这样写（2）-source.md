---
name: 代码应该这样写（2）-source
---

<!-- Page 1 -->
代码应该这样写 （2)
已付费
原创喜欢FPGA的高老师FPGA技术驿站2024年10月10日08:01河南
在很多FPGA的设计场景中都会用到移位寄存器，例如为了实现数据对齐所做的等效延迟就
可以通过移位寄存器实现，而AMDFPGA中SLICEM内的查找表是可以配置为移位寄存器
（SRL）的，这对于实现较大深度的移位是非常有利的。那么如何用HDL描述移位寄存器才
能保证Vivado在综合时可以高效地将其映射为期望的结构？我们先看看下面这个代码片
段。
代码第14行定义了参数DEPTH，用于指定移位深度；第15行定义了参数WIDTH，用于指
定数据位宽；第25行定义了深度为DEPTH宽度为WIDTH的数组sreg；第28行通过信号rst
对sreg的所有地址空间进行复位且为同步复位；第32行表明当rst无效时，若ce有效，那
么就执行第33~第36行，这4行本质上就是移位操作；第40行通过参数DEPTH来选择输
出，目的是当DEPTH为O时，输出即为输入，仅执行赋值操作，并没有任何移位功能，当
DEPTH大于O时输出等于移位结果。
12
module static_multi_bit_sreg_poor
13
#
14
parameter DEPTH = 8,
15
parameter WIDTH = 1
16
17
18
input logic clk,
19
input logic rst,
20
input logic ce,
21
input logic [WIDTH-1 : 0]si,
22
output logic [WIDTH-1 : 0]so
23
24
25
logic [WIDTH-1 : 0] sreg [DEPTH];
26
27白
always_ff @(posedge clk) begin
28白
if (rst) begin
29白
for (int i = θ; i < DEPTH; i++) begin
30
sreg[i]<='0;
31白
end
32白
end else if (ce) begin
33
sreg[0]<= si;
34白
for（int i= 1;i< DEPTH; i++) begin
35
sreg[i] <= sreg[i-1];
36
end
37白
end
38
end
39
40
assign so = DEPTH==0 ? si : sreg[DEPTH-1];
41
endmodule
上述代码对应的电路（打开ElaboratedDesign，按下F4，即可查看Schematic视图）如
下图所示，这里深度为4，数据宽度为1。可以看到就是4个触发器级联，这4个触发器共享
时钟端口、复位端口和时钟使能端口。

<!-- Page 2 -->
FO=4
sreg_reg[0][o]
FO=4
sreg_reg[1]0]
FO=4
sreg_reg[2][0]
clk
RST
FO=4
RST
FO=4
RST
FO=4
FO=4
FO=1
FO=4
CE
CE
CE
FO=1
si[0:0]
FO=1
FO1
FO=4
RTL_REG_SYNC
sreg_reg[3][0]
RTL_REG_SYNC
RTL_REG_SYNC
RST
so[0:0]
FO=
RTL_REG_SYNC
那么上述代码综合后的电路是什么状况呢？是我们期望的SRL吗？综合结果如下图所示：图
中4个触发器级联，这4个触发器均为FDRE，即同步复位触发器，且共享时钟端口、复位端
口和时钟使能端口。
clk
sreg_reg[3][0]
ce
sreg_reg[2][0]
sreg_reg[1][0]
sreg_reg[0][0]
FO=4
FO=4
FO=4
FO=4
FO=4
FO=4
CE
FO=4
CE
FO=1
FO=1
FO=1
so[0:0]
FO=4
CE
FO=1
FO=1
Q
FO=1
FO=1
Q
D
FO=4
si[0:0]
FO=1
Q
FO=4
FO=4
R
FO=4
R
FDRE
rst
FDRE
FDRE
FDRE
AMDFPGA设计优化宝典：面向Vivado/VHDL
AMDFPGA
设计优化宝典
京东5元券京东配送
面向Vivado/VHDL
￥70
购买
是什么原因导致工具没有将其映射为SRL呢？这就要从SRL的物理结构说起。SLICEM中的
每个查找表可配置成深度为32的移位寄存器，支持同步使能，但不支持复位，无论是同步
还是异步均不支持。而上述代码的缺陷之一就是对移位寄存器的所有单元均执行了同步复
位。上述代码的另一缺陷是第40行通过parameter进行电路选择，这里尽管使用了三目运
算符，但并不会生成二选一的MUx，这是因为parameter是静态的，在综合前就已经确
定，所以在综合时工具会根据parameter的值识别可见的代码，从而综合为目标电路。但
如果将DEPTH设定为0，综合时工具就会报错，如下图所示，表明第25行定义的sreg深度
不是正数，但实际上此时sreg并不会用到，不应该让工具看到，所以这是代码本身的问
题。
Critical Messages
×
There weretwo error messages while opening this design.
Messages
[Synth 8-2908] range width must be a positive integer
(atic_multi_bit_sreg_poor.sv:25]
[Synth 8-6156] failed synthesizing module *static_multi bit sreg_poor'
-/static_multi_bit_sreg_poor.sv:12]
OK
Qpen Messages View

<!-- Page 3 -->
鉴于此，既然是移位寄存器，我们就要把它和单独赋值（不打拍）分开来处理，同时如果
需要复位，应该在移位寄存器外面复位，即触发器+移位寄存器的形式。此外，考虑到
Vivado针对移位寄存器提供了综合属性SRL_STYLE以使得移位寄存器能映射为不同的结构
如：srl，register，reg_srl，srl_reg，reg_srl_reg或block，因此在代码里也要有该参
数，以便根据场景需求选择不同的映射结果，例如原始电路是LUT+SRL，那么综合时就可
以将移位寄存器映射为reg_srl_reg，这样最终结果就变为LUT+FF+SRL+FF，从而对SRL
左右两侧路径的时序都有好处。相应的代码如下图所示。代码第16行定义了参数
SRL_STYLE_VAL用于指定第25行属性srl_style的值，第31行~36行用于执行移位功能。
12
module static_multi_bit_sreg
13
#(
14
parameter DEPTH = 4,
15
parameter WIDTH = 1,
16
17
18
19
input logic clk,
20
input logic ce,
21
input logic [WIDTH-1 : 0] si,
22
output logic [WIDTH-1: 0] so
23
24
25
(* srl_style = SRL_STYLE_VAL *)
26
logic [WIDTH-1 : 0] sreg [DEPTH] = '{default:0};
27
28
assign so = sreg[DEPTH-1];
29
30
always_ff @(posedge clk) begin
31
if (ce) begin
32
sreg[o] <= si;
33
for （int i = 1; i < DEPTH; i++) begin
34
sreg[i] <= sreg[i-1];
35
end
36
end
37
end
38
39
endmodule
对于上述代码，若深度为4，srl_style设置为srl_reg，那么综合后的电路如下图所示：可以
看到图中的SRL16E深度为3，加上末级触发器正好移位深度为4。

<!-- Page 4 -->
sreg_reg[3][0]
FO=2
C
FO=2
ce
CE
FO=1
FO=1
so[0:0]
clk
D
sreg_reg[2][0o]_srl3
FO=4
R
FO=4
AO
FO=1
FDRE
A1
FO=4
A2
FO=4
A3
FO=1
Q
FO=2
CE
FO=2
CLK
si[0:0]
FO=1
D
SRL16E
如果将srl_style配置为reg_srl_reg，那么综合后的电路如下图所示：中间的SRL16E深度为
2，加上两侧各一个触发器正好深度为4。
sreg_reg[3][0]
FO=3
C
FO=3
CE
FO=1
FO=1
so[0:0]
sreg_reg[2][0]_srl2
D
FO=1
A0
FO=5
R
FO=5
A1
FO=5
FDRE
clk
A2
sreg_reg[0][0]
FO=5
A3
FO=1
ce□
FO=3
FO=3
CE
C
FO=3
FO=3
CLK
CE
FO=1
FO=1
si[0:0]
FO=1
Q
D
D
FO=5
SRL16E
R
FDRE
如果就是要将移位和单独赋值功能写在一个模块里，那么就要用ifgenerate语句，如下图
所示代码：第24行和第26行形成了ifelsegenerate语句，其中在else分支定义了sreg，
这样sreg只有在DEPTH大于O时可见，从而避免了DEPTH为O时引I发的错误。

<!-- Page 5 -->
12
module static_multi_bit_sreg_v1
13
#(
14
parameter DEPTH =4,
15
parameter WIDTH = 1,
16
parameter SRL_STYLE_VAL = "reg_srl_reg"
17
18
19
input logic clk,
20
input logic ce,
21
input logic [WIDTH-1 : O] si,
22
output logic[WIDTH-1:0] so
23
）：
24
if (DEPTH==0) begin
25
assign so = si;
26
end else begin
白
27
(* srl_style = SRL_STYLE_VAL *)
28
logic [WIDTH-1 : 0] sreg[DEPTH] ='{default:0};
29
30
assign so = sreg[DEPTH-1];
31
32白
always_ff @(posedge clk) begin
if (ce) begin
34
sreg[0]<= si;
35白
for (int i = 1; i < DEPTH; i++) begin
36
sreg[i] <= sreg[i-1];
37白
end
38白
end
39
end
40
assign so = sreg[DEPTH-1];
41
end
42
43endmodule
综上所示，在描述移位寄存器时要考虑到SLICEM内LUT的结构：只支持同步使能，不支持
任何方式的复位，且要考虑合理使用综合属性SRL_STYLE，避免直接使用parameter选择
生成电路，而应使用generate语句。
扫描下方二维码，邀你加入FPGA技术交流群
SunshinePis
扫一扫上面的二维码图案，加我为朋友
EM

<!-- Page 6 -->
Copyright@FPGA技术驿站
转载事宜请私信|获得授权后方可转载
FPGA技术驿站
专注于FPGA，以文章、图片、视频等方式介绍Xilinx开发工具Vivado使用方法、高层次综.
455篇原创内容
公众号
喜欢FPGA的高老师
喜欢作者
10人付费
Coding Style 3
Vivado160
FPGA 178
Coding Style·目录
上一篇·代码应该这样写（1）
喜欢此内容的人还喜欢
10倍工程师的高效编码工具：CursorxSiliconCloudxDeepSeekv2.5
硅基流动
CTI风

<!-- Page 7 -->
Python正式发布年度大更新3.13.0：实验性支持no-GIL、性能起飞！
OSC开源社区
应届生刚进公司，师傅看我啥也不会，让我帮他焊个板子，请问硬件是要天天焊板
子吗，极度讨厌焊板子？
EEDesign
写留言