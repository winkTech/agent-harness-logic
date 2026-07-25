%% ===========================================================================
%  OFDM 同步 — 参数配置 (基于 802.11a)
% ============================================================================

%% 系统参数
cfg.N         = 64;       % FFT 点数
cfg.N_cp      = 16;       % CP 长度
cfg.fs        = 20e6;     % 采样率 (Hz)
cfg.delta_f   = 312.5e3;  % 子载波间隔

%% 前导码参数 (802.11a)
cfg.N_short   = 16;       % 短前导码周期
cfg.N_repeat  = 10;       % 短前导码重复次数
cfg.N_gi2     = 32;       % 长前导码 GI 长度 (2x)
cfg.N_long    = 64;       % 长前导码长度 (T1/T2)
cfg.short_len = 160;      % 短前导码总长 (10x16)
cfg.long_len  = 160;      % 长前导码总长 (32+64+64)
cfg.preamble_len = 320;   % 前导码总长 (160+160)

%% 同步参数
cfg.eta_detect = 0.5;     % 包检测门限
cfg.L_corr     = 16;      % 自相关窗长
cfg.cfo_est_type = 'coarse_fine';  % 'coarse_only' | 'coarse_fine'

%% 信道参数 (仿真用)
cfg.snr_db    = 20;       % 信噪比 (dB)
cfg.tau       = 50;       % 定时偏移 (样点)
cfg.epsilon   = 0.3;      % 归一化 CFO (Δf 为单位)

%% 仿真控制
cfg.plot_en   = true;
cfg.runs      = 100;      % 蒙特卡洛次数
