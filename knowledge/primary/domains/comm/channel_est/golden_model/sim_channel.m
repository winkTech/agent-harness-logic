function [H, Y, X, noise] = sim_channel(cfg)
% <信道估计> 生成 OFDM 信道仿真数据
% 输入:
%   cfg - 配置结构体
% 输出:
%   H     - 真实信道频域响应 [N×1]
%   Y     - 接收频域信号 [N×1]
%   X     - 发送频域符号 [N×1]
%   noise - 加性噪声 [N×1]

    N      = cfg.N;
    N_data = cfg.N_data;
    data_idx = cfg.data_idx;
    pilot_idx = cfg.pilot_idx;

    %% 1. 生成发送数据 (频域)
    X = zeros(N, 1);

    % 数据子载波: QAM 调制
    data = qammod(randi(cfg.M, N_data, 1)-1, cfg.M, 'gray', ...
        'UnitAveragePower', true);
    X(data_idx) = data;

    % 导频子载波: BPSK (±1)
    X(pilot_idx) = [1; 1; -1; 1];  % 802.11a 导频序列

    %% 2. 生成信道
    switch lower(cfg.channel_type)
        case 'awgn'
            H = ones(N, 1);
        case 'rayleigh'
            H = generate_rayleigh_channel(N, cfg);
        otherwise
            H = ones(N, 1);
    end

    %% 3. 通过信道
    Y_ch = H .* X;

    %% 4. 加性高斯白噪声
    snr_lin = 10^(cfg.snr_db / 10);
    sigma2 = mean(abs(Y_ch).^2) / snr_lin;
    noise = sqrt(sigma2/2) * (randn(N, 1) + 1j*randn(N, 1));
    Y = Y_ch + noise;

    %% 5. 量化 (可选)
    if isfield(cfg, 'quant')
        Y = quantize_signal(Y, cfg.quant);
    end
end

%% ===== 子函数 =====

function H = generate_rayleigh_channel(N, cfg)
    % 生成频率选择性 Rayleigh 信道
    delays = cfg.delay_profiles;
    gains_lin = 10.^(cfg.path_gains / 10);
    gains_lin = gains_lin / sum(gains_lin);  % 归一化

    % 频域响应: 对各径的频域贡献求和
    freq = (0:N-1)' / N * cfg.fs;  % 频率向量
    H = zeros(N, 1);

    for p = 1:length(delays)
        % 每径独立 Rayleigh 衰落
        coeff = sqrt(gains_lin(p)/2) * (randn + 1j*randn);
        H = H + coeff * exp(-1j * 2 * pi * freq * delays(p));
    end
end

function y_q = quantize_signal(y, q)
    % 定点量化
    scale = 2^q.Wf;
    max_val = 2^(q.Wt-1) - 1;
    y_q = round(real(y) * scale) / scale + ...
          1j * round(imag(y) * scale) / scale;
    y_q = min(max(real(y_q), -max_val/scale), max_val/scale) + ...
          1j * min(max(imag(y_q), -max_val/scale), max_val/scale);
end
