<!-- Page 1 -->
代码应该这样写（5）
已付费
原创喜欢FPGA的高老师FPGA技术驿站2025年02月20日08:01河南
通常，Verilog里的case语句对应的是一个多路数据选择器，但这有个前提条件就是case语
句是完备的，也就是case语句能够覆盖所有可能的分支。实际工程中可能会碰到这样的情
形，尽管分支看似不能覆盖所有情形，但是其他情形并不会出现，如下图所示代码片段：
din_d1为10位输入数据，可能的取值有1024种（不考虑X和Z），代码第15行～第18行仅覆
盖了4种情形，这是因为该设计中其他情形不会出现。这样写的后果是：如果是纯组合逻辑
（第13行变成always@*），就会生成锁存器，如果是时序逻辑就会生成带时钟使能的
触发器。
9白
always @(posedge clk) begin
10
din_d1 <= din;
11
end
12
13
always @(posedge clk) begin
14
白
case(din_d1)
15
10'd127
: q <= 2'b00;
16
10'd255
:q<= 2'b01;
17
10'd511
:q <= 2'b10;
18
10'd1023 : q <= 2'b11;
19
endcase
白
20
end
21白
endmodule
室子工堂出#社
AMDFPGA设计优化宝典：面向VivadoVHDL
AMDFPGA
先用后付运费险7天无理由
设计优化宝典
AMDFPGA
已售1
1594RO
￥62.5
购买
电子工业出版社
上述代码片段综合后的结果如下图所示。可以看到输出q是带时钟使能（CE）的触发器。

