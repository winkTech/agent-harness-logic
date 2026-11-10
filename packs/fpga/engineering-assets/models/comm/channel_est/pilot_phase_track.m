function [H_corr, cpe] = pilot_phase_track(Y_sym, H_est, pilot_idx, pilot_val)
% <信道估计> 导频残余公共相位跟踪 (ADR-002: 4 导频仅做 CPE 校正)
% 输入:
%   Y_sym     - 当前 OFDM 符号接收频域信号 [N×1]
%   H_est     - 长训练符号 LS 估计 [N×1] (lts_channel_est 输出)
%   pilot_idx - 导频子载波 1-based 索引 [N_pilot×1]
%   pilot_val - 该符号**实际发送**的导频值 [N_pilot×1], **含逐符号极性**。
%               不是"常量 P 序列" —— 802.11a 的极性逐符号翻转, 传常量会让每隔一个
%               符号的 CPE 差 pi (owner 2026-08-11 裁定方案 A 后由调用方负责带极性;
%               最稳的做法是直接取 sim_frame 返回的 X_syms(pilot_idx, m))。
%               底层 P 序列 (802.11a 的 P 序列:
%               子载波 (-21,-7,7,21) -> [1;1;1;-1], **负号在 +21**)
%               本行原写作 [1;1;-1;1] (负号在 +7), 与 models/comm/ofdm 及
%               cbb/ofdm_tx_top 相反 —— owner 2026-08-09 裁定本侧错并订正。
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
