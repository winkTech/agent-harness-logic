// ============================================================================
// CP Insert
// 功能: 在 IFFT 输出前添加循环前缀
// 定点: Q3.13, 16bit
// 架构: Dual RAM Ping-Pong (连续吞吐)
// ============================================================================

`timescale 1ns / 1ps

module cp_insert #(
    parameter FFT_LEN    = 64,
    parameter CP_LEN     = 16,
    parameter DATA_WIDTH = 16
)(
    input  wire         clk,
    input  wire         rst_n,

    // Input from IFFT
    input  wire [15:0]  s_axis_i,
    input  wire [15:0]  s_axis_q,
    input  wire         s_axis_tvalid,
    output wire         s_axis_tready,
    input  wire         s_axis_tlast,

    // Output
    output wire [DATA_WIDTH-1:0] m_axis_tdata,
    output wire                  m_axis_tvalid,
    input  wire                  m_axis_tready,
    output wire                  m_axis_tlast
);

    // ========================================================================
    // Dual RAM Ping-Pong
    // ========================================================================

    // RAM banks
    reg [15:0] ram_i_a [0:FFT_LEN-1];
    reg [15:0] ram_q_a [0:FFT_LEN-1];
    reg [15:0] ram_i_b [0:FFT_LEN-1];
    reg [15:0] ram_q_b [0:FFT_LEN-1];

    // Control
    reg        wr_bank;           // 0: write to A, read from B; 1: opposite
    reg [5:0]  wr_addr;
    reg [5:0]  rd_addr;
    reg        wr_en;
    reg        rd_en;

    typedef enum logic [2:0] {
        IDLE,
        WRITE_SYM,
        READ_CP,
        READ_SYM,
        DONE
    } state_t;

    state_t state, next_state;
    reg [5:0]  sym_cnt;       // sample count within current symbol
    reg        output_valid;
    reg        output_last;

    // ========================================================================
    // Write logic
    // ========================================================================
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            wr_addr <= 6'd0;
            wr_en   <= 1'b0;
        end else if (s_axis_tvalid && s_axis_tready) begin
            // Write to current active bank
            if (wr_bank) begin
                ram_i_b[wr_addr] <= s_axis_i;
                ram_q_b[wr_addr] <= s_axis_q;
            end else begin
                ram_i_a[wr_addr] <= s_axis_i;
                ram_q_a[wr_addr] <= s_axis_q;
            end
            wr_addr <= wr_addr + 1'd1;
            wr_en   <= 1'b1;

            if (wr_addr == FFT_LEN-1)
                wr_addr <= 6'd0;
        end else begin
            wr_en <= 1'b0;
        end
    end

    // ========================================================================
    // Read logic (CP + full symbol)
    // ========================================================================
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            rd_addr      <= 6'd0;
            output_valid <= 1'b0;
            output_last  <= 1'b0;
            sym_cnt      <= 6'd0;
        end else begin
            case (state)
                READ_CP: begin
                    // Read last CP_LEN samples
                    rd_addr <= FFT_LEN - CP_LEN + sym_cnt;
                    output_valid <= 1'b1;
                    output_last  <= 1'b0;
                    sym_cnt <= sym_cnt + 1'd1;
                end

                READ_SYM: begin
                    // Read full symbol
                    rd_addr <= sym_cnt - CP_LEN;
                    output_valid <= 1'b1;
                    output_last  <= (sym_cnt == FFT_LEN + CP_LEN - 1);
                    sym_cnt <= sym_cnt + 1'd1;
                end

                default: begin
                    output_valid <= 1'b0;
                    output_last  <= 1'b0;
                    sym_cnt      <= 6'd0;
                end
            endcase
        end
    end

    // ========================================================================
    // Output
    // ========================================================================
    reg [15:0] rd_i, rd_q;

    always @(*) begin
        if (wr_bank) begin
            rd_i = ram_i_a[rd_addr];
            rd_q = ram_q_a[rd_addr];
        end else begin
            rd_i = ram_i_b[rd_addr];
            rd_q = ram_q_b[rd_addr];
        end
    end

    // Output: packed I/Q (Q3.13)
    assign m_axis_tdata  = {rd_i, rd_q};
    assign m_axis_tvalid = output_valid && m_axis_tready;
    assign m_axis_tlast  = output_last;

    // ========================================================================
    // State machine
    // ========================================================================
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n)
            state <= IDLE;
        else
            state <= next_state;
    end

    always @(*) begin
        next_state = state;
        case (state)
            IDLE: begin
                if (wr_en && wr_addr == FFT_LEN-1)
                    next_state = READ_CP;
            end

            READ_CP: begin
                if (sym_cnt == CP_LEN)
                    next_state = READ_SYM;
            end

            READ_SYM: begin
                if (sym_cnt == FFT_LEN + CP_LEN)
                    next_state = IDLE;
            end

            default: next_state = IDLE;
        endcase
    end

    assign s_axis_tready = (state == IDLE) || (state == WRITE_SYM && wr_addr < FFT_LEN-1);

endmodule
