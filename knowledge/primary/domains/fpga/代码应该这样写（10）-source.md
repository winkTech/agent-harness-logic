<!-- Page 1 -->
代码应该这样写（10）
已付费
原创喜欢FPGA的高老师FPGA技术驿站2026年5月28日08:00河南6听全文
数据选择器（MUX）在FPGA设计中非常常见，用case语句或者SystemVerilog中的
packed array方式很容易描述。但是，对于通道个数较多的MUX，在高速场景下（时钟频
率不低于400MHz）不同的实现方式会带来不同的效果。为便于说明，这里以128:1MUX
为例，输入数据为1bit，共128个通道。
方案1：采用4442模式
具体电路如下图所示，128:1由4个层级完成：最底层为4:1，在此基础上，4个4:1加1个
4:1构成1个16:1，然后4个16:1加1个4:1构成1个64:1，最后2个64:1加1个2:1构成1个
128：1。图中绿色部分表示流水寄存器。
4:1
4:1
4:1
4:1
4:1
16:1
4:1
64:1
2:1
128:1
生子工管出热社
AMDFPGA设计优化宝典：面向Vivado/VHDL
AMDFPGA
运费险先用后付7天无理由
设计优化宝典
已售5
￥54.5新客价
购买
电子工业出版社
采用4个不同系列的FPGA实现上述方案，结果如下图所示，可见所有系列触发器（FF）的
消耗量是相同的，查找表（LUT）的消耗量也是相同的。
Name
Constraints
Status
FF
LUT
BRAM
DSP
URAM
WNS
TNS
WHS
THS
Part
synth_1(act constrs_1
synth_design Complete!
52
43
0
0
xcvu3p-ffvc1517-2-e
√impl_1 (a constrs_1
route_design Complete!
52
43
0
0
0
1.917
0.000
0.049
0.000
xcvu3p-ffvc1517-2-e
√synth_2
constrs_1
synth_design Completel
52
43
0
0
0
xcsu35p-sbvb625-2-e
√ impl_2
constrs_1
route_design Completel
52
43
0
0
0
1.907
0.000
0.047
0.000
xcsu35p-sbvb625-2-e
synth_3
constrs_1
synth_design Complete!
52
43
0
0
0
XCvp1002-nfvi1369-2MP-e-S
√ impl_3
constrs_1
route_design Completel
52
43
0
0
0
1.790
0.000
0.088
0.000
xcvp1002-nfvi1369-2MP-e-S
synth_4
constrs_1
synth_design Completel
52
43
0
0
0
xc7vx690tffg1927-2
√ impl_4
constrs_1
route_design Complete!
52
43
0
0
0
1.597
0.000
0.139
0.000xc7vx690tffg1927-2

<!-- Page 2 -->
方案2：采用4244模式
具体电路如下图所示。128:1仍然是由4个层级完成：最底层为4:1，在此基础上，2个4:1
加1个2:1构成1个8:1，然后4个8:1加1个4:1构成1个32:1，最后4个32:1加1个4:1构成1个
128：1。图中绿色部分表示流水寄存器。
4:1
2:1
4:1
8:1
4:1
32:1
4:1
128:1
采用4个不同系列的FPGA实现上述方案，结果如下图所示，可见所有系列触发器（FF）的
消耗量是相同的，查找表（LUT）的消耗量则有所不同，其中Versal芯片的LUT消耗量最
小。
Name
Constraints
Status
FF
LUT
BRAM
DSP
URAM
WNS
TNS
WHS
THS
Part
√synth_1(act
constrs_1
synth_design Complete!
64
53
0
0
0
xcvu3p-ffvc1517-2-e
√impl_1 (a constrs_1
route_design Complete!
64
53
0
0
1.867
0.0000.0460.000xcvu3p-ffvc1517-2-e
√ synth_2
constrs_1
synth_design Complete!
64
53
0
0
0
xcsu35p-sbvb625-2-e
√impl_2
constrs_1
route_design Complete!
64
53
0
0
0
1.755
0.0000.045
0.000
xcsu35p-sbvb625-2-e
√synth_3
constrs_1
synth_design Complete!
64
53
0
0
0
xCvp1002-nfvi1369-2MP-e-S
√ impl_3
constrs_1
route_design Complete!
64
46
0
0
0
1.678
0.000
0.082
0.000xcVp1002-nfvi1369-2MP-e-S
√ synth_4
constrs_1
synth_design Complete!
64
53
0
0
0
xc7vx690tffg1927-2
√ impl_4
constrs_1
route_design Completel
64
53
0
0
0
1.530
0.0000.1090.000xc7vx690tffg1927-2
方案3：一级MUX
采用SystemVerilog中的packedarray方式实现，对输入/输出各寄存一拍，最终的资源消
耗量如下图所示。与前两种方案相比，FF明显增多，LUT有一定程度的降低，这是因为
UItraScale+和7系列FPGA中的SLICE内部含有MUXF7/MUXF8，这种情况下会消耗一定
的MUXF7/MUXF8。
Name
Constraints
Status
FF
LUT
BRAM
DSP
URAM
WNS
TNS
WHS
THS
Part
√synth_1(aconstrs_1
synth_design Complete!
136
34
0
xcvu3p-ffvc1517-2-e
√impl_1
constrs_1
route_design Complete!
136
34
1.116
0.000
0.095
0.000
xcvu3p-ffvc1517-2-e
√synth_2
constrs_1
synth_design Complete!
136
34
0
0
0
xcsu35p-sbvb625-2-e
√ impl_2
constrs_1
route_design Complete!
136
34
0
0
0
1.267
0.000
0.109
0.000
xcsu35p-sbvb625-2-e
synth_3
constrs_1
synth_design Completel
136
43
0
0
0
xcvp1002-nfvi1369-2MP-e-S
√ impl_3
constrs_1
route_design Complete!
136
43
0
0
0
0.993
0.000
0.173
0.000
xcvp1002-nfvi1369-2MP-e-S
synth_4
constrs_1
synth_design Complete!
136
34
0
0
0
xc7vx690tffg1927-2
√impl_.4
constrs_1
route_design Complete!
136
34
0
0
0
0.634
0.000
0.188
0.000
xc7vx690tffg1927-2
CLB LUTs
CLB Registers
F7 Muxes
F8 Muxes
CLB
LUT as Logic
Name
(394080)
(788160)
(197040)
(98520)
(49260)
(394080)
N
mux128to1_v3
34
136
17
8
14
34

<!-- Page 3 -->
从时序性能角度看，第一种方案时序性能最好，第三种方案时序性最差。
添加右侧二维码，邀您加入技术交流群
SunshinePis
Copyright@FPGA技术驿站
转载事宜请私信|获得授权后方可转载
加我为
稀罕作者
7人付费>
设计优化·目录三
<上一篇·代码应该这样写（9）
留言
写留言

<!-- Page 4 -->
