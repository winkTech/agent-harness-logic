function H_est = lts_channel_est(Y_lts, N)
% <信道估计> 长训练符号 LS 估计 (ADR-002 默认方案, 802.11a 做法)
% 输入:
%   Y_lts - 接收 LTS 频域信号 [N×K], K 个重复 LTS (802.11a 为 2)
%   N     - FFT 点数
% 输出:
%   H_est - 全子载波信道估计 [N×1]; 52 个用载波逐点 LS, DC/保护带置 1
%
% 原理: K 个 LTS 平均 (噪声方差 /K), 已知 ±1 序列逐点相除, 无插值 ——
% 不受导频间隔/相干带宽采样定理约束 (对照: ls_channel_est.m 插值路径)。

    [X_lts, used_idx] = lts_seq(N);

    Y_avg = mean(Y_lts, 2);

    H_est = ones(N, 1);                      % DC/保护带置 1 (与 ls_channel_est 一致)
    H_est(used_idx) = Y_avg(used_idx) ./ X_lts(used_idx);
end
