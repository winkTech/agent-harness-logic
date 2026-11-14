---
name: 代码应该这样写（4）-source
---

<!-- Page 1 -->
代码应该这样写 (4)
已付费
原创
喜欢FPGA的高老师FPGA技术驿站2025年01月09日08:03河南
FPGA设计中，触发器几乎是不可避免的逻辑单元。AMDFPGA中SLICE内或IOB内的触发
器既支持复位又支持置位，且复位/置位既可以是同步也可以是异步。但需要注意的是复位
和置位是同一端口，这就意味着对同一个触发器而言，只可以有复位或置位操作。如果使
用HDL描述时，既使用了复位又使用了置位，如下图所示代码片段，会出现什么情况呢？
下图左侧为对应代码片段，右侧为对应电路图。从代码第10行always_ff内只有posedge
clk可知相应操作只有在ck有效沿时发生，代码第11行表明复位为同步复位且高电平有
效，代码第13行表明置位是同步置位且高电平有效，同时置位的优先级低于复位的优先
级，代码第15行表明，只有当复位/置位均无效时，才能执行流水操作。
1module myff1
input logic clk,
4
input logic rst,
rst
5
input logic set,
6
input logic d,
7
output logic q
q_reg
8
);
RST
9
clk
10
always_ff @(posedge clk) begin
11白
if (rst) begin
12
0. => b
SET
13白
endelseif(set)begin
RTL_REG_SYNC
14
q<='1;
15日
end else begin
set
16
q<=d;
17白
end
18
end
19endmodule
AMDFPGA设计优化宝典：面向Vivado/VHDL
AMDFPGA
京东配送
设计优化宝典
面向Vivado/VHDL
￥75
购买
京东
上述代码综合后的结果如下图所示（目标芯片为UItraScale，对7系列FPGA以及Versal
AdaptiveSoC均适用）。从图中可以看到，除了消耗一个触发器外，还会消耗一个查找
表。该查找表用于实现复位和置位的功能，对应的布尔表达式和真值表如图中右侧所示。
可见，当rst为1时（12=1），布尔表达式值为0，故查找表输出为0，实现复位功能；当set
为1且rst为0时（10=1，12=0），布尔表达式值为1，故查找表输出为1，实现置位功能；
当rst和set均为0时，布尔表达式值为l1也就是d，实现流水操作。还会发现，此时无论是复
位还是置位都没有直接连接到触发器的复位/置位端口，这样的好处是降低了触发器的控制
集。

<!-- Page 2 -->
Sources
Netlist
Cell Properties
q_reg
qi_1
12
I1
10
0=10&112+11&112
clk
q.i1
CE
0
0
set
10
D
0
11
R
0
0
0
12
FDRE
rst
LUT3
上述复位/置位均为同步操作，如果是异步又会是什么情况呢？如下图所示代码片段，代码
第10行表明复位和置位均为异步操作；第11行表明复位为高电平有效；第13行表明置位为
高电平有效且优先级低于复位；第15行表明只有当复位/置位均无效时才能执行流水操作。
10
always_ff @（posedge clk,posedge rst,posedge set)begin
11
if（rst）begin
rst
12
0，=>b
13白
endelse if(set)begin
q_reg
14
clk
CLR
q<='1;
15
白
end else begin
Q
q<=d;
P
D
16
PRE
17白
end
RTL_REG_ASYNC
18A
end
set
上述代码综合后的电路如下图所示，可以看到此时会消耗3个触发器和1个查找表。其中上
方两个触发器为边沿敏感触发器，下方LDCE为电平敏感触发器也就是锁存器。同时，工具
会弹出警告信息，如图中右侧所示，显示FDCP是无法精确被时序约束到，建议重建代码，
避免同时异步复位/置位。
bab
F1
C
Critical Messages
CE
rst
CLR
CLR
There was onecritical warning messagewhile opening this design.
FDCE
F2
Messages
[Netlist29-358]Regq_reg’of typeFDCPcannot be timedaccurately.Hardware
CE
behaviormaybeunpredictable.Usechecktiming command formoreinformation.
Resolution:Recodeyourdesign,so thatyoudonotdependonbothasynchronousset
PRE
PRE
andreset for your desired functionality.
LUT3
Convert at leastoneof themtosynchronous sianal,orget ridofat leastoneof those
FDPE
Often,theuseof initialvaluewillhelpyougetridofoneof theasynchronous
L7
set/reset signals.
CLR
LDCE
FDCP
从布局布线的结果来看，如下图所示。由于FDCE为异步复位触发器，FDPE为异步置位触
发器，LDCE为锁存器，故三者必然至少占用两个SLICE，如图中右侧所示。这正是控制集
不同带来的后果。

