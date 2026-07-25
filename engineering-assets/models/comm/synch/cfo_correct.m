function r_corr = cfo_correct(r, epsilon, N)
% <同步> CFO 补偿 — 复数旋转
% 输入:
%   r       - 接收信号
%   epsilon - 归一化 CFO
%   N       - FFT 点数
% 输出:
%   r_corr  - CFO 补偿后的信号

    L = length(r);
    n = (0:L-1)';
    r_corr = r .* exp(-1j * 2 * pi * epsilon * n / N);

end
