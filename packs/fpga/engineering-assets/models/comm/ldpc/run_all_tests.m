%% ===========================================================================
%  LDPC — 一键回归测试
% ============================================================================
clear; clc; close all;
addpath(fileparts(mfilename('fullpath')));
addpath(fullfile(pwd, 'src'));
addpath(fullfile(pwd, 'tests'));
config;

tests = {
    @test_encode_decode,  '编码译码一致性 — 无噪声'
    @test_ber_awgn,       'AWGN BER — 编码增益验证'
    @test_min_sum_vs_bp,  'Min-Sum vs BP — 性能差 < 1 dB'
    @test_convergence,    '收敛性 — 迭代次数分布'
    @test_multiple_blocks,'多码块 — 连续处理正确性'
};

total = length(tests); passed = 0; failed = 0;

fprintf('========================================\n');
fprintf('  LDPC 编解码 回归测试\n');
fprintf('  N=%d, K=%d, R=%.2f\n', cfg.N, cfg.K, cfg.R);
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