<!-- Page 2 -->
LUT3
din_d1_reg[2]
11
12
CE
13
14
D
15
R
LUT6
FDRE
q_reg[0]
din_d1_reg[7]
din_d1_reg[3]
C
q[1:0]
CE
CE
D
R
FDRE
FDRE
FDRE
q_reg[1]
din_d1_reg[8]
CE
din_d1_reg[4]
D
q[1Li1
R
FDRE
10
FDRE
CE
11
12
13
FDRE
如果加上default分支，如下图所示代码片段，尽管可以避免锁存器或移除使能信号，但却
不符合设计本身的意图。
13
always @(posedge clk) begin
14
白
case(din_d1)
15
10'd127
:q<= 2'b00;
16
10'd255
q <= 2'b01;
17
10'd511
q <= 2'b10;
18
default
q <= 2'b11;
19
endcase
20白
end
针对这种情形，我们可以使用综合指令full_case，其目的是强制工具认为所有情形已覆
盖，无需锁存器，如下图所示代码片段。代码第14行声明了full_case，同时不要添加
default分支。
13
always @(posedge clk) begin
14
(* full_case
15
case(din_d1)
16
10'd127
: q <= 2'b00;
17
10'd255
: q <= 2'b01;
18
10'd511
: q <= 2'b10;
19
10'd1023
3 : q <= 2'b11;
20白
endcase
21白
end
full_case综合后的电路如下图所示，可以看到只消耗了1个查找表（LUT）。

<!-- Page 3 -->
CE
din[9:0]
FDRE
C
CE
FDRE
q_reg[0]
q1
C
q[1:0]
CE
LUT3
FDRE
FDRE
q_reg[1]
CE
FDRE
对比上述三种情形，如图所示，可以发现full_case对应电路无论是在资源上还是在时序性
能上都更有优势。需要注意的是full_case是综合指令，本身并不会影响仿真，这就使得功
能仿真时本质是按不完备的case处理的（含锁存器），而综合后的仿真电路因为full_case
而发生了变化，从而跟功能仿真的结果不一致。
Name
Constraints
Status
FF
DSP
LUT
WNS
TNS
WHS
synth_1 (active)
constrs_1
Synthesis Out-of-date
12
0
3
impl1(active)
constrs_1
Implementation Out-of-date
12
0
3
0.825
0.000
0.111
synth_default
constrs_1
Synthesis Out-of-date
12
0
3
impl_default
constrs_1
Implementation Out-of-date
12
0
2
0.815
0.000
0.138
synth_full_case
constrs_1
synth_design Complete!
5
0
1
impl_full_case
constrs_1
route_design Complete!
5
0
1
1.216
0.000
0.127
full_case的另一个应用场景是优先级编码，如下图所示代码片段：代码第15行～第20行为
casez语句（注意这里要使用casez而不能是case）。
14白
always @(posedge clk) begin
15
casez(din_d1)
16
4'b1??? : q <= 2'b11;
17
4'b01?? : q <= 2'b10;
18
4'b001? : 9 <= 2'b01;
19
4'b0001 : q <= 2'b00;
20白
endcase
21A
end
上述代码片段综合后的电路如下图所示。

<!-- Page 4 -->
din_d1_reg[0]
cik
CE
din[3:0]
D
FDRE
din_d1_reg[1]
C
CE
D
q0i_1
R
FDRE
q_reg[0]
din_d1_reg[2]
LUT3
C
C
q[1]i_1
CE
CE
q[1:0]
D
Q
12
FDRE
FDRE
13
LUT4
q.reg[1]
q[1]i.2
CE
din_d1_reg[3]
10
C
CE
LUT2
FDRE
D
FDRE
显然，该设计本质上只存在这四种可能，故可以添加full_cae，如下图所示。
14
always @(posedge clk) begin
15
(*full_case *)
16
casez(din_d1)
17
4'b1???: q<=2'b11;
18
4'b01?? : q <= 2'b10;
19
4'b001? : q <= 2'b01;
20
4'b0001 : q <= 2'b00;
21
endcase
22
end
综合后的电路如下图所示。
din_d1_reg[1]
clk
C
CE
din[3:0]
Q
D
R
FDRE
din_d1_reg[2]
qreg[o]
q[0]i_1
C
C
10
CE
CE
q[1:0]
11
D
D
12
R
R
LUT3
FDRE
FDRE
din_d1_reg[3]
qLreg[1]
q[1]i_1
C
C
10
CE
CE
11
D
Q
D
Q
LUT2
R
R
FDRE
FDRE
对比这两种电路性能，如下图所示。可以看到full_case对应电路消耗更少的资源，同时获
得更高的性能。

<!-- Page 5 -->
Name
Constraints
Status
FF
LUT
WNS
TNS
WHS
synth_1 (active)
constrs_1
Synthesis Out-of-date
6
3
impl1(active)
constrs_1
Implementation Out-of-date
6
2
0.806
0.000
0.133
synth_full_case
constrs_1
synth_design Complete!
5
2
impl_full_case
constrs_1
route_design Complete!
5
2
1.197
0.000
0.103
综上所述，使用full_case时需要注意的是：full_case仅影响综合工具，仿真时未覆盖的分
支可能仍会执行，导致仿真结果与硬件行为不符。需要确保未覆盖情况在仿真中不会被触
发，换言之，未覆盖的情况在实际电路中不会发生。如果未覆盖的情况实际上可能会发
生，此时就要使用default分支明确处理逻辑，而不是依赖full_case。此外，不同综合工具
对full_case的支持可能略有差异，这个要事先了解。
添加右侧二维码，邀您加入技术交流群
SunshinePis
Copyright@FPGA技术驿站
转载事宜请私信|获得授权后方可转载

<!-- Page 6 -->
喜欢FPGA的高老师
钟意作者
16人付费
Coding Style 6
FPGA 197
Vivado173
设计优化8
Coding Style·目录
上一篇·代码应该这样写（4）
喜欢此内容的人还喜欢
FPGA系统中的处理器核们（二）：软核，可杀鸡亦可屠龙？
FPGA之家
深入浅出Sigma-DeltaADCDatasheet中的Sinc滤波器
疯狂的运放

<!-- Page 7 -->
刘强东为何没参加这次的大会，原因有二
阅读10万+风清气正好生活
写留言