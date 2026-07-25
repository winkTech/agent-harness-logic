//==============================================================================
// CORDIC Core - Shared atan2 and rotation
// Vector mode: atan2(y,x) -> phase[PHASE_W-1:0] (Q1.15, radians/pi)
// Rotation mode: (x,y) rotated by phase -> (x_out, y_out)
//==============================================================================
module cordic_core #(
    parameter int DATA_W    = 16,
    parameter int PHASE_W   = 16,
    parameter int STAGES    = 12
)(
    input  logic                clk,
    input  logic                rst_n,
    input  logic                start,
    input  logic                mode,        // 0=rotation, 1=vector (atan2)
    input  logic signed [DATA_W-1:0]  xi, yi,  // input vector
    input  logic [PHASE_W-1:0]       phi,        // target angle (rotation mode)
    output logic                done,
    output logic signed [DATA_W-1:0]  xo, yo,
    output logic [PHASE_W-1:0]       phase_o      // estimated phase (vector mode)
);
    // CORDIC angle constants (atan(2^-i) * 2^(PHASE_W-1) / pi)
    // For i=0..11: atan(2^-i) * 32768 / pi
    localparam int ANG[0:STAGES-1] = '{
        16384, 9672, 5110, 2594, 1302, 652, 326, 163, 81, 41, 20, 10
    };
    localparam int GAIN_SCALE = 19898;  // 1/CORDIC_gain * 2^(DATA_W-1)

    // Pipeline registers
    logic signed [DATA_W+3:0] x_pipe [0:STAGES];
    logic signed [DATA_W+3:0] y_pipe [0:STAGES];
    logic [PHASE_W-1:0] z_pipe [0:STAGES];
    logic [PHASE_W-1:0] phase_pipe [0:STAGES];
    logic mode_pipe [0:STAGES];
    logic valid_pipe [0:STAGES];

    // Initialization
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            valid_pipe[0] <= 1'b0;
            x_pipe[0] <= '0; y_pipe[0] <= '0;
            z_pipe[0] <= '0; phase_pipe[0] <= '0;
            mode_pipe[0] <= '0;
        end else if (start) begin
            valid_pipe[0] <= 1'b1;
            x_pipe[0] <= $signed(xi) * GAIN_SCALE / 32768;
            y_pipe[0] <= $signed(yi) * GAIN_SCALE / 32768;
            z_pipe[0] <= phi;
            phase_pipe[0] <= '0;
            mode_pipe[0] <= mode;
        end else begin
            valid_pipe[0] <= 1'b0;
        end
    end

    // CORDIC iterations
    genvar i;
    generate
        for (i = 0; i < STAGES; i++) begin : cordic_stage
            always_ff @(posedge clk) begin
                valid_pipe[i+1] <= valid_pipe[i];
                mode_pipe[i+1] <= mode_pipe[i];

                if (valid_pipe[i]) begin
                    if (mode_pipe[i]) begin
                        // Vector mode: rotate towards x-axis
                        if (y_pipe[i] >= 0) begin
                            x_pipe[i+1] <= x_pipe[i] + (y_pipe[i] >>> i);
                            y_pipe[i+1] <= y_pipe[i] - (x_pipe[i] >>> i);
                            phase_pipe[i+1] <= phase_pipe[i] + ANG[i];
                        end else begin
                            x_pipe[i+1] <= x_pipe[i] - (y_pipe[i] >>> i);
                            y_pipe[i+1] <= y_pipe[i] + (x_pipe[i] >>> i);
                            phase_pipe[i+1] <= phase_pipe[i] - ANG[i];
                        end
                    end else begin
                        // Rotation mode: rotate by target angle
                        if (z_pipe[i] >= 0) begin
                            x_pipe[i+1] <= x_pipe[i] - (y_pipe[i] >>> i);
                            y_pipe[i+1] <= y_pipe[i] + (x_pipe[i] >>> i);
                            z_pipe[i+1] <= z_pipe[i] - ANG[i];
                        end else begin
                            x_pipe[i+1] <= x_pipe[i] + (y_pipe[i] >>> i);
                            y_pipe[i+1] <= y_pipe[i] - (x_pipe[i] >>> i);
                            z_pipe[i+1] <= z_pipe[i] + ANG[i];
                        end
                    end
                end
            end
        end
    endgenerate

    // Output
    assign done      = valid_pipe[STAGES];
    assign xo        = x_pipe[STAGES][DATA_W-1:0];
    assign yo        = y_pipe[STAGES][DATA_W-1:0];
    assign phase_o   = phase_pipe[STAGES];

endmodule : cordic_core
