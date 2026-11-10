%% ===========================================================================
%  RRC 成形滤波器 — 参数配置
%  版本: 1.0
%  说明: 统一管理所有仿真参数，匹配 OFDM 系统
% ============================================================================

%% 系统参数
cfg.fs       = 4e6;       % 输出采样率 (Hz)
cfg.fclk     = 100e6;     % 时钟频率 (Hz)
cfg.fsym     = 1e6;       % 符号率 (Hz)

%% RRC 滤波器参数
cfg.alpha    = 0.5;       % 滚降系数
cfg.sps      = 4;         % 过采样倍数 (samples per symbol)
cfg.span     = 8;         % 滤波器跨度 (符号数)
cfg.ntaps    = cfg.sps * cfg.span + 1;  % 滤波器阶数 (33)

%% 调制参数
cfg.mod     = 'qpsk';    % 调制方式: 'qpsk' | '16qam' | '64qam'
cfg.nsym    = 1024;      % 仿真符号数

%% 量化参数 (阶段3后填入)
cfg.quant.Wi = 2;         % 整数位宽
cfg.quant.Wf = 14;        % 小数位宽
cfg.quant.Wt = 16;        % 总位宽
cfg.quant.Wc = 16;        % 系数位宽
cfg.quant.Wa = 38;        % 累加器位宽

%% 仿真控制
cfg.plot_en      = true;  % 是否绘图
cfg.verbose      = true;  % 是否打印详细信息
cfg.save_vectors = true;  % 是否导出测试向量

%% 测试场景
cfg.test_scenario = 'normal';  % 'normal' | 'boundary' | 'overflow'
