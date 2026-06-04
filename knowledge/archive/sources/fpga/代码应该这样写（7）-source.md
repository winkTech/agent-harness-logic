<!-- Page 1 -->
代码应该这样写 （7)
已付费
原创喜欢FPGA的高老师FPGA技术驿站2025年09月04日08:01河南
关系运算在工程实践中经常碰到，那么如何进行电路设计以获得最佳的时序性能呢？为便于说
明，我们以如下代码为例。代码第19行至第25行描述的是计数器的功能，第29行执行关系运
算，当cnt_nxt大于等于din_dly时，dout输出为1。
14
always_ff@(posedgeclk)begin
din_dly<= din;
sel_dly<=sel;
end
always_combbegin
case (sel_dly)
2'b10:cnt nxt=cnt+1；
2'b01:cnt_nxt=cnt-1;
default :cnt_nxt =cnt;
endcase
end
always_ff@（posedgeclk)begin
28
cnt <=cnt_nxt;
29
dout <=cnt_nxt>=din_dly;
30
end
上述代码对应的硬件电路如下图所示。不难发现，这里的关键路径是从cnt_reg出发，依次
经过加法器、数据选择器、比较器，最终到达末级触发器。图中用红色标记出了该电路中
的最长路径。
于工堂出版社
AMDFPGA设计优化宝典：面向Vivado/VHDL
AMDFPGA
先用后付运费险7天无理由
设计优化宝典
AMDFPGA
已售1
设计优化宝
￥62.5
购买
电子工业出版社
FO-211
10[9:0]
0[9:0]
RTL_ADD
cntnxti
cnt_nxto_i_o
5=2b101019:0]
cnt_reg[9:0]
FO=211
10(9:0]
019:0]
5=2601119:0]
0(9:0]
clk
S=dta1219:0]
RTL_SUB
loLls
RTL_MUX
sel_dly_reg[1:0]
RTL_REG
FO=23
sel[1:0]
FO=1
dout_reg
RTLREG
FO=23
FO1
FO=
dout
oanop
din_dly_reg[9:0]
10|9:0]
RTL_REG
FO=23
1119.0]
[06]u
RTL_GEQ
RTL_REG

<!-- Page 2 -->
如选择目标芯片为xcvp1002-nfvi1369-2MP-e-S，时钟频率为500MHz，Vivado版本为
2025.1，最终的WNS为0.387nS。这里关键路径出现了混合情形：既有加法器又有选择器
和比较器。
在上述方案的基础上，如果我们仅仅把最后一步比较运算替换为减法运算，如下图代码片
段所示。cntnxt大于等于dindly意味着cntnxt与dindly之差大于等于O，这样输出
dout只用对该差值的符号位取反，对应代码第30行和第34行。
17
always_ff@（posedgeclk)begin
18
din_dly<= din;
19
sel_dly<=sel;
20
end
21
22
always_comb begin
23
case (sel_dly)
24
2'bl0:cnt_nxt=cnt+1;
25
2'b01:cnt_nxt=cnt-1;
26
default :cnt_nxt=cnt;
27
endcase
28
end
29
30
assign dout_nxt =(1'b0,cnt_nxt} -[1'b0,din_dly};
31
32
always_ff @(posedge clk)begin
33
cnt <=cnt_nxt;
34
dout <=~dout_nxt[10];
35
end
上述代码对应的电路结构如下图所示，可以看到此时的关键电路变为加法器、选择器和加
法器，尽管没有了比较器，但却导致逻辑级数增高，最大逻辑级数从5变为8，同样指标
下，WNS为0.269ns。
cnt.nxto_
090
RTL_ADD
doutreg
cnt._reg[9:0]
cnt_nxto_i_o
cntnti
dout,nxtj
douto,i
01100]
RTL_SUB
RTL_INV
RTL_REG
RTLSUB
RTL_MUX
se[10
n_dly_reg[90]
RTL_REG
din[9:0]
RTL_REC
进一步分析，我们将计数器中的加法器和后续用于比较的加法器分开处理，形成如下图所
示的代码片段。代码第22行至第28行对应计数器，第30行和31行产生中间变量tmp0和
tmp1，第33行至第39行产生3个并行的加法器。显然这样会导致查找表的消耗量增加，但
时序性能会有所提升。

<!-- Page 3 -->
always_ff @(posedge clk)begin
din_dly<=din;
19
sel_dly <=sel;
20
end
21
22
always_comb begin
23
case (sel_dly)
2
2'b10:cntnxt
=cnt+1;
2'b01 :cnt nxt =cnt-1;
default:cnt_nxt=cnt;
27
endcase
28
end
29
30
assign tmp0
=
cnt+1;
31
assign tmp1
cnt-1;
32
33
always combbegin
34
case (sel_dly)
35
2b10:dout_nxt={1'b0,tmp0}-{1'b0,din_dly};
36
2b01:dout_nxt =[1b0,tmp1}-{1'b0,din_dly};
37
default:dout_nxt=(1'b0,cnt}-{1'b0,din_dly};
38
endcase
39
end
40
41
always_ff @(posedgeclk)begin
42
cnt <= cnt nxt;
43
dout<=~dout_nxt[10];
44
end
上述代码对应的电路如下图所示，此时关键路径就变成了加法器和选择器构成的路径了。
dout.natoj
RTLMUX
SUT
口
上述3个版本其对应的资源消耗量和时序性能如下表格所示。表格中LA8表示
LOOKAHEAD8，MaxLL表示最大逻辑级数，LogicPath对应该逻辑级数下的路径形态。
可以看到版本3可获得最佳的时序性能，代价是资源消耗量有所增加。
Version
LUT
FF
LA8
MaxLL
LogicPath
Routes
WNS
WHS
V1
26
25
5
5
FF->LCY2->LA8->LCY1->LCY2->LA8->FF
3
0.387
0.144
V2
30
25
6
8
FF->LCY2->LCY2->LA8->LCY2->LCY1->LCY1->LA8->LA8->FF
2
0.269
0.141
V3
32
28
2
4
FF->L3->L5->LCY2->LA8->FF
3
0.391
0.138

<!-- Page 4 -->
END
Copyright@FPGA技术驿站
转载事宜请私信1获得授权后方可转载
喜欢FPGA的高老师
喜欢作者
23人付费

<!-- Page 5 -->
设计优化·目录
上一篇·先加后选还是先选后加？
留言
写留言
四