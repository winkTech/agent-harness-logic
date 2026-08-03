%% ===========================================================================
%  信道估计 — 一键回归测试 (ADR-002 修订: 长训练符号 LS 为默认估计基础)
% ============================================================================
clear; clc; close all;
addpath(fileparts(mfilename('fullpath')));
addpath(fullfile(fileparts(mfilename('fullpath')), 'tests'));

tests = {
    @test_lts_ls,      'LTS-LS — 多径验收信道 MSE (默认方案)'
    @test_phase_track, '导频相位跟踪 — CPE 精度与均衡增益'
    @test_awgn,        'AWGN 信道 — LTS-LS 理想估计'
    @test_snr_range,   'SNR 变化 — MSE 单调曲线'
    @test_mod_order,   '调制阶数 — QPSK/16QAM/64QAM'
    @test_ls_linear,   'LS+线性插值 — 有效域内验证 (备选)'
    @test_ls_dft,      'LS+DFT 插值 — 有效域内验证 (备选)'
};

total = length(tests); passed = 0; failed = 0;

fprintf('========================================\n');
fprintf('  信道估计 回归测试 (估计基础: ADR-002)\n');
fprintf('========================================\n\n');

for i = 1:total
    func = tests{i, 1}; name = tests{i, 2};
    fprintf('[%d/%d] %s ... ', i, total, name);
    try
        [result, detail] = func();
        if result
            fprintf('PASS (%s)\n', detail); passed = passed + 1;
        else
            fprintf('FAIL (%s)\n', detail); failed = failed + 1;
        end
    catch ME
        fprintf('FAIL — %s\n', ME.message); failed = failed + 1;
    end
end

fprintf('\n========================================\n');
fprintf('  %d/%d PASS, %d FAIL\n', passed, total, failed);
fprintf('========================================\n');
if failed > 0, error('测试未通过'); end
