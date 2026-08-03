`timescale 1ns / 1ps
//-----------------------------------------------------------------------------
// axis_skid_buffer — 历史遗留实现(Track C 种子,判卷资产)
//
// 当年为"时序保险"串接了 4 级寄存切片:功能正确、满吞吐,但 FF/LUT 约为
// 单级 skid buffer 的 4 倍。修缮目标见 briefs/spec-track-c.md。
//-----------------------------------------------------------------------------
module axis_skid_buffer #(
  parameter int DATA_W = 16
)(
  input  wire              clk,
  input  wire              rst,       // 同步高有效
  input  wire              s_valid,
  output wire              s_ready,
  input  wire [DATA_W-1:0] s_data,
  output wire              m_valid,
  input  wire              m_ready,
  output wire [DATA_W-1:0] m_data
);

  wire              w_v0, w_r0;
  wire [DATA_W-1:0] w_d0;
  wire              w_v1, w_r1;
  wire [DATA_W-1:0] w_d1;
  wire              w_v2, w_r2;
  wire [DATA_W-1:0] w_d2;

  axis_skid_stage_legacy #(.DATA_W(DATA_W)) u_stage0 (
    .clk(clk), .rst(rst),
    .s_valid(s_valid), .s_ready(s_ready), .s_data(s_data),
    .m_valid(w_v0), .m_ready(w_r0), .m_data(w_d0)
  );

  axis_skid_stage_legacy #(.DATA_W(DATA_W)) u_stage1 (
    .clk(clk), .rst(rst),
    .s_valid(w_v0), .s_ready(w_r0), .s_data(w_d0),
    .m_valid(w_v1), .m_ready(w_r1), .m_data(w_d1)
  );

  axis_skid_stage_legacy #(.DATA_W(DATA_W)) u_stage2 (
    .clk(clk), .rst(rst),
    .s_valid(w_v1), .s_ready(w_r1), .s_data(w_d1),
    .m_valid(w_v2), .m_ready(w_r2), .m_data(w_d2)
  );

  axis_skid_stage_legacy #(.DATA_W(DATA_W)) u_stage3 (
    .clk(clk), .rst(rst),
    .s_valid(w_v2), .s_ready(w_r2), .s_data(w_d2),
    .m_valid(m_valid), .m_ready(m_ready), .m_data(m_data)
  );

endmodule

module axis_skid_stage_legacy #(
  parameter int DATA_W = 16
)(
  input  wire              clk,
  input  wire              rst,
  input  wire              s_valid,
  output wire              s_ready,
  input  wire [DATA_W-1:0] s_data,
  output wire              m_valid,
  input  wire              m_ready,
  output wire [DATA_W-1:0] m_data
);

  reg              ro_s_ready;
  reg              ro_m_valid;
  reg [DATA_W-1:0] ro_m_data;
  reg              r_skid_valid;
  reg [DATA_W-1:0] r_skid_data;

  wire w_ready_early = m_ready || (!r_skid_valid && (!ro_m_valid || !s_valid));

  always @(posedge clk) begin
    if (rst) begin
      ro_s_ready   <= 1'b0;
      ro_m_valid   <= 1'b0;
      r_skid_valid <= 1'b0;
    end else begin
      ro_s_ready <= w_ready_early;

      if (ro_s_ready) begin
        if (m_ready || !ro_m_valid) begin
          ro_m_valid   <= s_valid;
          r_skid_valid <= 1'b0;
        end else begin
          r_skid_valid <= s_valid;
        end
      end else if (m_ready) begin
        ro_m_valid   <= r_skid_valid;
        r_skid_valid <= 1'b0;
      end
    end
  end

  always @(posedge clk) begin
    if (ro_s_ready) begin
      if (m_ready || !ro_m_valid) ro_m_data   <= s_data;
      else                        r_skid_data <= s_data;
    end else if (m_ready) begin
      ro_m_data <= r_skid_data;
    end
  end

  assign s_ready = ro_s_ready;
  assign m_valid = ro_m_valid;
  assign m_data  = ro_m_data;

endmodule
