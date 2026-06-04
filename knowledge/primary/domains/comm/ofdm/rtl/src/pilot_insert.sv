// ============================================================================
// Pilot Insert + Subcarrier Mapper
// 功能: 将调制符号映射到子载波, 插入导频/DC/Guard
// 定点: Q2.14, 16bit
// ============================================================================

`timescale 1ns / 1ps

module pilot_insert #(
    parameter FFT_LEN    = 64,
    parameter DATA_WIDTH = 16
)(
    input  wire         clk,
    input  wire         rst_n,

    // Input from mod mapper
    input  wire [15:0]  s_axis_i,
    input  wire [15:0]  s_axis_q,
    input  wire         s_axis_tvalid,
    output wire         s_axis_tready,
    input  wire         s_axis_tlast,

    // Output to IFFT
    output reg  [15:0]  m_axis_i,
    output reg  [15:0]  m_axis_q,
    output reg          m_axis_tvalid,
    input  wire         m_axis_tready
);

    // ========================================================================
    // 802.11a subcarrier allocation (64-point FFT)
    // Bin mapping (0-based, after FFT shift correction):
    //   - Bins 0..31  → negative frequency
    //   - Bins 32     → DC
    //   - Bins 33..63 → positive frequency
    //
    // Actual 802.11a mapping (before FFT shift):
    //   Guard:  -32..-27 (6 bins)
    //   Data:   -26..-22 (5 bins)
    //   Pilot:  -21
    //   Data:   -20..-8  (13 bins)
    //   Pilot:  -7
    //   Data:   -6..-1   (6 bins)
    //   DC:     0
    //   Data:   1..6     (6 bins)
    //   Pilot:  7
    //   Data:   8..20    (13 bins)
    //   Pilot:  21
    //   Data:   22..26   (5 bins)
    //   Guard:  27..31   (5 bins)
    // ========================================================================

    // Pilot values (BPSK, normalized to Q2.14)
    localparam PILOT_POS = 16'h4000;  // +1.0
    localparam PILOT_NEG = 16'hC000;  // -1.0

    // Counters
    reg [5:0]  bin_cnt;       // 0..63 subcarrier index
    reg [5:0]  data_cnt;      // data subcarrier count (0..47)
    reg        first_sym;     // first symbol flag
    reg        symbol_start;  // symbol boundary

    // State machine
    typedef enum logic [1:0] {
        IDLE,
        FILL_DATA,
        FILL_GUARD_DC,
        FLUSH
    } state_t;

    state_t state, next_state;

    // ========================================================================
    // Control logic
    // ========================================================================
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            bin_cnt <= 6'd0;
            data_cnt <= 6'd0;
            first_sym <= 1'b1;
        end else begin
            case (state)
                FILL_DATA: begin
                    if (s_axis_tvalid && s_axis_tready) begin
                        if (data_cnt == 6'd47) begin
                            data_cnt <= 6'd0;
                        end else begin
                            data_cnt <= data_cnt + 1'd1;
                        end
                    end
                    bin_cnt <= bin_cnt + 1'd1;
                    if (bin_cnt == 6'd63) begin
                        first_sym <= 1'b0;
                    end
                end

                FILL_GUARD_DC: begin
                    bin_cnt <= bin_cnt + 1'd1;
                end

                default: begin
                    bin_cnt <= 6'd0;
                    data_cnt <= 6'd0;
                end
            endcase
        end
    end

    // ========================================================================
    // Output generation
    // ========================================================================
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            m_axis_i <= 16'd0;
            m_axis_q <= 16'd0;
            m_axis_tvalid <= 1'b0;
        end else begin
            m_axis_tvalid <= 1'b1;

            // Default: zero for guard/DC bins
            m_axis_i <= 16'd0;
            m_axis_q <= 16'd0;

            case (state)
                FILL_DATA: begin
                    // Data bins: output modulated symbol
                    m_axis_i <= s_axis_i;
                    m_axis_q <= s_axis_q;
                end

                FILL_GUARD_DC: begin
                    // Already zero (guard and DC)
                end

                default: begin
                    m_axis_tvalid <= 1'b0;
                end
            endcase

            // Pilot insertion (override data bins at pilot positions)
            if (is_pilot_bin(bin_cnt)) begin
                // 导频极性: 奇符号反转
                m_axis_i <= first_sym ? PILOT_POS : PILOT_NEG;
                m_axis_q <= 16'd0;
            end

            // DC bin: always zero
            if (bin_cnt == 6'd32) begin
                m_axis_i <= 16'd0;
                m_axis_q <= 16'd0;
            end
        end
    end

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
                if (s_axis_tvalid && s_axis_tready)
                    next_state = FILL_DATA;
            end

            FILL_DATA: begin
                // 64 subcarriers per symbol
                if (bin_cnt == 6'd63 && m_axis_tready)
                    next_state = FILL_DATA;  // continuous
            end

            default: next_state = IDLE;
        endcase
    end

    // ready 在 IDLE 和 FILL_DATA 都必须为高, 否则状态机无法跳出 IDLE
    assign s_axis_tready = (state == IDLE || state == FILL_DATA) && m_axis_tready;

    // ========================================================================
    // Functions
    // ========================================================================
    function automatic logic is_pilot_bin(input [5:0] bin);
        // Pilot bins in 802.11a (after shift correction):
        // -21→bin 43, -7→bin 57, +7→bin 39, +21→bin 53
        case (bin)
            6'd43, 6'd57, 6'd39, 6'd53: return 1'b1;
            default: return 1'b0;
        endcase
    endfunction

endmodule
