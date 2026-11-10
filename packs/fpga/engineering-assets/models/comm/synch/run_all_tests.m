%% ===========================================================================
%  OFDM 同步 — 一键回归测试
% ============================================================================
clear; clc; close all;
addpath(fileparts(mfilename('fullpath')));

tests = {
    @test_packet_detect, '包检测 — 概率验证'
    @test_cfo_est,       'CFO 估计 — 精度验证'
    @test_timing,        '精定时 — 精度验证'
    @test_cfo_range,     'CFO 范围 — 粗精级联'
    @test_snr_robust,    'SNR 鲁棒性 — 低信噪比'
};

total = length(tests); passed = 0; failed = 0;

fprintf('========================================\n');
fprintf('  OFDM 同步 回归测试\n');
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
