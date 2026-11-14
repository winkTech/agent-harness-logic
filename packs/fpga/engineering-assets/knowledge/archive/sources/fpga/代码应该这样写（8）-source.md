---
name: 代码应该这样写（8）-source
---

<!-- Page 1 -->
代码应该这样写 （8）
已付费
原创喜欢FPGA的高老师FPGA技术驿站2026年2月5日08:00河南
1人
如下图所示代码片段，输入数据A来自于16个不同的通道，每个通道的数据位宽均为16
位，对应dinad1[j]，其中i为从0到15的整数。选择控制端seld1位宽为16，当对应位为1
且比其所在位序大的位值为0时，输出对应通道的数据；若sel_d1为0，则输出另一个输入
数据B。
28
always_ff @(posedge clk) begin
29
if (ce_d1） begin
30
if (sel_d1[15])
31
dout_int<=dina_d1[15];
32
else if (sel_d1[14])
33
dout_int<=dina_d1[14];
34
else if （sel_d1[13])
35
dout_int <= dina_d1[13];
36
else if (sel_d1[12])
37
dout_int<=dina_d1[12];
38
else if (sel_d1[11])
39
dout_int <=dina_d1[11];
40
else if （sel_d1[10])
41
dout_int<=dina_d1[10];
42
else if (sel_d1[9])
43
dout_int <= dina_d1[9];
44
else if (sel_d1[8])
45
dout_int <=dina_d1[8];
46
else if (sel_d1[7])
47
dout_int <=dina_d1[7];
48
else if (sel_d1[6])
49
dout_int <= dina_d1[6];
50
else if (sel_d1[5])
51
dout_int <= dina_d1[5];
52
else if (sel_d1[4])
53
dout_int <= dina_d1[4];
54
else if （sel_d1[3])
55
dout_int <=dina_d1[3];
56
else if （sel_d1[2])
57
dout_int <= dina_d1[2];
58
else if (sel_d1[1])
59
dout_int <= dina_d1[1];
60
else if (sel_d1[0])
61
dout_int <=dina_d1[0];
62
else
63
dout_int <= dinb_d1;
64
end
65
end
生子工营出版社
AMDFPGA设计优化宝典：面向Vivado/VHDL
AMDFPGA
7天无理由先用后付运费险
设计优化宝典
已售5
￥62.5
购买
电子工业出版社
分析上述代码可以看到ifelseif分支彼此互斥，因此最终会形成16个MUX级联电路，同时
由于MUX的数据输入端是不同通道的数据且数据位宽达到16位，这样会形成逻辑级数较大

<!-- Page 2 -->
的路径，对于高速设计是不利的。我们将上述代码用简单的电路图表示出来如下图所示，
从输入到输出的Latency为3，关键路径是其中的级联MUX（黄色标识)。
dina二
dout
sel
采用Versalxcvp1202-vsva2785-2MHP-e-S芯片，时钟为500MHz，最终消耗371个触
发器和124个查找表，WNS为0.368。尽管时序收敛，但我们还可以进一步优化。观察其中
的嵌套ifelseif语句，不难发现其中的功能是找到前导1的位置，这个位置决定了输出数据
来自于哪个通道。从这个角度来看，我们可以把“这个位置"当中地址。同时考虑到上图输出
末级有两拍寄存器，从RETIMING的角度出发，可以将倒数第二级寄存器后移，这样可以
把地址打一拍给到后续使用，从而形成如下图所示的电路。
dina
sel
RTL_ROM
dout
一qup
上述电路中不再有级联的MUX，SeI端通过RTL_ROM直接生成地址给到数据MUX的控制
端，而RTL_ROM由uniquecasez生成，如下图所示。尽管uniquecasez仍然有优先级，
但对应的MUX的数据端位宽是4位且为固定值。cid为uniquecasez生成的地址。由于控制
端和数据端都是两级流水，再加上末级的一级流水寄存器，所以从输入到输出的Latency并
没有发生变化。

