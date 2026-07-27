---
name: 代码应该这样写（6）-source
---

<!-- Page 1 -->
代码应该这样写 （6)
已付费
原创
喜欢FPGA的高老师FPGA技术驿站2025年03月06日08:02河南
在Verilog中，将综合指令full_case用于适当的场景中可以起到优化电路的目的。在
SystemVerilog中，实现同样的功能可以使用uniquecase。相比于full_case，unique
case具有更明显的优势。这是因为uniquecase在仿真时就会发挥作用：uniquecase会在
仿真时检查两种情况：一是所有的case项是否互厅，也就是不存在重叠的情况；二是在执
行时是否有一个且只有一个case项被匹配。如果这两个条件不满足，仿真器会发出警告或
错误。这有助于在早期发现设计中的问题，比如多个case项同时匹配或者没有匹配的情
况。我们看一个案例，如下图所示代码片段：左侧使用了Verilog中的full_case，右侧使用
了SystemVerilog中的uniquecase。
13白
always @(posedge clk) begin
13日
always_ff @(posedge clk) begin
14
(*full_case *)
14
unique case（din_d1)
15
case(din_d1)
15
10'd127
:9<=2'b00;
16
10'd127
：q<=2'b00;
16
10'd255
:q<=2'b01;
17
10'd255
：q<=2'b01;
17
10'd511
：q<=2'b10;
18
10'd511
：q<= 2'b10;
18
10'd1023
3：q<=2'b11;
19
10'd1023:q<=2'b11;
19
endcase
20白
endcase
20日
end
21
end
使用VivadoXSim仿真，输入波形如下图所示。可以看到当输入为0/1/2等数据时，没有匹
配的case项。Verilogfull_case对此没有给出任何警告，而SystemVerilog则给出警告，
如下图所示。
藕饼cp挂件哪吒2魔童闹海卡通动漫高颜值手机链哪吒敖丙汽车钥匙扣
先用后付运费险7天无理由
已售327
￥11.9起
购买
三骋厦门见龙网络网络科技
Name
Value
0.000ns
10.000 ns
20.000ns
30.000ns
40.000ns
50.
000ns
din[9:0]
00a
000
001
002
003
004
005
006
007
008
009
00a
00b
din_d1[9:0]
600
000
001
002
003
004
005
006
007
008
009
00a
Verilog full_case
run 1000ns
INFO:[UsF-xSim-96]xSim completed.Design snapshot
'testl_tb_behav'
loaded
INFO:[UsF-xSim-97] xSim simulation ran for 1000ns
SystemVerilogunique case
launch_simulation:Time （s）:cpu = 00:00:00;elapsed=00:00:06
Memory（MB）:peak=1606.520;gain=0.000
Time resolution is 1 ps
WARNING: 2ns :none of the conditions were true for unique case from File:
/test1.sv:14
WARNING:7ns : none of the conditions were true for unique case from File:
/testl.sv:14
WARNING:17ns:none ofthe conditions
were true
for unique case from File:
L/test1.sv:14
WARNING:22ns : none of the conditions were true for unique case from File:
/testl.sv:14
WARNING:27ns :none of the conditions were true for unique case from File:
/test1.sv:14
WARNING:32ns : none of the conditions were true for unique case from File:
/test1.sv:14

<!-- Page 2 -->
普通的case语句在遇到多个匹配项时会执行第一个匹配的分支，而不会报错。这可能会导
致设计者忽略潜在的问题，比如case覆盖不全或者有重复的情况。而使用uniquecase则
会在仿真阶段给出警告信息，从而提醒设计者以确保代码的严谨性。如下图所示的代码片
段，当din_d1为4b0110时既可以匹配第2个分支，又可以匹配第3个分支（图中蓝色方框
所示）。通过仿真可以发现最终匹配第2个分支，如下图所示。
14
always @(posedge clk) begin
14
always_ff @(posedge clk) begin
15
(*full_case *)
15
unique casez(din_d1)
16
casez(din_d1)
16
4'b1??? :q <= 2'b11;
17
4'b1???
b
<=2'b11;
17
4'b01??
q<= 2'b10;
18
4'b01??
<= 2'b10;
18
4'bo?1?
q<= 2'b01;
19
4'b0?1?
9
<= 2'b01;
19
4'b0001
q<=2'b00;
20
4'b0001
q<=2'b00;
20
endcase
21
endcase
21
end
22
end
Name
Value
30.000ns
35.000ns
40.000ns
45.000ns
50.000ns
55.000ns
60.000
1" clk
 din[3:0]
