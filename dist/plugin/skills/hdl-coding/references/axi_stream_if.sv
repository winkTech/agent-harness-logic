//-----------------------------------------------------------------
// AXI-Stream 接口定义
//-----------------------------------------------------------------
// 兼容 ARM AMBA 4 AXI-Stream 协议
// 所有信号均为统一方向，通过 modport 区分角色
// 不依赖 UVM，纯 SystemVerilog
//-----------------------------------------------------------------

interface axi_stream_if #(
  parameter int DW = 32          // 数据位宽 (8 ~ 1024, 必须为 8 的倍数)
) (
  input logic clk,
  input logic rst
);

  //-----------------------------------------------------------------
  // 信号声明
  //-----------------------------------------------------------------
  logic                tvalid;
  logic                tready;
  logic [DW-1:0]       tdata;
  logic                tlast;
  logic [DW/8-1:0]     tkeep;
  logic [$clog2(DW/8):0] tuser;   // 每拍有效字节数（可选，默认宽度随 DW 变化）

  //-----------------------------------------------------------------
  // Master modport — 发送端 (source)
  //  驱动: tvalid, tdata, tlast, tkeep, tuser
  //  接收: tready
  //-----------------------------------------------------------------
  modport master(
    input  clk, rst,
    output tvalid,
    input  tready,
    output tdata,
    output tlast,
    output tkeep,
    output tuser
  );

  //-----------------------------------------------------------------
  // Slave modport — 接收端 (sink)
  //  驱动: tready
  //  接收: tvalid, tdata, tlast, tkeep, tuser
  //-----------------------------------------------------------------
  modport slave(
    input  clk, rst,
    input  tvalid,
    output tready,
    input  tdata,
    input  tlast,
    input  tkeep,
    input  tuser
  );

  //-----------------------------------------------------------------
  // Monitor modport — 监视器 (所有信号均为 input)
  //-----------------------------------------------------------------
  modport monitor(
    input clk, rst,
    input tvalid,
    input tready,
    input tdata,
    input tlast,
    input tkeep,
    input tuser
  );

  //-----------------------------------------------------------------
  // Protocol check: 在 valid 为高且 ready 为低的同一拍,
  // tdata/tlast/tkeep/tuser 不能变化 (稳定直到握手完成)
  //-----------------------------------------------------------------
  // 该断言在仿真中自动检查协议违规
  // synthesis translate_off
  property p_valid_stable;
    @(posedge clk) disable iff (rst)
      (tvalid && !tready) |=> $stable({tdata, tlast, tkeep, tuser});
  endproperty

  assert property (p_valid_stable)
    else $error("AXI-Stream violation: t* changed while valid=1 and ready=0");

  // 复位检查：rst 有效时 tvalid 必须为低
  property p_reset_valid_low;
    @(posedge clk)
      rst |-> !tvalid;
  endproperty

  assert property (p_reset_valid_low)
    else $error("AXI-Stream violation: tvalid must be low during reset");
  // synthesis translate_on

endinterface
