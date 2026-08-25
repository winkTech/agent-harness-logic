function freq_sym = fft_chain(time_sym, cfg)
%FFT_CHAIN  OFDM FFT 变换级 (正向, 与 ifft_chain 严格对称)
%
%   freq_sym = fft_chain(time_sym, cfg)
%   将时域 OFDM 符号通过 FFT 转换为频域网格
%
%   FFT 输出顺序约定 (与 ifft_chain 的**输入**顺序同一约定):
%     [DC(位置1), 正子载波(+1..+N/2-1), Nyquist(位置N/2+1), 负子载波(-N/2+1..-1)]
%   即 MATLAB 自然 fft 输出顺序, 无需 fftshift/fftshift。下游 subcarrier
%   解映射按 bin = idx<0 ? N+idx : idx 取用 (见 rx_chain.m)。
%
%   缩放: fft(x)/sqrt(N), 与 ifft_chain 的 ifft(x)*sqrt(N) 互逆 —— 两者级联
%   为恒等 (Parseval 功率一致)。展开后两者都等于 sum(...)/8 (N=64):
%     ifft(x)*sqrt(N) = (1/N)*sum(X*U^{+nk})*sqrt(N) = sum(X*U^{+nk})/8
%     fft(x)/sqrt(N)  =        sum(x*U^{-nk})/sqrt(N) = sum(x*U^{-nk})/8
%   故定点实现两方向可共用同一套逐级移位调度, 只有旋转因子取共轭之别。
%   这是 fft64_sdf "单核双向" 的标定依据 (需求门禁 2026-08-03, D2)。
%
%   本函数把 rx_chain.m 里内联的 fft(...)/sqrt(N) 提取为独立契约锚, 使正向
%   与 ifft_chain 一样有可被 RTL 引用、可被测试单独覆盖的定义点。提取不改变
%   任何数值语义 —— rx_chain 的既有行为逐位不变 (见 tests/test_fft_chain.m)。
%
%   输入:
%     time_sym - 时域采样 [N x N_sym]
%     cfg      - 配置结构体 (含 cfg.N)
%   输出:
%     freq_sym - 频域网格 [N x N_sym], 自然 fft 输出顺序

    N = cfg.N;
    N_rows = size(time_sym, 1);
    if N_rows ~= N
        error('fft_chain:dimMismatch', ...
              'time_sym has %d rows but cfg.N = %d', N_rows, N);
    end

    N_sym = size(time_sym, 2);
    freq_sym = zeros(N, N_sym);

    for sym_idx = 1:N_sym
        % sqrt(N) 归一化保持 Parseval 功率一致性, 与 ifft_chain 互逆
        freq_sym(:, sym_idx) = fft(time_sym(:, sym_idx), N) / sqrt(N);
    end
end
