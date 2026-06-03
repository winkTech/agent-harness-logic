%% OFDM 黄金模型 一键回归测试
clear; clc; close all;
addpath('src');
addpath('tests');

tests = {
    @test_ber,          'BER测试(理想信道)'
    @test_modulations,  '多调制方式测试'
    @test_boundary,     '边界条件测试'
};

fprintf('========================================\n');
fprintf('  OFDM 黄金模型回归测试\n');
fprintf('========================================\n\n');

total = length(tests);
passed = 0;
failed = 0;

for i = 1:total
    func = tests{i,1};
    name = tests{i,2};
    try
        result = func();
        if result
            fprintf('  [PASS] %s\n\n', name);
            passed = passed + 1;
        else
            fprintf('  [FAIL] %s\n\n', name);
            failed = failed + 1;
        end
    catch ME
        fprintf('  [FAIL] %s — %s\n\n', name, ME.message);
        failed = failed + 1;
    end
end

fprintf('========================================\n');
fprintf('  完成: %d/%d PASS, %d FAIL\n', passed, total, failed);
fprintf('========================================\n');
