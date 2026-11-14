---
name: 代码应该这样写（3）-source
---

<!-- Page 1 -->
代码应该这样写（3）
已付费
原创喜欢FPGA的高老师FPGA技术驿站2024年11月14日08:00河南
对于应用FPGA实现一些算法而言，数据流的分析是关键的一步。合理的数据流不仅可以在
设计初期对整体布局起到指导作用，缓解或者避免设计后期可能的布线拥塞，而且还可以
改善设计综合的质量，确保达到甚至提升设计的Fmax要求。
对于如下图所示的代码片段，输入数据din和输出数据dout的位宽均为36，代码第41行和
第45行显示了dout和din之间的关系，代码第23~26行表明din延迟1个时钟周期得到
din_d1，din_d1延迟1个时钟周期得到din_d2，依此类推分别得到din_d3和din_d4。不
难判断，dout的位宽din位宽+2，所以，这里字长的设置并不合理。
1
module beam
2
#(W = 36)
3
(
4
input logic clk,
5
input logic rst,
6
input logic vldi,
7
input logic signed [W-1:0] din,
8
output logic signed [W-1:0] dout,
9
output logic vldo
10
0:

<!-- Page 2 -->
21
always_ff @(posedge clk) begin
22
vldi_d1 <= vldi;
23
din_d1 <= din;
24
din_d2 <= din_d1;
25
din_d3 <= din_d2;
26
din_d4 <= din_d3;
27
end
28
29白
always_ff @(posedge clk) begin
30
if (rst_d1) begin
31
cnt <='0;
32白
end
33白
else if (vldi_d1) begin
34
cnt <= cnt+1;
35白
end
36
end
37
38白
always_ff @(posedge clk) begin
39
case (cnt)
40
5'd3: begin
41
dout <= din_d1+din_d2;
42
vldo <= '1;
43日
end
44白
5'd7: begin
45
dout <= din_d1+din_d2+din_d3+din_d4;
46
vldo <= '1;
47白
end
48
default: begin
49
dout <= '0;
50
vldo <= '0;
51
end
52
endcase
53A
end
从数据流的角度看，如下图所示，当计数器cnt值为3时，执行x(2)+x(3)，当为7时，执行
x(4)～(7)4个数据相加。设计的瓶颈就在此。这里位宽较大，同时4个数相加，会出现较高
的逻辑级数。不难发现，4个数相加可以利用前面din_d1+din_d2的结果，这样就形成第一
个优化方案。
cnt
0
1
2
3
4
5
6
8
9
10
11
12
13
14
15
din
x(0)
x(1)
x(2)
x(3)
x(4)
x(5)
x(6)
x(7)
x(8)
x(9)
x(10)
x(11)
x(12)
vldi_d1
din_d1
0
x(0)
x(1)
x(2)
x(3)
x(4)
x(5)
x(6)
x(7)
x(8)
x(9)
x(10)
x(11)
x(12)
din_d2
0
0
x(0)
x(1)
x(2)
x(3)
x(4)
x(5)
x(6)
x(7)
x(8)
x(9)
x(10)
x(11)
x(12)
din_d3
0
0
0
x(0)
x(1)
x(2)
x(3)
x(4)
x(5)
x(6)
x(7)
x(8)
x(9)
x(10)
x(11)
x(12)
tpu
0
0
0
0
x(0)
x(1)
x(2)
x(3)
x(4)
x(5)
x(6)
x(7)
x(8)
(6)x
x(10)
x(11)
x(12)
din_d1+din_d2
x(0)
S10
S21
S32
S43
S54
S65
S76
S87
S98
SA9
SBA
SCB
sum
S32
S7
vldo

<!-- Page 3 -->
AMDFPGA设计优化宝典：面向Vivado/VHDL
AMDFPGA
设计优化宝典
京东京东配送
面向Vivado/VHDL
￥65
购买
优化方案1：4操作数加法变成2操作数加法
对数据流进行调整，形成如下图所示数据流。当计数值为3时得到sum1，把sum1延迟2个
时钟周期得到sum1_d2，当计数值为7时，当前sum1与sum1_d2相加即为目标结果。这
样原本4个数相加就变为2个数相加。形成如下图所示代码片段。
cnt
0
0
1
2
3
4
5
6
8
9
10
11
12
13
14
15
uP
x(0)
x(1)
x(2)
x(3)
x(4)
x(5)
x(6)
x(7)
x(8)
x(9)
x(10)
x(11)
x(12)
vldi_d1
tpup
0
x(0)
x(1)
x(2)
x(3)
x(4)
x(5)
x(6)
x(7)
x(8)
x(9)
x(10)
x(11)
x(12)
din_d2
0
0
x(0)
x(1)
x(2)
x(3)
x(4)
x(5)
x(6)
x(7)
x(8)
x(9)
x(10)
x(11)
x(12)
epu
0
0
0
x(0)
x(1)
x(2)
x(3)
x(4)
x(5)
x(6)
x(7)
x(8)
(6)x
x(10)
x(11)
x(12)
din_d4
0
0
0
0
x(0)
x(1)
x(2)
x(3)
x(4)
x(5)
x(6)
x(7)
x(8)
(6)x
x(10)
x(11)
x(12)
sum1
x(0)
S10
S21
S32
S43
S54
S65
$76
S87
S98
SA9
SBA
SCB
sum1_d1
x(0)
S10
S21
S32
S43
S54
S65
S76
S87
S98
SA9
SBA
SCB
sum1_d2
x(0)
S10
S21
S32
S43
S54
S65
S76
S87
S98
SA9
SBA
SCB
sum
S32
S7
vldo
17
logic signed [W:0] sum1, sum1_d1, sum1_d2;
18
assign suml = din_d1+din_d2;
19
20
always_ff @(posedge clk) begin
21
rst_d1 <= rst;
22
end
23
24
always_ff @(posedge clk) begin
25
vldi_d1 <= vldi;
26
din_d1 <= din;
27
din_d2 <=din_d1;
28
end
29
30
always_ff @(posedge clk) begin
31
if (rst_d1) begin
32
cnt <='0;
33
end
34
else if (vldi_d1) begin
35
cnt <= cnt+1;
36
end
37
end
38
39
always_ff @(posedge clk) begin
40
sum1_d1<=sum1;
41
sum1_d2 <= sum1_d1;
42
end

<!-- Page 4 -->
44
always_ff @(posedge clk) begin
45
case (cnt)
46
5'd3: begin
47
dout <= sum1;
48
vldo <= '1;
49
end
50
5'd7: begin
51
dout <= sum1+sum1_d2;
52
vldo K= '1;
53
end
54
default: begin
55
:0. => nop
56
vldo <= '0;
57
end
58
endcase
59
end
优化方案2：加法操作变成累加操作
再次观察上图的数据流，本质上是执行累加操作，只是累加的次数是受控的，要么是2次，
要么是4次。这时就要添加一个bypass信号，当其为高时，累加器的输出等于输入，当其
为低时就执行累加操作。同时还需要一个捕获信号capture，当其为高时，捕捉累加器的输
出作为最终结果，从而形成如下图所示的数据流。相应的SystemVerilog代码如下图所
示。不难看出，控制时序会比之前版本略微复杂一些。
cnt
0
0
1
2
3
4
5
6
8
9
10
11
12
13
14
15
up
x(0)
x(1)
x(2)
x(3)
x(4)
x(5)
x(6)
x(7)
x(8)
x(9)
x(10)
x(11)
x(12)
vldi_d1
Ipu
0
x(0)
x(1)
x(2)
x(3)
x(4)
x(5)
x(6)
x(7)
x(8)
x(9)
x(10)
x(11)
）x(12)
bypass
acc
x(2)
S(32)
x(4)
S(54)S(654)
5(7)
capture
sum
5(32)
s(7)
vldo

<!-- Page 5 -->
37:
always_comb begin
38
if (vldi_d1) begin
39
case (cnt)
40
5'd2: bypass <=
'1;
41
5'd4: bypass <=
1;
42
default: bypass K= '0;
43
endcase
44
end else begin
45
bypass <= '0;
46
end
47
end
48
49
always_comb begin
50
if (vldi_d1) begin
51
case (cnt)
52
5'd4: capture <=:'1;
53
5'd8:capture <=
'1;
54
default: capture <= '0;
55
endcase
56
end else begin
57
capture <='0;
58
end
59
end
61
always_ff @(posedge clk) begin
62
if (bypass) begin
63
acc <= din_d1;
64
end else begin
65
acc <= acc+din_d1;
66
end
67
end
68
69
always_ff @(posedge clk) begin
70
if (capture) begin
71
dout <= acc;
72
end else begin
73
dout <= '0;
74
end
75
end
76
77
always_ff @(posedge clk) begin
78
vldo <= capture;
79
end
80
endmodule
当然，我们也可以直接加括号，将加法链结构改为加法树结构，也可以改善性能，如下图
所示代码片段。关于括号为什么能改善性能可以参考这篇文章：括号能改善性能吗？

<!-- Page 6 -->
38
always_ff @(posedge clk) begin
39
case (cnt)
40
5'd3: begin
41
dout <= din_d1+din_d2;
42
vldo <= '1;
43
end
44
5'd7: begin
45
dout <= (din_d1+din_d2)+(din_d3+din_d4);
46
vldo <=
'1;
47
end
48
default: begin
49
dout <= '0;
50
vldo <= '0;
51
end
52
endcase
53
end
此外，对于优化版本1和优化版本2，可以添加综合属性USE_DSP，使用DSP48或DSP58实
现大位宽加法，这要看具体情形：如果从输入到输出有两级流水寄存器（输入一级，输出
一级），且给到DSP的信号都是触发器提供，那么这样不仅可以节省出一些查找表和触发
器，还可以提升Fmax，但如果不满足这些条件，那么可能降低Fmax。对于优化版本1，可
以对sum1添加该属性；对于优化版本2，可以对acc添加该属性。
我们对这些版本进行性能比较，选用Vivado2024.1，目标芯片为xcvp1502-vsva2785-
2MHP-i-S，时钟频率为500MHz，最终结果如下图所示。可以发现，累加器版本不仅消耗
资源少，而且WNS也最高。加括号版本可以快速在原始版本上实现，WNS的改善也很明
显，这里就体现了括号的作用。二加法版本，无论是否添加综合属性USEDSP，最终WNS
是一致的，但资源用量是有差异的。
指标
原始版本
加括号版本
二加法版本、
累加器版本
累加器版本（DSP
二加法版本（DSP
LUT
168
152
154
44
7
116
FF
199
199
192
120
46
192
LookAhead
5
5
10
5
0
5
DSP
0
0
0
0
1
1
Fanout
113(FF),46(FF)
149(FF),38(LUT)
44(FF),43(FF)
76(LUT),38(LUT)
46(PORT),38(LUT)
47(PORT), 44(FF)
LogicLevel
8(3), 7(8)
10(2), 9(6)
10(2),9(1)
9(2), 8(6)
4(58), 1(44)
10(1),9(6)
WNS
0.071
0.347
0.329
0.411
0.084
0.329
TNS
0.000
0.000
0.000
0.000
0.000
0.000
WHS
0.084
0.059
0.051
0.091
0.068
0.068
THS
0.000
0.000
0.000
0.000
0.000
0.000
扫描下方二维码，邀您加入FPGA技术交流群

<!-- Page 7 -->
SunshinePis
扫一扫上面的二维码面案、加我为朋友
Copyright@FPGA技术驿站
转载事宜请私信|获得授权后方可转载
FPGA技术驿站
专注于FPGA，以文章、图片、视频等方式介绍Xilinx开发工具Vivado使用方法、高层次综.
461篇原创内容
公众号
喜欢FPGA的高老师
喜欢作者
23人付费
Coding Style 4
设计优化5
Vivado164
FPGA183

<!-- Page 8 -->
Coding Style·目录
上一篇·代码应该这样写（2)
写留言