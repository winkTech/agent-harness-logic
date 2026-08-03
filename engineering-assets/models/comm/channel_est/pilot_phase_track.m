function [H_corr, cpe] = pilot_phase_track(Y_sym, H_est, pilot_idx, pilot_val)
% <信道估计> 导频残余公共相位跟踪 (ADR-002: 4 导频仅做 CPE 校正)
% 输入:
%   Y_sym     - 当前 OFDM 符号接收频域信号 [N×1]
%   H_est     - 长训练符号 LS 估计 [N×1] (lts_channel_est 输出)
%   pilot_idx - 导频子载波 1-based 索引 [N_pilot×1]
%   pilot_val - 已知导频序列 [N_pilot×1] (802.11a: [1;1;-1;1])
% 输出:
%   H_corr - 相位校正后的信道估计 [N×1], 供单抽头均衡 X_hat = Y ./ H_corr
%   cpe    - 公共相位误差估计 (rad)
%
% CPE(m) = angle( Σ_p Y_m[p]·conj(H[p]·X_pilot[p]) ) —— 按 |H[p]|² 隐式加权,
% 深衰落导频自动降权。

    r = Y_sym(pilot_idx) .* conj(H_est(pilot_idx) .* pilot_val);
    cpe = angle(sum(r));
    H_corr = H_est * exp(1j * cpe);
end
