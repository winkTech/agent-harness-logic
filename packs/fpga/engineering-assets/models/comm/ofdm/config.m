%% ===========================================================================
%  OFDM 发射机 参数配置
%  参考标准: 802.11a
%  版本: 1.0
% ============================================================================

%% ---- FFT参数 ----
cfg.N = 64;                % FFT 点数
cfg.N_cp = 16;             % 循环前缀长度
cfg.N_sym = 10;            % 每帧OFDM符号数
cfg.N_frame = 1;           % 帧数

%% ---- 子载波分配 (802.11a, 64点FFT) ----
cfg.N_data = 48;           % 数据子载波
cfg.N_pilot = 4;           % 导频子载波
cfg.N_guard = 11;          % 保护带子载波 (左右)
cfg.N_dc = 1;              % DC子载波
                            % 合计: 48+4+11+1 = 64

% 数据子载波索引 (0-based, -26~-1, +1~+26, 跳过导频)
cfg.data_idx = setdiff([-26:-1 1:26], [-21, -7, 7, 21]);

% 导频子载波索引
cfg.pilot_idx = [-21, -7, 7, 21];

% 导频值 (每符号)
cfg.pilot_val = [1, 1, 1, -1]';

% DC 索引
cfg.dc_idx = 0;

% 保护带索引
cfg.guard_idx = [-32:-27 27:31];

%% ---- 调制参数 ----
cfg.mod_type = 'QPSK';     % BPSK | QPSK | 16QAM | 64QAM
cfg.mod_order = 2;         % bits/symbol: 1, 2, 4, 6

%% ---- 采样参数 ----
cfg.fs = 20e6;             % 采样率 20MHz
cfg.Tsym = (cfg.N + cfg.N_cp) / cfg.fs;  % OFDM符号周期: 4us

%% ---- 量化参数 (阶段3后填入) ----
cfg.quant.IFFT_in_Wi = 2;    % IFFT输入整数位宽
cfg.quant.IFFT_in_Wf = 14;   % IFFT输入小数位宽
cfg.quant.IFFT_out_Wi = 3;   % IFFT输出整数位宽
cfg.quant.IFFT_out_Wf = 13;  % IFFT输出小数位宽
cfg.quant.Wi = 2;             % 通用整数位宽
cfg.quant.Wf = 14;            % 通用小数位宽

%% ---- 仿真控制 ----
cfg.plot_en = true;
cfg.verbose = false;
cfg.save_vectors = true;
