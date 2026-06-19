---
name: 代码应该这样写-source
---

<!-- Page 1 -->
代码应该这样写
已付费
原创喜欢FPGA的高老师FPGA技术驿站2024年09月19日08:02河南
看一下下面的代码片段，其功能是：当rst_d1为高电平时对输出复位，当其为低电平时，
如果vld_d1为高且sop_d1也为高时，对输出置位，当vld_d1为高且sop_d1为低同时
eop_d1为高时，输出与输入相加，当vld_d1为高且sop_d1和eop_d1均为低时，输出执行
累加操作。
26
always_ff @(posedge clk) begin
27
if (rst_d1) begin
28
dout <= '0;
29
end
30
else begin
31
if (vld_d1 & sop_d1) begin
32
dout <= 16'd64;
end
34
else if (vld_d1 & eop_d1) begin
35
dout <= dout+din_d1;
36
end
37
else if (vld_d1) begin
38
dout <= dout+16'd64;
39
end
40
end
41
end
上面这段代码存在几个问题：（1）这里对触发器出现了既复位又置位的操作，且复位优先
级高（2）使用ifelseif描述，由于ifelseif中的条件变量不同，故形成MUX级联的优先级
电路。上述代码对应的电路如下图所示。图中用不同颜色标记了关键的控制信号：红色为
rst，紫色为vld，浅蓝为sop，深蓝为eop。
10150
uto_i_o
RTL_ADD
0）10150
dout0_i
din[15:0]
TL_MUX
RTL_ADD
_d1_re
ld.d1re
10[15.0
p_d1_re
louti
n115:0
soL
RTL_MUX
RTL_MUX

<!-- Page 2 -->
AMDFPGA设计优化宝典：面向Vivado/VHDL
AMDFPGA
京东京东配送
设计优化宝典
￥98.5
购买
另一种写法是采用三目运算符，相应的代码片段如下图所示。与嵌套的ifelseif类似，三目
运算符会形成优先级电路。这里rst优先级最高，其次是vld，sop和eop，从而形成MUX级
联电路。
26白
always_ff @(posedge clk) begin
27白
if (rst_d1) begin
28
dout <='0;
29白
end
30白
else begin
31
dout<=vld_d1?
32
sop_d1 ? 16'd64:
33
eop_d1 ? dout+din_d1 : dout+16'd64: dout;
34白
end
35白
end
上述这两种写法都不是最佳方案。我们从原本的设计意图来看：当rst有效时就对输出复
位，而vld有效时才会判断sop和eop是否有效，且sop和eop本身并不存在优先级关系。所
以，可以把sop和eop拼接在一起做为MUX的选择端，而sop和eop分别有效时对应的操作
做为MUx的输入数据端。另外还注意到本身并不存在sop和eop同时有效的情形，这意味
着MUX的选择端只会出现2'b00，2'b01和2b10的情形，而不会出现2'b11，故要告诉工
具这种情况。如果使用Verilog描述，就要添加full_case综合属性。如果使用
SystemVerilog描述，直接使用uniquecase即可，如下图所示代码片段。

<!-- Page 3 -->
29
always_ff @(posedge clk) begin
30
if (rst_d1) begin
31
dout <='0;
32
end
33
else if (vld_d1) begin
34
unique casei (sel)
35
2'b01 : dout <= 16'd64;
36
2'b10 : dout <= dout+din_d1;
37
2'b00 : dout <= dout+16'd64;
38
endcase
39
end
40
end
baip-dos
din_d1_reg[15:0]
F0=110(15:0)
douto_i
F0=111[15:0](
0(15:0]
din[15:0]
RTL_ADD
RTL_REG
douti
RTL_REG
F01,5=2b1011[15:0]
F0=1,5-210012(15:0]
doutoi_o
RTL_MUX
FO310[15:0]
FO:1.VF10001116.01
0[150
RTL_ADD
st.d1_reg
dout[15:0]
RTL_REG
dout,reg[15:0]
vld_d1_re
RTL_REG_SYNC
进一步分析，这里的复位是否有必要？原本的设计意图是关注sop和eop有效时及两者中间
阶段也就是在vld有效的情况下，先后出现sop有效，sop无效，eop有效，eop无效的状
况，因此，并没有复位的必要，可将复位移除，从而形成如下图所示代码片段。
26
always_ff @(posedge clk) begin
27
if (vld_d1) begin
28
unique case (sel)
29
2'b01 : dout <= 16'd64;
30
2'b10 :dout <=dout+din_d1;
31
2'b00: dout <= dout+16'd64;
32
endcase
33
end
34
end
"LP"do
op_d1_
RTL_REG
douti
doutoi_o
1000005-200110115.01
FO-110(15:0
5O1.12b10[15.0]
r0-21.10
0[15:0]
0=1,$+2b002[15:0]
RTLADD
RTL_MUX
din_d1_reg[15:0]
douto
dout[15:0]
dout.reg[15:0]
FO-111050
0(15:0]
losLlup
FO-H1
RTL_ADD
vld_d1_reg
RTL_REG
ld
RTLREG
RTL_REG

<!-- Page 4 -->
纵观这四种写法，第四种方法最为简洁也最能体现设计意图，我们对这四种方法进行比
较，采用OOC综合/布局布线，时钟频率为500MHz，目标芯片为US+，比较结果如下，表
中逻辑级数最大值部分括号内的数字为对应的时序路径的个数，例如3（9）表示逻辑级数为3
的时序路径有9条。扇出最大值部分括号内的FF表示该扇出对应的net由FF驱动。显然，第
4种写法可以获得最佳性能且资源消耗也最低。第3种写法，看似LUT消耗量最多，但其优
势在于扇出为16的net均为触发器驱动。该设计规模较小，当把该模块融入到大规模设计中
时，方案3和方案4更有优势。
版本
code_v1
code_v2
code_v3
code_v4
特征
if elseif
?:
unique case
unique case+noreset
LUT
18
18
31
18
FF
36
36
36
35
CARRY8
2
2
2
2
CLB
4
4
7
4
逻辑级数最大值
3(9),2(7)
3(9),2(7)
4(8),3(8)
3(9),2(7)
扇出最大值
33(FF), 16(FF), 15(LUT)
17(FF), 16(FF), 15(LUT)
16(FF),16(FF),16(FF)
17(FF), 16(FF), 15(LUT)
WNS
0.92
1.045
0.874
1.100
WHS
0.063
0.063
0.079
0.063
通过上述案例，我们需要进一步明确：无论是Verilog/VHDL还是SystemVerilog，本身都
是HDL（HardwareDescriptionLanguage）即硬件描述语言，换言之这些编程语言描述
的对象的硬件电路。因此在写代码之前一定要有电路的基本雏形，在此基础上选择最合适
的语句进行描述，这样才能获得最佳的性能。
EM
Copyright@FPGA技术驿站
转载事宜请私信|获得授权后方可转载
FPGA技术驿站
专注于FPGA，以文章、图片、视频等方式介绍Xilinx开发工具Vivado使用方法、高层次综..
452篇原创内容
公众号
扫描下方二维码，加高老师助理微信，邀你入群，一起探讨FPGA技术。

<!-- Page 5 -->
SunshinePis
扫一扫上面的二维码图案，加我为朋发
喜欢FPGA的高老师
钟意作者
2人付费
Coding Style2
FPGA176
Vivado157
设计优化3
CodingStyle·目录

<!-- Page 6 -->
上一篇·这个功能如何实现更高效？
喜欢此内容的人还喜欢
GDB高级玩法：自定义print输出格式
后台开发探索之旅
PCIE协议介绍(一)
CIE协议（
FPGA开源工坊
是什么阻碍了国产射频前端的发展？
钟林谈芯
写留言