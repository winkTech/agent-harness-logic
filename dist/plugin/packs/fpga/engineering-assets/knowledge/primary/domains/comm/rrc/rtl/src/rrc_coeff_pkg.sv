//==============================================================================
// RRC 成形滤波器 — 系数包
// α=0.5, sps=4, span=8 → 33 抽头
// 对称: h[n] = h[32-n]
// 系数量化: Q1.15 (16-bit signed)
// 多相分解: 4 相位, 各相位对称折叠
//==============================================================================
package rrc_coeff_pkg;

    // 参数
    parameter int TAPS        = 33;
    parameter int SPS         = 4;
    parameter int SPAN        = 8;
    parameter int COEFF_W     = 16;
    parameter int PHASE_LEN   = 9;    // 最长相位抽头数
    parameter int SYM_TAPS    = 5;    // 对称折叠后每相位最大乘数

    // 相位 0 系数 (h[0], h[4], h[8], h[12], h[16], h[20], h[24], h[28], h[32])
    // 对称对: (0,8), (1,7), (2,6), (3,5), h[4] 中心
    // Phase 0: 9 taps → 5 mults (4 symmetric pairs + 1 center)
    const bit signed [COEFF_W-1:0] PHASE0_COEFF[0:SYM_TAPS-1] = '{
        16'sh00E4,  // h[0] + h[32] = 0.0035 × 2
        16'hFEE0,   // h[4] + h[28] = -0.0347 × 2
        16'hF51C,   // h[8] + h[24] = -0.3385 × 2
        16'h0C36,   // h[12] + h[20] = 0.3816 × 2
        16'h5A76    // h[16] (center) = 0.7071
    };
    // Note: h[0] and h[32] are both positive small → sum = 2*h[0]
    // For pairs, coefficient = 2 * h[n] for pre-add path

    // Phase 1 系数 (h[1], h[5], h[9], h[13], h[17], h[21], h[25], h[29])
    // 对称对: (0,7), (1,6), (2,5), (3,4)
    // Phase 1: 8 taps → 4 mults (4 symmetric pairs)
    const bit signed [COEFF_W-1:0] PHASE1_COEFF[0:SYM_TAPS-2] = '{
        16'h0268,   // h[1] + h[29] = 0.0094 × 2
        16'hF8D6,   // h[5] + h[25] = -0.1121 × 2
        16'hF8D6,   // h[9] + h[21] = -0.1121 × 2
        16'h1AA8    // h[13] + h[17] = 0.4152 × 2
    };

    // Phase 2 系数 (h[2], h[6], h[10], h[14], h[18], h[22], h[26], h[30])
    // 对称对: (0,7), (1,6), (2,5), (3,4)
    const bit signed [COEFF_W-1:0] PHASE2_COEFF[0:SYM_TAPS-2] = '{
        16'h0512,   // h[2] + h[30] = 0.0199 × 2
        16'h0000,   // h[6] + h[26] = 0.0000 × 2
        16'h0200,   // h[10] + h[22] = 0.0078 × 2
        16'h5340    // h[14] + h[18] = 0.6504 × 2
    };

    // Phase 3 系数 (h[3], h[7], h[11], h[15], h[19], h[23], h[27], h[31])
    // 对称对: (0,7), (1,6), (2,5), (3,4)
    const bit signed [COEFF_W-1:0] PHASE3_COEFF[0:SYM_TAPS-2] = '{
        16'h0B5A,   // h[3] + h[31] = 0.0444 × 2
        16'h0B5A,   // h[7] + h[27] = 0.0444 × 2
        16'h10E4,   // h[11] + h[23] = 0.1326 × 2
        16'h5F98    // h[15] + h[19] = 0.7466 × 2
    };

endpackage : rrc_coeff_pkg