<!-- Page 3 -->
28
always_ff @(posedge clk)begin
29
dina_d1
<=
dina;
30
dina_d2
<=
dina_d1;
31
dinb_d1
<= dinb;
32
dinb_d2
<=
dinb_d1;
33
sel_d1
<=
sel;
34
ce_d1
<=ce;
35
ce_d2
<=ce_d1;
36
sel_d1_flag <=|sel_d1;
37
end
38
39
always_ff @(posedge clk) begin
40
unique casez
(sel_d1)
4 1
16'b1？？？_？??？_？?？？_？?？？：cid<=4'd15;
42
16'b01??_???？_？??？_???？：cid<=4'd14;
43
16'b001?_????_????_？???:cid<=4'd13;
44
16'b0001_????_????_????:cid<=4'd12;
45
16'b0000_1???_？???_？??？：cid<=
4'd11;
46
16'b0000_01??_？???_????
:cid
<=
4'd10;
47
16'b0000_001?_????_????
cid
<=
4'd9;
48
16'b0000_0001
cid
<=
4'd8;
49
16'b0000_0000_1???_????
cid
<=
4'd7;
50
16'b0000_0000_01??_????
cid
=
51
16'b0000_0000_001?_？???
cid
<=
4'd5;
52
16'b0000_0000_0001_？???:cid
<=
4'd4;
53
16'b0000_0000_0000_1???:cid
<=
4'd3;
54
16'b0000_0000_0000_01??:cid
<=
4'd2;
55
16'b0000_0000_0000_001？:cid<=4
4'd1;
56
16'b0000_0000_0000_0001:cid<=4'd0;
57
endcase
58
end
59
60
always_ff @(posedge clk) begin
61
if (ce_d2) begin
62
if （sel_d1_flag)
63
dout_int<=dina_d2[cid];
64
else
65
dout_int <=dinb_d2；
66
end
67
end
68
endmodule
通过行为级仿真可以验证这两种方案的功能是一致的，仿真波形如下图所示。其中dout_v1
对应方案1的输出结果，doutv2对应方案2的输出结果。
 dina[15:0][7:0]
a8,28,a3,c2
3e...
e5,...
ec,...
87,...
c6,...
d0,...
ee,c8,4b,04,3b,42,0b,93,e2...
e4,...
cC,...
82,...
 dinb[7:0]
e1
33
ca
cd
d2
b2
10
32
d7
9d
17
 sel[15:0]
0040
0200
0400
0800
1000
2000
4000
8000
0000
7c0d
62b8
ea46
ce
1 ce_d1
 dina_d1[15:0][7:0]
cc,b0,fb,54,
f8.
87,...
ee,c8,4b,04,3b,42,0b,93,e2...
e4,.
cC,.
 dinb_d1[7:0]
54
e1
33
ca
cd
d2
b2
10
32
d7
9d
 sel_d1[15:0]
0020
0100
0200
0400
0800
1000
2000
4000
8000
0000
7c0d
62b8
 dout int[7:0]
64
c1
95
9a
af
3d
f5
6f
58
ee
32
52
cid[3:0]
7
8
9
a
b
d
e
f
 dina_d2[15:0][7:0]
ed,82,1b,9e
f8,...
3e,...
e5,...
ec,...
87,...
c6,...
d0,...
ee,c8,4b,04,3b,42,0b,93,e2...
e4
dout_v1[7:0]
f8
b4
e1
95
9a
af
3d
f5
6f
58
ee
32
dout_v2[7:0]
f8
b4
c1
95
9a
af
3d
f5
6f
58
ee
32
再从资源和性能角度看，如下图所示，可以看到方案2的查找表消耗量会比方案1低一些
而触发器消耗量则会比方案1高一些，WNS也会比方案1好一些。
Name
Constraints
Status
FF
LUT
BRAM
DSP
Elapsed
Incremental
WNS
TNS
WHS
THS
synth_v2_16(active)
constrs_1
Synthesis Out-of-date
583
111
0
0
00:01:34
Auto(Skipped)
6 impl_v2_16 (active)
constrs_1
Implementation Out-of-date
583
110
0
00:03:25
0
0.592
0.000
0.048
0.000
 synth_v1_16
constrs_1
Synthesis Out-of-date
371
124
0
0
00:01:22
Auto(Skipped)
 impl_v1_16
constrs_1
Implementation Out-of-date
371
124
0
0
00:02:38
Off
0.368
0.000
0.020
0.000

<!-- Page 4 -->
实际工程中尽可能将控制路径和数据路径分开处理，一来两者的位宽不一致，同样的操作
在低位宽时可消耗更少的资源。二来控制信号最终会连接到触发器的时钟使能端口CE或者
复位端口R上，这两个端口的建立时间门限通常比较高，在高速设计中往往需要多级流水，
而数据路径最终连接到触发器的数据端口D上，这个端口的建立时间门限比CE/R要低一
些，时序更容易收敛。因此可根据不同路径的复杂度（逻辑级数）决定流水深度，确保合
理的流水深度。
添加右侧二维码，邀您加入技术交流群
SunshinePis
Copyright @ FPGA技术驿站
转载事宜请私信|获得授权后方可转载
喜欢FPGA的高老师
喜欢作者
29人付费

<!-- Page 5 -->
设计优化·目录
上一篇·如何理解retimingforward和retimingbackward?
留言
写留言