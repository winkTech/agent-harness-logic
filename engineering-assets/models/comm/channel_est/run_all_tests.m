%% ===========================================================================
%  信道估计 — 一键回归测试
% ============================================================================
clear; clc; close all;
addpath(fileparts(mfilename('fullpath')));

tests = {
    @test_ls_linear,  'LS+线性插值 — MSE 验证'
    @test_ls_dft,     'LS+DFT 插值 — MSE 验证'
    @test_awgn,       'AWGN 信道 — 理想估计'
    @test_snr_range,  'SNR 变化 — MSE 曲线'
    @test_mod_order,  '调制阶数 — QPSK/16QAM/64QAM'
};

total = length(tests); passed = 0; failed = 0;

fprintf('========================================\n');
fprintf('  信道估计 回归测试\n');
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
