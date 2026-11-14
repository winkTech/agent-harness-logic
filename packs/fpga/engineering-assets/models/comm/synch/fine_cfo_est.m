function epsilon_est = fine_cfo_est(T1, T2, N)
% <同步> 精 CFO 估计 — 长前导码 T1/T2 相位差
% 输入:
%   T1 - 长前导码第一个符号 (64x1)
%   T2 - 长前导码第二个符号 (64x1)
%   N  - FFT 点数
% 输出:
%   epsilon_est - 归一化 CFO

    C_sum = sum(conj(T1) .* T2);
    epsilon_est = (1 / (2 * pi)) * angle(C_sum);

end
