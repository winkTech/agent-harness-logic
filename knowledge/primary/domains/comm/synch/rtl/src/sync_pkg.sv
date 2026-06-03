//==============================================================================
// OFDM Synchronization - Package with constants
//==============================================================================
package sync_pkg;

    // System
    localparam int N_FFT    = 64;
    localparam int N_CP     = 16;
    localparam int DATA_W   = 16;
    localparam int ACC_W    = 32;

    // Short preamble
    localparam int N_SHORT  = 16;
    localparam int L_CORR   = 16;

    // Long preamble
    localparam int N_LONG   = 64;
    localparam int N_GI2    = 32;

    // Detection
    localparam int THRESH_Q = 16384;  // 0.5 in Q0.15

    // CORDIC
    localparam int CORDIC_STAGES = 12;
    localparam int PHASE_W       = 16;  // Q1.15

endpackage : sync_pkg
