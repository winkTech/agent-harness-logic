<!-- Page 1 -->
代码应该这样写（9）
已付费
原创喜欢FPGA的高老师FPGA技术驿站2026年3月19日08:02河南
听全文
硬件思维在FPGA设计中扮演着非常重要的角色一现有电路架构，后有描述方式。如下图所
示的电路，其功能是对8个通道的数据两两相加，形成4个加法和，通过控制信号选取其中
之一的和输出。
dino
din1
din2
din3
inop
din4
din5
din6
din7
根据上图所示电路可形成如下图所示的代码片段（方案一)。假定每个通道的数据均为32位
有符号整数，那么该结构需要4个加法器，同时，加法器和紧跟其后的MUX均为组合逻
辑，两者连在一起会形成较大的逻辑级数，这对于高速设计而言是不利的。观察MUX的输
出端，可以发现这里有两级级联的触发器。所以，在不更改电路的基础上，可以将Vivado
的综合选项-global_retiming设置为on，这样工具可以自动将倒数第二级的触发器向后搬
移到MUX的输入端，从而降低逻辑级数。

<!-- Page 2 -->
2
logic signed [N-1:0][W-1:0] din_d1;
logic [N-1:0]
sel_d1;
14
logic signed [W:0]
dout_int;
15
16
always_ff @(posedge clk) begin
17
din_d1 <= din;
18
sel_d1 <= sel;
19
end
20
21白
always_ff @(posedge clk) begin
22
case (sel_d1)
23
2'b00:dout_int <= din_d1[0]+din_d1[1];
24
2'b01:dout_int<=din_d1[2]+din_d1[3];
25
2'b10:dout_int<=din_d1[4]+din_d1[5];
26
default:dout_int<=din_d1[6]+din_d1[7];
27白
endcase
28
end
29
30白
always_ff @(posedge clk) begin
31
dout <= dout_int;
32
end
33白
endmodule
对于方案一所示电路，如果将倒数第二级触发器向后搬移到MUX的输入端就可形成如下图
所示电路即方案二。相比于方案一，该电路的优势是逻辑级数较低。
AMDFPGA设计优化宝典：面向Vivado/VHDL
AMDFPGA
先用后付7天无理由运费险
设计优化宝典
已售5
购买
￥54.5新客价
电子工业出版社

<!-- Page 3 -->
dino
din1
din2
din3
inop
din4
din5
din6
din7
logic signed [N-1:0] [W-1:0] din_d1;
logic [N-1:0]
sel_d1,sel_d2;
logicsigned[3:0][W-1:0]sum;
always_ff @(posedgeclk)begin
din_d1<=din;
sel_d1<=sel;
sel_d2
<= sel_d1;
20
sum[0]
<=din_d1[0]+din_d1[1];
sum[1]
<=din_d1[2]+din_d1[3];
sum[2] <= din_d1[4]+din_d1[5];
23
sum[3] <= din_d1[6]+din_d1[7];
24
end
25
26
always_ff @(posedgeclk)begin
27
白
case (sel_d2)
28
2'b00 :dout<= sum[0];
29
2'b01 :dout <= sum[1];
30
2'b10:dout<=sum[2];
31
default:dout <= sum[3];
32
endcase
33白
end
进一步观察，不难发现这里的加法器可以复用。因为最终只有一个和输出，本质上变化的
是加法器的两个输入端对应的操作数，从而可形成如下图所示的电路，也就方案三。

<!-- Page 4 -->
dino
din2
din4
din6
+
inop
din1
din3
din5
din7
sel

<!-- Page 5 -->
always_ff @(posedge clk) begin
18
din_d1 <= din;
1 9
sel_d1 <=sel;
20
end
21
22
always_ff @(posedge clk) begin
23
case (sel_d1)
24
2'b00:
25
begin
26
deven
<=din_d1[0];
27
dodd
<= din_d1[1];
28
end
29
2'b01
30
begin
31
deven
<= din_d1[2];
32
dodd
<=din_d1[3];
33
end
34
2'b10
35
begin
36
deven
<= din_d1[4];
37
dodd
<= din_d1[5];
38
end
39
default:
40
begin
41
deven <= din_d1[6];
42
dodd
<= din_d1[7];
43
end
endcase
45
end
46
47
always_ff @(posedge clk)begin
48
dout<=deven+dodd;
49
end
50
endmodule
对比这三种方案，选取xcvp1202-vsva2785-2MHP-e-S为目标芯片，时钟频率为
500MHz。三种方案的性能对比如下表格所示。方案一之所以能获得较好的性能是因为在
综合时，对于基于Versal的设计，Vivado会自动使用Retiming功能改善逻辑级数（尽管选
项-global_retiming默认值为auto），同时使用资源共享（选择-resource_sharing的作
用），既提升了性能又降低了资源利用率。表中V1(on)为-global_retiming值为auto的情
形，V1(off)为-global_retiming值为off的情形。可以看到当没有Retiming时，方案一的
性能是有所降低的，主要原因是逻辑级数比较高。
Version
FF
LUT
LH8
WNS
WHS
Fanout
LogicLevel
V1 (on)
355
96
4
0.803
0.073
64(FF)
7(3), 6(7), 5(12), 4(8)
V1 (off)
324
96
4
0.465
0.049
64(FF)
8(3),7(7), 6(12),5(8)
V2 (on)
420
160
16
0.723
0.021
32(FF)
7(12), 6(28),5(44), 4(32)
V2 (off)
420
160
16
0.723
0.021
32(FF)
7(12), 6(28),5(44), 4(32)
V3 (on)
355
97
5
0.848
0.073
64(FF)
7(3),6(8),5(11),4(8)
V3 (off)
355
97
5
0.848
0.073
64(FF)
7(3), 6(8),5(11),4(8)
V1(noresource sharing)
413
161
16
0.742
0.045
29(FF)
7(12), 6(28), 5(51), 4(20)
对于方案一，Vivado在综合时自动会使用Retiming功能，这可在综合的log文件中看到
Retiming报告，如下图所示。表格中最后一行显示了关掉资源共享功能后的情形，可以看

<!-- Page 6 -->
到消耗的资源更多，性能也没有V1(on)好。
Retiming Report:
|Retiming
summary
|Forward Retiming
0
|Backward Retiming
1
|New registers added|
64
|Registers deleted
33
对于方案二，无论是否设置-global_retiming为on，最终结果都是一样的。换言之，这里
已经手工做好了逻辑级数的管理，与工具预期的结果一致。但方案二的描述方式使得工具
无法使用资源共享功能，所以方案二的资源消耗量最大。
对于方案三，一方面逻辑级数是合理的，另一方面资源消耗量也是最少的，同时性能也是
最好的。
通过上述三种方案的对比，不难看出好的代码风格对设计性能和资源的改善是非常明显
的。尽管一方面我们要用好工具，但另一方面，好的代码风格却能起到事半功倍的效果。
添加右侧二维码，邀您加入技术交流群
SunshinePis
Copyright@FPGA技术驿站
转载事宜请私信|获得授权后方可转载

<!-- Page 7 -->
喜欢FPGA的高老师
喜欢作者
11人付费
设计优化·目录
上一篇·如何改善BusSkew?
留言
写留言