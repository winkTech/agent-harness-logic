---
name: systemverilog-packed-array-source
---

<!-- Page 1 -->
SystemVerilog:用好packed array 已付费
原创喜欢FPGA的高老师FPGA技术驿站2026年4月16日08:02河南
听全文
SystemVerilog提供了packed array和unpacked array。实际上，unpacked array就是
Verilog中所支持的数组形式。例如，定义二维数组arr1，其深度为4，宽带为8，那么数组
中的成员如下图所示分布。可以看到arr1[0]~arr1[3]分布空间并不是连续的。
7
6
5
4
3
2
1
0
arr1[0]
7
6
5
4
3
2
1
0
arr1[1]
7
6
5
4
3
2
1
0
arr1[2]
7
6
5
4
3
2
1
0
arr1[3]
金子工营出慧社
AMDFPGA设计优化宝典：面向Vivado/VHDL
AMDFPGA
先用后付7天无理由运费险
设计优化宝典
已售5
￥54.5新客价
购买
电子工业出版社
再看packedarray，顾名思义就是将一组信号压缩到一个连续的存储空间。如下图所示代
码片段，代码第3行定义了一个packed array，其宽度为4，深度为2，存储空间是一段连
续的地址空间。
module tp1;
bit[1:0][3:0]bus;
bit [7:0] vec;
6
initial begin
bus = 8'b0110_1001;
8
vec=8'b1100_0011;
9
$display（"bus[0]=$d,bus[1]=&d"，bus[0],bus[1]);
10
bus[0] =4'b1011;
11
$display ("bus[0] = $d, bus[1] = &d", bus[0],bus[1]);
12
bus = vec;
13
$display ("bus[0] = &d, bus[1] = $d", bus[0], bus[1]);
14
end
15白endmodule
bus[0]
bus[0]
7
6
5
4
3
2
1
0

<!-- Page 2 -->
因为bus的总长度为8，因此可以直接对这8位赋值，如代码第7行所示，也可以将一个8位
的向量赋值给bus，如代码第12行所示。如果要获取bus中的某段数位或者给其赋值，那么
就可以采用和unpackedarray相同的索引方式，如代码第10行所示。上述代码的仿真结果
如下图所示。从中可以发现，bus[O]对应的是bus的低4位，bus[1]对应的是bus的高4位。
bus[0]=9,bus[1]
=
6
bus[0] = 11,bus[1]
=
6
bus[0]=3,bus[1]
=12
packedarray是可综合的，而且正确使用会带来意想不到的效果。例如要描述一个4选1的
MUX，采用packedarray如下图所示。只需要将端口以packedarray形式声明，如代码
第9行所示。只通过一条语句即可完成该功能，如代码第23行所示。
module mymux
#（
CW = 4,
DW = 8,
SW=$clog2（CW)
8
input logic clk,
9
input logic [CW-1:0][DW-1:0] din,
10
input logic [SW-l:0] sel,
11
output logic [DW-l:0]dout
12
：
13
1 4
logic [CW-1:0][DW-1:0] din_dl;
15
logic [SW-1:0] sel_dl;
16
17 
always_ff @(posedge clk) begin
18
din_dl <= din;
19
sel_dl<=sel;
20
end
21
22
always_ff @(posedge clk) begin
23
dout <= din_dl[sel_dl];
24
end
25白
endmodule
上述代码对应的电路如下图所示。

<!-- Page 3 -->
din_d1_reg[0][7:0]
clk
FO=42
FO=1
din[0][7:0]
D
FO=1
dout_reg[7:0]
RTL_REG
FO=42
FO=1
FO=1
Q
[o:2]anop
din_d1_reg[1][7:0]
din_d1_i
D
FO=42
S=2b11
10[7:0]
FO=1
FO=1
din[1][7:0]
S=2b10
11[7:0]
RTL_REG
0[7:0]
S=2b01
12[7:0]
RTL_REG
S=2'b0013[7:0]
din_d1_reg[2][7:0]
S[1:0]
RTL_MUX
FO=42
FO=1
din[2][7:0]
FO=1
Q
RTL_REG
din_d1_reg[3][7:0]
FO=42
FO=1
FO=1
din[3][7:0]
RTL_REG
sel_d1_reg[1:0]
FO=42
FO=1
Q
FO=1
sel[1:0]
RTL_REG
ENd
Copyright@FPGA技术驿站
转载事宜请私信|获得授权后方可转载
喜欢FPGA的高老师
喜欢作者

<!-- Page 4 -->
2人付费
SystemVerilog·目录
上一篇·SystemVerilog:用好Package
留言
写留言
四