1111
0101
0110
0111
1000
1001
1010
1011
din_d1[3:0]
1111
0100
0101
0110
0111
1000
1001
1010
q[1:0]
11
01
10
11
如果使用上图右侧uniquecasez语句（unique可以与case/casez/casex一起使用），则
会在仿真时给出如下图所示的警告信息：显示发现多个匹配项。
WARNING: 42ns :Multiple conditions true
condition at line:18 conflicts with condtion at line:17
for unique case from File:C:/LaurenData/sDemo2022/Demo/FullCase/test2_unique.sv:15
WARNING:47ns :Multiple conditions true
condition at 1ine:18 conflicts with condtion at line:17
for unique case from File:C:/LaurenData/SDemo2022/Demo/FullCase/test2 unique.sv:15
使用full_case时，如果又同时添加了default分支，那么工具就会忽略full_case。下图所示
左右两侧代码片段最终是等效的。
13:
always @(posedge clk) begin
13
always @(posedge clk) begin
14
（*full_case *)
14
case(din_d1)
15
case(din_d1)
15
10'd127
:q<= 2'b00;
16
10'd127
: q<= 2'b00;
16
10'd255
: q <= 2'b01;
17
10'd255
：
: q<= 2'b01;
17
10'd511
: q <= 2'b10;
18
10'd511
q <= 2'b10;
18
default
: q <= 2'b11;
19
default
:q<= 2'b11;
19白
endcase
20
endcase
20白
end
21
end
上述结论对uniquecase也是成立的，因此下图所示左右两侧代码片段最终也是等效的。
13白
always_ff @(posedge clk) begin
13
always_ff @(posedge clk) begin
14
unique case(din_d1)
14白
case(din_d1)
15
10'd127
: q <= 2'b00;
15
10'd127
:q<= 2'b00;
16
10'd255
:q<= 2'b01;
16
10'd255
：q<=2'b01;
17
10'd511
: q <= 2'b10;
17
10'd511
：q<=2'b10;
18
default
: q <= 2'b11;
18
default
：q<=2'b11;
19日
endcase
19
endcase
20
end
2月
end

<!-- Page 3 -->
将full_case以case-default替换，其中default分支会给每个case分支的变量赋值为x，如
下图左右两侧代码所示，最终这两侧代码是等效的。
13
always @(posedge clk) begin
13白
always @(posedge clk) begin
14
(* full_case *)
14
case(din_d1)
15
case(din_d1)
15
10'd127
: q<= 2'b00;
16
10'd127
: q <= 2'b00;
16
10'd255
:q<= 2'b01;
17
10'd255
: q <= 2'b01;
17
10'd511
:q<= 2'b10;
18
10'd511
:q<= 2'b10;
18
10'd1023 : q <= 2'b11;
19
10'd1023 : q <= 2'b11;
19
default : q <= 2'bxx;
20
endcase
20白
endcase
21
end
21
end
uniquecase的主要作用在于验证设计逻辑的正确性，其次才是综合优化。使用unique
case可以确保单一匹配，有效避免未覆盖的情况。
沥加右侧二维码，邀您加入技术交流群
SunshinePis
Copyright@FPGA技术驿站
转载事宜请私信|获得授权后方可转载

<!-- Page 4 -->
喜欢FPGA的高老师
喜欢作者
6人付费
Coding Style 7
FPGA199
Vivado175
设计优化9
Coding Style·目录
上一篇·代码应该这样写（5）
喜欢此内容的人还喜欢
【芯片设计】偶遇编码建议（二）在设计中优先使用无复位寄存器
芯时代青年
ThunderScope：FPGA打造开源高性能示波器
FPGA Zone
财富11等级园
DeepSeek告诉我：35岁，一般家庭会有这么多存款，看完我淡定了
品
Ai
3个朋友读过程序员炎哥
写留言

<!-- Page 5 -->
