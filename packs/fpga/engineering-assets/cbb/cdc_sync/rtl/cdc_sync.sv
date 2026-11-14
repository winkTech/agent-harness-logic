`default_nettype none
//==============================================================================
// cdc_sync — 跨时钟域同步器 (单比特电平 / 多比特 req-ack 握手)
// 功能: P_DWIDTH=1: N 级电平同步器; P_DWIDTH>1: 四相 req/ack 握手安全传字
// 端口: src 域 i_clk_src/i_rst_src + i_valid_src/i_data_src/o_ready_src;
//       dst 域 i_clk_dst/i_rst_dst + o_valid_dst/o_data_dst (两复位同步高有效)
// 主要逻辑: src 侧数据锁存(ri_) -> (*ASYNC_REG*) 同步链(_cdc) -> dst 侧
//           捕获与 ack 回传 -> ro_ 寄存输出
// 延迟: 单比特 ≈ P_STAGES+2 dst 拍; 多比特一次握手 ≈
//       (P_STAGES+1) dst 拍 + (P_STAGES+1) src 拍 往返
// 吞吐: 多比特受握手往返约束 (低速控制字/状态传递用; 高吞吐跨域请用异步 FIFO)
// 复位: 各域同步高有效, 只复位本域寄存器; 两域必须联合复位后再开始传输,
//       运行中单域复位不在契约内 (req/ack 相位会失配)
//
// 契约要点:
//   - 多比特: i_valid_src && o_ready_src 拍成交, 数据锁入 src 域寄存器,
//     此后调用方可立即改 i_data_src; o_ready_src=0 期间新 valid 被拒绝
//     (不丢不重, 由调用方保持请求直到 ready);
//     o_valid_dst 为单拍寄存脉冲, 与 o_data_dst 同拍。
//   - 单比特: i_valid_src 置位拍更新电平寄存器 (恒 1 即透明电平同步);
//     o_valid_dst 复位释放后恒 1; 电平必须保持 ≥ 2×P_STAGES dst 拍才保证
//     被观察到 (电平语义, 不传脉冲)。
//   - 元稳定性无法用仿真证明: 本 TB 只证协议功能正确; 结构安全性由
//     (*ASYNC_REG*) 属性 + 后端时序约束 (set_max_delay/CDC 报告) 承担。
//
// 来源: 改写自 skills/hdl-coding/templates/comm/cdc_sync.sv (v1.0.0)
//   原件缺陷 (本模块逐条修复):
//     (1) 多比特路径 o_valid_dst = (w_req_sync != r_ack_dst) && !i_rst_dst
//         组合直出且把复位当数据用 (违反红线 2), 且为多拍电平非脉冲,
//         下游无法区分一次传输与多次;
//     (2) src 域不锁数据, dst 直接采 i_data_src, "数据须保持稳定"全靠
//         调用方自觉 —— 握手期间改数据即静默出错;
//     (3) 无 o_ready_src: 握手进行中再来 i_valid_src 被静默丢弃;
//     (4) 同步链无 (*ASYNC_REG*) 属性 (原件注释自己承认"必须在顶层约束
//         声明", 即把安全性外包给使用者), 跨域信号无 _cdc 命名;
//     (5) 单比特路径 o_valid_dst = 1 组合常量直出。
//==============================================================================
module cdc_sync #(
    parameter int P_DWIDTH = 8,
    parameter int P_STAGES = 2      // 同步链级数, 最小 2
)(
    // 源时钟域
    input  wire logic                i_clk_src,
    input  wire logic                i_rst_src,     // 同步复位, 高有效
    input  wire logic                i_valid_src,
    input  wire logic [P_DWIDTH-1:0] i_data_src,
    output logic                     o_ready_src,

    // 目的时钟域
    input  wire logic                i_clk_dst,
    input  wire logic                i_rst_dst,     // 同步复位, 高有效
    output logic                     o_valid_dst,
    output logic [P_DWIDTH-1:0]      o_data_dst
);

    if (P_STAGES < 2) $error("cdc_sync: P_STAGES 最小为 2");

    generate
    //==========================================================================
    // 单比特路径: N 级电平同步器
    //==========================================================================
    if (P_DWIDTH == 1) begin : gen_single

        // src 域电平寄存 (红线 1; 保证同步链输入无组合毛刺)
        logic ri_data_src;
        always_ff @(posedge i_clk_src) begin
            if (i_rst_src)        ri_data_src <= 1'b0;
            else if (i_valid_src) ri_data_src <= i_data_src[0];
        end

        // dst 域同步链
        (* ASYNC_REG = "TRUE" *) logic [P_STAGES-1:0] r_sync_cdc;
        always_ff @(posedge i_clk_dst) begin
            if (i_rst_dst) r_sync_cdc <= {P_STAGES{1'b0}};
            else           r_sync_cdc <= {r_sync_cdc[P_STAGES-2:0], ri_data_src};
        end

        // 寄存输出 (红线 2)
        logic ro_valid_dst, ro_data_dst, ro_ready_src;
        always_ff @(posedge i_clk_dst) begin
            if (i_rst_dst) begin
                ro_valid_dst <= 1'b0;
                ro_data_dst  <= 1'b0;
            end else begin
                ro_valid_dst <= 1'b1;    // 复位释放后输出持续有效 (电平语义)
                ro_data_dst  <= r_sync_cdc[P_STAGES-1];
            end
        end
        always_ff @(posedge i_clk_src) begin
            if (i_rst_src) ro_ready_src <= 1'b0;
            else           ro_ready_src <= 1'b1;   // 电平同步无占用概念
        end

        assign o_valid_dst = ro_valid_dst;
        assign o_data_dst  = ro_data_dst;
        assign o_ready_src = ro_ready_src;

    end
    //==========================================================================
    // 多比特路径: 四相 req/ack 握手
    //==========================================================================
    else begin : gen_multi

        //--- src 域: 数据锁存 + req 翻转 + ready ------------------------------
        logic [P_DWIDTH-1:0] ri_data_src;    // 握手期间保持稳定 (dst 采样源)
        logic                r_req_src;
        logic                ro_ready_src;
        logic                w_accept;
        logic                w_req_next;
        logic                w_ack_src;

        assign w_accept  = ro_ready_src && i_valid_src;
        assign w_req_next = w_accept ? ~r_req_src : r_req_src;

        always_ff @(posedge i_clk_src) begin
            if (i_rst_src) begin
                ri_data_src <= {P_DWIDTH{1'b0}};
                r_req_src   <= 1'b0;
                ro_ready_src <= 1'b0;
            end else begin
                if (w_accept) ri_data_src <= i_data_src;
                r_req_src    <= w_req_next;
                ro_ready_src <= (w_req_next == w_ack_src);  // 无在途才 ready
            end
        end

        //--- req 同步到 dst 域 ------------------------------------------------
        (* ASYNC_REG = "TRUE" *) logic [P_STAGES-1:0] r_req_sync_cdc;
        logic w_req_dst;

        always_ff @(posedge i_clk_dst) begin
            if (i_rst_dst) r_req_sync_cdc <= {P_STAGES{1'b0}};
            else           r_req_sync_cdc <= {r_req_sync_cdc[P_STAGES-2:0], r_req_src};
        end
        assign w_req_dst = r_req_sync_cdc[P_STAGES-1];

        //--- dst 域: 捕获 + ack 翻转 + 单拍 valid 脉冲 ------------------------
        logic                r_ack_dst;
        logic                ro_valid_dst;
        logic [P_DWIDTH-1:0] ro_data_dst;

        always_ff @(posedge i_clk_dst) begin
            if (i_rst_dst) begin
                r_ack_dst    <= 1'b0;
                ro_valid_dst <= 1'b0;
                ro_data_dst  <= {P_DWIDTH{1'b0}};
            end else if (w_req_dst != r_ack_dst) begin
                // ri_data_src 自 req 翻转前已锁定, 到此已稳定 ≥P_STAGES dst 拍
                ro_data_dst  <= ri_data_src;
                ro_valid_dst <= 1'b1;
                r_ack_dst    <= w_req_dst;
            end else begin
                ro_valid_dst <= 1'b0;
            end
        end

        //--- ack 同步回 src 域 ------------------------------------------------
        (* ASYNC_REG = "TRUE" *) logic [P_STAGES-1:0] r_ack_sync_cdc;

        always_ff @(posedge i_clk_src) begin
            if (i_rst_src) r_ack_sync_cdc <= {P_STAGES{1'b0}};
            else           r_ack_sync_cdc <= {r_ack_sync_cdc[P_STAGES-2:0], r_ack_dst};
        end
        assign w_ack_src = r_ack_sync_cdc[P_STAGES-1];

        //--- 输出 -------------------------------------------------------------
        assign o_valid_dst = ro_valid_dst;
        assign o_data_dst  = ro_data_dst;
        assign o_ready_src = ro_ready_src;

    end
    endgenerate

endmodule
`default_nettype wire
