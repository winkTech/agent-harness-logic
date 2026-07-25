%% ===========================================================================
%  信道估计 — 参数配置 (基于 802.11a OFDM)
% ============================================================================

%% OFDM 系统参数
cfg.N         = 64;       % FFT 点数
cfg.N_cp      = 16;       % CP 长度
cfg.N_data    = 48;       % 数据子载波数
cfg.N_pilot   = 4;        % 导频子载波数
cfg.fs        = 20e6;     % 采样率 (Hz)
cfg.delta_f   = 312.5e3;  % 子载波间隔

%% 子载波分配 (802.11a)
cfg.data_idx  = [-26:-22, -20:-8, -6:-1, 1:6, 8:20, 22:26] + 33;
cfg.pilot_idx = [-21, -7, 7, 21] + 33;   % 1-based 索引
cfg.dc_idx    = 33;                       % DC 子载波 (索引 0)
% 保护子载波: 下保护带 [1:6] (subcarriers -32..-27), 上保护带 [60:64] (subcarriers 27..31)
% DC 在 33。修复 (2026-06-03): 原值 [1:5,28:32,34:38,61:64] 与数据子载波重叠
cfg.guard_idx = [1:6, 60:64];

%% 信道参数
cfg.channel_type = 'rayleigh';  % 'rayleigh' | 'awgn' | 'pedestrian'
cfg.delay_profiles = [0, 0.2, 0.5, 0.8] * 1e-6;  % 多径时延 (s)
cfg.path_gains     = [0, -3, -6, -10];             % 路径增益 (dB)
cfg.max_doppler    = 10;                           % 最大多普勒频移 (Hz)

%% 估计参数
cfg.est_method = 'ls_linear';  % 'ls_linear' | 'ls_dft' | 'mmse'
cfg.snr_db     = 20;           % 仿真 SNR (dB)

%% 量化参数 (阶段3后填入)
cfg.quant.Wi = 2;
cfg.quant.Wf = 14;
cfg.quant.Wt = 16;

%% 仿真控制
cfg.nsym    = 100;       % OFDM 符号数
cfg.mod     = '16qam';   % 调制方式
cfg.plot_en = true;
cfg.save_vectors = true;
