function fr = sim_frame(cfg)
% <信道估计> 帧级激励: 2×LTS + nsym 数据符号, 同一信道实现 (ADR-002 配套)
% 与 sim_channel.m 的区别:
%   - 同一信道 H 贯穿整帧 (慢变假设), 每符号独立噪声
%   - 可选残余 CFO (cfg.residual_cfo_hz) 注入逐符号公共相位斜坡, 供相位跟踪验证
% 输入 cfg 字段: N, N_cp, fs, M, N_data, data_idx, pilot_idx, channel_type,
%   delay_profiles, path_gains, snr_db, nsym, residual_cfo_hz(可选, 默认 0)
% 输出 fr 结构体:
%   .H        真实信道频域响应 [N×1]
%   .Y_lts    接收 LTS [N×2]
%   .X_syms   发送数据符号 [N×nsym]
%   .Y_syms   接收数据符号 [N×nsym]
%   .cpe_true 注入的逐符号公共相位 [nsym×1] (rad)

    N = cfg.N;
    nsym = cfg.nsym;
    f_res = 0;
    if isfield(cfg, 'residual_cfo_hz'), f_res = cfg.residual_cfo_hz; end
    T_sym = (cfg.N + cfg.N_cp) / cfg.fs;

    %% 信道 (帧内不变)
    switch lower(cfg.channel_type)
        case 'awgn'
            H = ones(N, 1);
        case 'rayleigh'
            H = gen_rayleigh(N, cfg);
        otherwise
            H = ones(N, 1);
    end

    snr_lin = 10^(cfg.snr_db / 10);

    %% 2 × LTS (独立噪声)
    X_lts = lts_seq(N);
    Y_lts = zeros(N, 2);
    sigma2_lts = mean(abs(H .* X_lts).^2) / snr_lin;
    for k = 1:2
        n = sqrt(sigma2_lts/2) * (randn(N, 1) + 1j*randn(N, 1));
        Y_lts(:, k) = H .* X_lts + n;
    end

    %% 数据符号 (QAM 数据 + BPSK 导频, 残余 CFO 相位斜坡)
    X_syms = zeros(N, nsym);
    Y_syms = zeros(N, nsym);
    cpe_true = 2*pi*f_res*T_sym*(1:nsym)';
    for m = 1:nsym
        X = zeros(N, 1);
        X(cfg.data_idx) = qammod(randi(cfg.M, cfg.N_data, 1)-1, cfg.M, 'gray', ...
            'UnitAveragePower', true);
        % 802.11a 的 P 序列: (-21,-7,7,21) -> (+1,+1,+1,-1), **负号在 +21**。
        % 订正见 sim_channel.m 同处注释 (owner 2026-08-09 裁定)。
        %
        % **逐符号极性** (owner 2026-08-11 裁定, 方案 A): 与 models/comm/ofdm 的
        % subcarrier_map 同规则 —— 按符号序 ±1 交替, 首符号 +1。
        % 本包此前完全不建模极性, 而 TX 侧一直在翻 —— 两侧串起来时每隔一个符号
        % CPE 差 pi。这与"导频值放错位置"是**两个独立缺陷**, 订正导频值不能解决它;
        % integration/contracts/chain_pilot_contract.m 的隔离诊断实跑证实过。
        % 注: 标准用 127 长 PRBS 而非交替 (cbb/ofdm_tx_top 已登记为偏差 L3);
        %     方案 A 选择与 TX 现状一致, 不在本次顺带改标准合规性。
        pol = 1 - 2*mod(m-1, 2);
        X(cfg.pilot_idx) = pol * [1; 1; 1; -1];
        Y_ch = H .* X * exp(1j * cpe_true(m));
        sigma2 = mean(abs(Y_ch).^2) / snr_lin;
        n = sqrt(sigma2/2) * (randn(N, 1) + 1j*randn(N, 1));
        X_syms(:, m) = X;
        Y_syms(:, m) = Y_ch + n;
    end

    fr = struct('H', H, 'Y_lts', Y_lts, 'X_syms', X_syms, ...
                'Y_syms', Y_syms, 'cpe_true', cpe_true);
end

%% ===== 子函数 =====

function H = gen_rayleigh(N, cfg)
    % 频率选择性 Rayleigh 信道 —— 与 sim_channel.m/generate_rayleigh_channel 同构
    % (该函数是 sim_channel 的私有子函数, 此处复写以避免改动遗留接口)
    delays = cfg.delay_profiles;
    gains_lin = 10.^(cfg.path_gains / 10);
    gains_lin = gains_lin / sum(gains_lin);

    freq = (0:N-1)' / N * cfg.fs;
    H = zeros(N, 1);
    for p = 1:length(delays)
        coeff = sqrt(gains_lin(p)/2) * (randn + 1j*randn);
        H = H + coeff * exp(-1j * 2 * pi * freq * delays(p));
    end
end