<!-- Page 3 -->
q_reg
CLEM_X54Y25
F1
clk
CE
CLR
Op
FDCE
F2
L3
10
CE
11
D
PRE
PRE
12
set
LUT3
SLICE_X84Y25(SLICEM
FDPE
CLEM_X54Y24
L7
CLR
D
GE
LDCE
FDCP
SLICE_X84Y24(SLICEM
从上面两个案例可以看到，无论是同步还是异步，只要同时存在既复位又置位的操作，消
耗的资源就不会只是1个触发器，这表明代码本身和硬件结构不匹配。所以，实际工程中应
避免这种操作。
例如，只有复位，且采用同步复位，如下图所示代码片段，从代码第9行可判断后续操作为
同步操作，代码第10行表明复位为高电平有效。
9
always_ff @(posedge clk) begin
10
if (rst) begin
rst
12
0, => b
q_reg
end else begin
clk
RST
q<= d;
end
15
end
RTL_REG_SYNC
从综合后的结果来看，如下图所示，工具会把同步复位搬移到数据路径上，这样的好处是
降低了控制集。但不利支持是增加了查找表的利用率。
q_reg
q.i_1
11
10
0=10&！11
C
q-i_1
CE
0
0
0
10
D
0
1
1
rst
11
R
0
0
LUT2
FDRE

<!-- Page 4 -->
可通过综合属性DIRECTRESET将复位信号直接连接到触发器的复位端口，从而避免消耗
额外的查找表，如下图所示。
1
module myff1_rst
2
3
input logic clk,
4
（*DIRECT_RESET="YES" *) input logic rst,
q_reg
5
input logic d,
6
output logicq
clk
7
CE
D
rst
R
FDRE
对于异步复位触发器，工具是不会将其复位信号搬移到数据路径上的，对应代码和综合后
的结果如下图所示。从这个角度而言，尽可能使用同步复位触发器，这样工具可根据控制
集以及时序要求对复位信号进行处理。
9
always_ff @(posedge clk, posedge rst) begin
10
if (rst) begin
11:
:0, => b
q_reg
12白
end else begin
13:
q<=d;
clk
C
14白
end
CE
15白
end
rst
CLR
D
FDCE
如果既希望触发器上电后的初始值为1，同时又支持同步复位，这样其实避免了既复位又置
位，可采用如下图所示代码片段。图中中间为综合后的电路图，最右侧显示了属性INIT，
可以看到其值为1。代码第8行显示了初始化方法。
8
logicq_tmp='1;
9
assignq=q_tmp;
Sources
Netlist
Cell Properties
10
always_ff @(posedge clk) begin
q_tmp_reg
if （rst) begin
q_tmp_reg
11
clk
12
q_tmp<='0;
q_tmp.i_1
CE
13白
end else begin
q_tmp<=d;
d
14
10
D
INIT
1b1
15白
end
rst
11
R
IS_BLACKBOX
16
end
LUT2
IS_BOUNDARY_INST
FDRE
扫描下方二维码，邀您加入FPGA技术交流群

<!-- Page 5 -->
SunshinePis
扫一日上面的二维码图案加我为朋友
EMD
Copyright@FPGA技术驿站
转载事宜请私信|获得授权后方可转载
FPGA技术驿站
专注于FPGA，以文章、图片、视频等方式介绍Xilinx开发工具Vivado使用方法、高层次综..
467篇原创内容
公众号
喜欢FPGA的高老师
喜欢作者

<!-- Page 6 -->
12人付费
Coding Style 5
设计优化7
FPGA 191
Vivado171
CodingStyle·目录
上一篇·代码应该这样写（3）
喜欢此内容的人还喜欢
新年学个新技能，教你优雅地绘制时序图
DDOd
WKJay
如何优雅地绘制时序
【技术分享】为什么要选择BGA核心板？
ZLG致远电子
BGA封装
丈八路某研究所，年终奖一分没有
热点
3个朋友读过南门江湖
关注
写留言